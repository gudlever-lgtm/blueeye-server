'use strict';

const zlib = require('zlib');

// A PNG decoder, in about two hundred lines (V2 §8).
//
// Visual regression needs to compare PIXELS. Comparing the encoded bytes is
// useless — two encoders, or the same encoder on a different day, produce
// different bytes for an identical picture.
//
// Written rather than installed, on purpose. PNG is inflate plus five filter
// types, `zlib` is in the standard library, and the alternative is an image
// dependency (usually with native bindings) in a product whose whole pitch is
// that it runs on your own machine with nothing phoning home. The cost is that
// this must be exactly right, which is what the tests next door are for.
//
// It decodes what Playwright actually emits — 8-bit, non-interlaced — and
// REFUSES everything else by name rather than guessing. A decoder that quietly
// mis-reads a 16-bit image would produce a diff that looks real and is not, and
// that is far worse than a clear "cannot read this".

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Colour types, and how many channels each carries.
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };
const COLOR_NAME = { 0: 'greyscale', 2: 'RGB', 3: 'palette', 4: 'greyscale+alpha', 6: 'RGBA' };

// A ceiling on what will be decoded at all. A full-page screenshot of an
// infinite-scroll page can be tens of thousands of pixels tall, and decoding it
// would allocate hundreds of MB inside a worker that is also running a browser.
const MAX_PIXELS = 40_000_000; // ~8000 × 5000

class PngError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PngError';
  }
}

function readChunks(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new PngError(`truncated ${type} chunk`);
    chunks.push({ type, data: buffer.subarray(start, end) });
    offset = end + 4; // skip the CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

// Paeth, from the PNG specification. The one filter worth naming: it picks
// whichever neighbour predicts this byte best.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Undoes the per-scanline filter, in place, over the inflated data.
//
// Each scanline is one filter-type byte followed by the row. Filters reference
// the byte to the LEFT (bpp back in this row) and the byte ABOVE (same position,
// previous row), so this walks forward and can never look at data it has not
// already reconstructed.
function unfilter(raw, width, height, bytesPerPixel) {
  const rowBytes = width * bytesPerPixel;
  const out = Buffer.allocUnsafe(rowBytes * height);
  let rawAt = 0;
  let outAt = 0;

  for (let y = 0; y < height; y += 1) {
    if (rawAt >= raw.length) throw new PngError('image data ends before the last row');
    const filter = raw[rawAt];
    rawAt += 1;
    const rowStart = outAt;
    const prevStart = rowStart - rowBytes;

    for (let x = 0; x < rowBytes; x += 1) {
      const value = raw[rawAt + x];
      if (value === undefined) throw new PngError('image data ends mid-row');
      const left = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = (y > 0 && x >= bytesPerPixel) ? out[prevStart + x - bytesPerPixel] : 0;

      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paeth(left, up, upLeft); break;
        default: throw new PngError(`unknown row filter ${filter}`);
      }
      out[rowStart + x] = restored & 0xff;
    }
    rawAt += rowBytes;
    outAt += rowBytes;
  }
  return out;
}

// Expands whatever channels the file has into RGBA, so everything downstream
// works on one shape. Greyscale becomes three equal channels; a missing alpha
// becomes opaque.
function toRgba(rows, width, height, colorType) {
  const channels = CHANNELS[colorType];
  const out = Buffer.allocUnsafe(width * height * 4);
  for (let i = 0, px = 0; px < width * height; px += 1) {
    const at = px * channels;
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 0) { r = rows[at]; g = r; b = r; }
    else if (colorType === 4) { r = rows[at]; g = r; b = r; a = rows[at + 1]; }
    else if (colorType === 2) { r = rows[at]; g = rows[at + 1]; b = rows[at + 2]; }
    else { r = rows[at]; g = rows[at + 1]; b = rows[at + 2]; a = rows[at + 3]; }
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    i += 4;
  }
  return out;
}

// Decodes a PNG buffer into { width, height, data } where `data` is RGBA, four
// bytes per pixel, row-major.
//
// Throws PngError with a reason a person can act on. The caller treats any
// throw as "no comparison possible", which is reported as exactly that rather
// than as a passing or failing comparison.
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new PngError('not a buffer');
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('not a PNG (bad signature) — screenshots must be captured as PNG to be compared');
  }

  const chunks = readChunks(buffer);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) throw new PngError('missing IHDR');

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  if (!width || !height) throw new PngError('zero-sized image');
  if (width * height > MAX_PIXELS) {
    throw new PngError(`image too large to compare (${width}×${height})`);
  }
  // Refused by NAME rather than guessed at. A decoder that mis-reads one of
  // these would produce a difference that looks real and is not.
  if (bitDepth !== 8) throw new PngError(`unsupported bit depth ${bitDepth} (only 8-bit is compared)`);
  if (interlace !== 0) throw new PngError('interlaced PNGs are not compared');
  if (colorType === 3) throw new PngError('palette PNGs are not compared');
  if (!CHANNELS[colorType]) throw new PngError(`unsupported colour type ${colorType}`);

  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  if (!idat.length) throw new PngError('no image data');

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (e) {
    throw new PngError(`image data could not be decompressed: ${e.message}`);
  }

  const bytesPerPixel = CHANNELS[colorType];
  const expected = (width * bytesPerPixel + 1) * height;
  if (raw.length < expected) {
    throw new PngError(`image data is short (${raw.length} of ${expected} bytes)`);
  }

  const rows = unfilter(raw, width, height, bytesPerPixel);
  return {
    width,
    height,
    data: toRgba(rows, width, height, colorType),
    colorType,
    colorName: COLOR_NAME[colorType] || String(colorType),
  };
}

module.exports = { decodePng, PngError, MAX_PIXELS, SIGNATURE };
