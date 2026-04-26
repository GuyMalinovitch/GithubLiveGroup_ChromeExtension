// Run with: node icons/generate.js
// Zero npm dependencies — uses only Node.js built-in zlib and fs modules.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── PNG plumbing ───────────────────────────────────────────────────────────────

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

function encodePNG(size, rawRGB) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  // Prepend filter byte 0 (None) to each row
  const rows = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    rows[y * (1 + size * 3)] = 0;
    rawRGB.copy(rows, y * (1 + size * 3) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── Drawing primitives ────────────────────────────────────────────────────────

function Canvas(size) {
  const buf = Buffer.alloc(size * size * 3);
  return {
    buf,
    set(x, y, r, g, b) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      const i = (y * size + x) * 3;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    },
    fill(r, g, b) { for (let i = 0; i < buf.length; i += 3) { buf[i] = r; buf[i+1] = g; buf[i+2] = b; } },
    disc(cx, cy, radius, r, g, b) {
      const ri = Math.ceil(radius);
      for (let dy = -ri; dy <= ri; dy++)
        for (let dx = -ri; dx <= ri; dx++)
          if (dx*dx + dy*dy <= radius*radius) this.set(cx+dx, cy+dy, r, g, b);
    },
    ring(cx, cy, outerR, innerR, r, g, b) {
      const ri = Math.ceil(outerR);
      for (let dy = -ri; dy <= ri; dy++)
        for (let dx = -ri; dx <= ri; dx++) {
          const d2 = dx*dx + dy*dy;
          if (d2 <= outerR*outerR && d2 >= innerR*innerR) this.set(cx+dx, cy+dy, r, g, b);
        }
    },
    rect(x0, y0, x1, y1, r, g, b) {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) this.set(x, y, r, g, b);
    },
    roundedRect(x0, y0, x1, y1, rad, r, g, b) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = Math.max(x0 + rad - x, 0, x - (x1 - rad));
          const dy = Math.max(y0 + rad - y, 0, y - (y1 - rad));
          if (dx*dx + dy*dy <= rad*rad) this.set(x, y, r, g, b);
        }
      }
    },
    line(x0, y0, x1, y1, thickness, r, g, b) {
      // Bresenham + square cap
      const dx = Math.abs(x1-x0), dy = Math.abs(y1-y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx - dy, x = x0, y = y0;
      const t = Math.max(0, Math.floor(thickness / 2));
      for (;;) {
        this.rect(x-t, y-t, x+t, y+t, r, g, b);
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x += sx; }
        if (e2 < dx)  { err += dx; y += sy; }
      }
    },
    png() { return encodePNG(size, this.buf); },
  };
}

// ── Icon design: git PR symbol ────────────────────────────────────────────────
// Layout (at 128px):
//   • Left column: two filled circles (base commit top + branch commit bottom)
//     connected by a vertical line — the feature branch
//   • Top circle → horizontal arrow → open ring — the pull request direction
//
//      ●──────────────→  ○   (PR arrow, open target = "open PR")
//      │
//      ●                     (base branch)

function makeIcon(size) {
  const s = size / 128;
  const c = Canvas(size);

  // Background
  const BG  = [22, 27, 34];     // #161b22
  const GRN = [46, 160, 67];    // #2ea043  GitHub green
  c.fill(...BG);

  // Rounded card background (visible at larger sizes)
  if (size >= 32) {
    const pad = Math.round(4 * s);
    const rad = Math.round(18 * s);
    c.roundedRect(pad, pad, size - pad - 1, size - pad - 1, rad, ...BG);
  }

  const lx  = Math.round(36 * s);   // left column x
  const ty  = Math.round(36 * s);   // top circle y
  const by  = Math.round(92 * s);   // bottom circle y
  const rx  = Math.round(96 * s);   // right (target) circle x
  const cr  = Math.max(1, Math.round(9 * s));   // filled circle radius
  const or  = Math.max(1, Math.round(8 * s));   // open ring outer radius
  const ir  = Math.max(0, Math.round(5 * s));   // open ring inner radius
  const lt  = Math.max(1, Math.round(3 * s));   // line thickness

  // Vertical branch line
  c.line(lx, ty + cr, lx, by - cr, lt, ...GRN);

  // Horizontal PR arrow shaft
  const arrowTip = rx - or - Math.round(3 * s);
  c.line(lx + cr, ty, arrowTip - Math.round(6 * s), ty, lt, ...GRN);

  // Arrowhead (filled triangle pointing right)
  const ah = Math.max(1, Math.round(7 * s));
  for (let i = 0; i <= ah; i++) {
    const ax = arrowTip - ah + i;
    c.rect(ax, ty - i, ax, ty + i, ...GRN);
  }

  // Top filled circle (source / feature branch tip)
  c.disc(lx, ty, cr, ...GRN);

  // Bottom filled circle (base branch)
  c.disc(lx, by, cr, ...GRN);

  // Right open ring (open PR target)
  c.ring(rx, ty, or, ir, ...GRN);

  return c.png();
}

// ── Generate ──────────────────────────────────────────────────────────────────

for (const size of [16, 32, 48, 128]) {
  const out = join(__dir, `icon${size}.png`);
  writeFileSync(out, makeIcon(size));
  console.log(`✓ icon${size}.png`);
}
