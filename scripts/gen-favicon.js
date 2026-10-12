#!/usr/bin/env node
'use strict';
// Generates public/favicon.ico — 32×32 and 16×16 PNG-in-ICO images.
// Design: BlueEye "◉" motif — navy circle, blue outer ring, blue centre dot.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── CRC-32 ───────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── PNG chunk helper ──────────────────────────────────────────────────────────
function pngChunk(type, data) {
  const t   = Buffer.from(type, 'ascii');
  const d   = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.alloc(4);  len.writeUInt32BE(d.length, 0);
  const crc = Buffer.alloc(4);  crc.writeUInt32BE(crc32(Buffer.concat([t, d])), 0);
  return Buffer.concat([len, t, d, crc]);
}

// ── PNG encoder ───────────────────────────────────────────────────────────────
function makePNG(size, drawPixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // compression / filter / interlace = 0

  // Build raw scanlines: one filter byte (0 = None) + RGBA per pixel
  const stride = 1 + size * 4;
  const raw    = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawPixel(x, y, size);
      const off = y * stride + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }

  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon draw function ────────────────────────────────────────────────────────
// Palette (RGBA)
const NAVY = [15,  23,  42,  255]; // #0f172a — dark background
const BLUE = [56,  189, 248, 255]; // #38bdf8 — accent

function drawEye(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  const d  = Math.sqrt(dx * dx + dy * dy);
  const r  = size / 2;

  // Outside bounding circle → transparent
  if (d >= r) return [0, 0, 0, 0];

  // Soft outer edge (1-pixel anti-alias fade)
  const outerAlpha = Math.min(1, r - d);

  const ringOuter = r * 0.92; // outer edge of blue ring
  const ringInner = r * 0.64; // inner edge of blue ring
  const dotR      = r * 0.30; // centre dot radius

  let [cr, cg, cb, ca] = NAVY; // default: navy

  if (d <= dotR || (d >= ringInner && d <= ringOuter)) {
    [cr, cg, cb, ca] = BLUE;
  }

  return [cr, cg, cb, Math.round(ca * outerAlpha)];
}

// ── ICO container ─────────────────────────────────────────────────────────────
function buildICO(sizes) {
  const pngs  = sizes.map(s => makePNG(s, drawEye));
  const count = sizes.length;

  // 6-byte ICO header
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0,     0); // reserved
  header.writeUInt16LE(1,     2); // type = icon
  header.writeUInt16LE(count, 4);

  // 16-byte directory entries
  const dir    = Buffer.alloc(count * 16);
  let   offset = 6 + count * 16;
  sizes.forEach((sz, i) => {
    const b = i * 16;
    dir[b]     = sz >= 256 ? 0 : sz; // 0 means 256
    dir[b + 1] = sz >= 256 ? 0 : sz;
    dir[b + 2] = 0; dir[b + 3] = 0;  // colour count, reserved
    dir.writeUInt16LE(1,              b + 4);  // planes
    dir.writeUInt16LE(32,             b + 6);  // bpp
    dir.writeUInt32LE(pngs[i].length, b + 8);  // image size
    dir.writeUInt32LE(offset,          b + 12); // image offset
    offset += pngs[i].length;
  });

  return Buffer.concat([header, dir, ...pngs]);
}

// ── Write ─────────────────────────────────────────────────────────────────────
const outPath = path.join(__dirname, '..', 'public', 'favicon.ico');
fs.writeFileSync(outPath, buildICO([32, 16]));
console.log(`favicon.ico written → ${outPath}`);
