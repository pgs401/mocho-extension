#!/usr/bin/env node
// Generates PNG icons using only Node.js built-ins (no npm deps required).
const { deflateSync } = require('zlib');
const { writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// "M" glyph as a 7x5 bitmap (used for 16x16+)
const M_GLYPH = [
  [1,0,0,0,1],
  [1,1,0,1,1],
  [1,0,1,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
];

function createPNG(size, bgR, bgG, bgB, fgR, fgG, fgB) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc((1 + size * 3) * size, 0);

  const glyphH = M_GLYPH.length;
  const glyphW = M_GLYPH[0].length;
  const scale = Math.max(1, Math.floor(size / 10));
  const scaledGlyphH = glyphH * scale;
  const scaledGlyphW = glyphW * scale;
  const offY = Math.floor((size - scaledGlyphH) / 2);
  const offX = Math.floor((size - scaledGlyphW) / 2);

  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 3);
    raw[rowStart] = 0; // filter none

    // Draw rounded rect background with slight inset
    const inset = Math.max(1, Math.floor(size * 0.06));
    const radius = Math.max(2, Math.floor(size * 0.2));

    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 3;
      let r = bgR, g = bgG, b = bgB;

      // Check if in rounded rect
      const dx = Math.min(x - inset, size - inset - 1 - x);
      const dy = Math.min(y - inset, size - inset - 1 - y);
      let inRect = dx >= 0 && dy >= 0;
      if (inRect && dx < radius && dy < radius) {
        const cx = radius - 1 - dx;
        const cy = radius - 1 - dy;
        inRect = cx * cx + cy * cy <= radius * radius;
      }

      if (!inRect) {
        // transparent: use a neutral background (will show as corner)
        r = 245; g = 245; b = 245;
      } else {
        // Check if glyph pixel
        const gy = y - offY;
        const gx = x - offX;
        if (gy >= 0 && gy < scaledGlyphH && gx >= 0 && gx < scaledGlyphW) {
          const glyphRow = Math.floor(gy / scale);
          const glyphCol = Math.floor(gx / scale);
          if (M_GLYPH[glyphRow][glyphCol]) {
            r = fgR; g = fgG; b = fgB;
          }
        }
      }

      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const compressed = deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = join(__dirname, '..', 'icons');
mkdirSync(outDir, { recursive: true });

// MOCHO brand: indigo bg (#4F46E5), white glyph
const [bgR, bgG, bgB] = [79, 70, 229];
const [fgR, fgG, fgB] = [255, 255, 255];

for (const size of [16, 32, 48, 128]) {
  const png = createPNG(size, bgR, bgG, bgB, fgR, fgG, fgB);
  writeFileSync(join(outDir, `icon${size}.png`), png);
  console.log(`  icon${size}.png`);
}

console.log('Icons generated.');
