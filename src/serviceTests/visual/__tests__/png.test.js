'use strict';

// The PNG decoder (V2 §8).
//
// Written rather than installed, so it has to be exactly right. A decoder that
// quietly mis-reads an image produces a difference that LOOKS real and is not —
// worse than a clear refusal, because somebody would go looking for a change
// that never happened.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const { decodePng, PngError } = require('../png');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  // The CRC is not verified by the decoder — a corrupt chunk fails at inflate,
  // which is the check that matters — so zeroes are fine here.
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

// Builds a PNG from unfiltered scanlines. `rows` is [[r,g,b,a,...], ...].
function makePng(rows, { colorType = 6, bitDepth = 8, interlace = 0, filter = 0 } = {}) {
  const height = rows.length;
  const width = rows[0].length / ({ 0: 1, 2: 3, 4: 2, 6: 4 }[colorType] || 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([filter]), Buffer.from(r)])));
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];

test('decodes an 8-bit RGBA image to RGBA, row-major', () => {
  const png = makePng([[...RED, ...GREEN], [...GREEN, ...RED]]);
  const img = decodePng(png);
  assert.equal(img.width, 2);
  assert.equal(img.height, 2);
  assert.equal(img.data.length, 2 * 2 * 4);
  assert.deepEqual([...img.data.subarray(0, 4)], RED);
  assert.deepEqual([...img.data.subarray(4, 8)], GREEN);
  assert.deepEqual([...img.data.subarray(8, 12)], GREEN);
});

test('RGB, greyscale and greyscale+alpha all come out as RGBA', () => {
  // Everything downstream works on one shape, so a missing alpha becomes opaque
  // and a single grey channel becomes three equal ones.
  const rgb = decodePng(makePng([[10, 20, 30]], { colorType: 2 }));
  assert.deepEqual([...rgb.data], [10, 20, 30, 255]);

  const grey = decodePng(makePng([[128]], { colorType: 0 }));
  assert.deepEqual([...grey.data], [128, 128, 128, 255]);

  const greyAlpha = decodePng(makePng([[128, 64]], { colorType: 4 }));
  assert.deepEqual([...greyAlpha.data], [128, 128, 128, 64]);
});

test('every row filter reconstructs the same picture', () => {
  // Sub, Up, Average and Paeth all reference already-reconstructed bytes. An
  // off-by-one in any of them produces a plausible-looking wrong image.
  const plain = decodePng(makePng([[...RED, ...GREEN], [...GREEN, ...RED]]));

  for (const filter of [1, 2, 3, 4]) {
    // Encode the same picture under this filter, by hand, then decode it back.
    const bpp = 4;
    const rows = [[...RED, ...GREEN], [...GREEN, ...RED]];
    const width = 2;
    const encoded = [];
    const prior = new Array(width * bpp).fill(0);
    let previous = prior;
    for (const row of rows) {
      const line = [];
      for (let x = 0; x < row.length; x += 1) {
        const left = x >= bpp ? row[x - bpp] : 0;
        const up = previous[x];
        const upLeft = x >= bpp ? previous[x - bpp] : 0;
        let value;
        if (filter === 1) value = row[x] - left;
        else if (filter === 2) value = row[x] - up;
        else if (filter === 3) value = row[x] - ((left + up) >> 1);
        else {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLeft);
          value = row[x] - pred;
        }
        line.push(value & 0xff);
      }
      encoded.push(line);
      previous = row;
    }
    const png = makePng(encoded, { filter });
    const img = decodePng(png);
    assert.deepEqual([...img.data], [...plain.data], `filter ${filter} did not round-trip`);
  }
});

test('what it cannot read, it refuses BY NAME rather than guessing', () => {
  // A wrong answer here is worse than no answer: it would send somebody looking
  // for a change that never happened.
  assert.throws(() => decodePng(makePng([[255, 0, 0, 255]], { bitDepth: 16 })), /bit depth 16/);
  assert.throws(() => decodePng(makePng([[255, 0, 0, 255]], { interlace: 1 })), /interlaced/);
  // Built by hand: a palette image has no fixed bytes-per-pixel, so makePng
  // cannot derive its width.
  const paletteIhdr = Buffer.alloc(13);
  paletteIhdr.writeUInt32BE(2, 0); paletteIhdr.writeUInt32BE(1, 4);
  paletteIhdr[8] = 8; paletteIhdr[9] = 3;
  const palette = Buffer.concat([
    SIG, chunk('IHDR', paletteIhdr),
    chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0])),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 1]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => decodePng(palette), /palette/);
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
  assert.throws(() => decodePng(null), /not a buffer/);
  assert.throws(() => decodePng(Buffer.concat([SIG])), /IHDR/);
});

test('a corrupt or truncated image fails rather than returning half a picture', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 6;
  // Claims 4×4 but carries one row of data.
  const short = Buffer.concat([
    SIG, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(17))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => decodePng(short), /short/);

  const garbage = Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', Buffer.from('nope')), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(garbage), /decompressed/);
});

test('an image too large to hold is refused before it is allocated', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(50000, 0); ihdr.writeUInt32BE(50000, 4); ihdr[8] = 8; ihdr[9] = 6;
  const huge = Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(4))), chunk('IEND', Buffer.alloc(0))]);
  // Refused on the header, so nothing has been allocated yet — a worker also
  // running a browser must not be taken out by one tall screenshot.
  assert.throws(() => decodePng(huge), /too large/);
});

test('every refusal is a PngError, so a caller can tell it from a bug', () => {
  try { decodePng(Buffer.from('x')); assert.fail('should have thrown'); }
  catch (e) { assert.ok(e instanceof PngError); }
});
