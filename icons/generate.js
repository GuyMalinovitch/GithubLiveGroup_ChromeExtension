// Run with: node icons/generate.js
// Zero npm dependencies — uses only Node.js built-in zlib and fs modules.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
  const table = Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of buf) crc = (table[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function makePNG(size, hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB, no alpha

  // Build raw scanlines: filter byte 0 + RGB per pixel
  // Draw a circle on a dark background
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(size * rowBytes);
  const radius = size / 2 - 1;
  const cx = size / 2;
  const cy = size / 2;
  for (let y = 0; y < size; y++) {
    const base = y * rowBytes;
    raw[base] = 0; // filter type None
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const inCircle = Math.sqrt(dx * dx + dy * dy) <= radius;
      raw[base + 1 + x * 3] = inCircle ? r : 13;
      raw[base + 2 + x * 3] = inCircle ? g : 17;
      raw[base + 3 + x * 3] = inCircle ? b : 23;
    }
  }

  const idat = deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) {
  const out = join(__dir, `icon${size}.png`);
  writeFileSync(out, makePNG(size, '#2ea043')); // GitHub green circle
  console.log(`✓ icon${size}.png`);
}
