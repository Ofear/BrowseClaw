#!/usr/bin/env node
// Generates PNG icons for BrowseClaw
// Run: node generate-icons.js

const fs = require('fs');
const path = require('path');
const { deflateSync } = require('zlib');

function createPNG(size) {
  const pixels = new Uint8Array(size * size * 4);

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.45;

  // Draw orange circle
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;

      if (dist <= r) {
        const t = dist / r;
        pixels[idx] = Math.round(255 - t * 26);     // R
        pixels[idx + 1] = Math.round(107 - t * 42);  // G
        pixels[idx + 2] = Math.round(53 - t * 11);   // B
        pixels[idx + 3] = 255;                        // A
      } else if (dist <= r + 1.2) {
        const alpha = Math.max(0, Math.round(255 * (1 - (dist - r) / 1.2)));
        pixels[idx] = 255;
        pixels[idx + 1] = 107;
        pixels[idx + 2] = 53;
        pixels[idx + 3] = alpha;
      }
    }
  }

  // Draw white claw pincers
  const thick = Math.max(1.5, size * 0.055);

  // Left pincer arc
  drawArc(pixels, size, cx - size * 0.15, cy - size * 0.02, size * 0.2, 0.6, 2.6, thick);
  // Right pincer arc
  drawArc(pixels, size, cx + size * 0.15, cy - size * 0.02, size * 0.2, 0.5, 2.5, thick);
  // Small connecting line at bottom
  drawLine(pixels, size, cx - size * 0.06, cy + size * 0.16, cx + size * 0.06, cy + size * 0.16, thick);

  return encodePNG(pixels, size);
}

function drawArc(pixels, size, cx, cy, radius, startA, endA, thickness) {
  const steps = Math.max(60, size * 3);
  for (let i = 0; i <= steps; i++) {
    const a = startA + (endA - startA) * (i / steps);
    const px = cx + Math.cos(a) * radius;
    const py = cy + Math.sin(a) * radius;
    drawDot(pixels, size, px, py, thickness);
  }
}

function drawLine(pixels, size, x1, y1, x2, y2, thickness) {
  const steps = Math.max(10, Math.ceil(Math.sqrt((x2-x1)**2 + (y2-y1)**2) * 2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    drawDot(pixels, size, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, thickness);
  }
}

function drawDot(pixels, size, px, py, radius) {
  const minX = Math.max(0, Math.floor(px - radius - 1));
  const maxX = Math.min(size - 1, Math.ceil(px + radius + 1));
  const minY = Math.max(0, Math.floor(py - radius - 1));
  const maxY = Math.min(size - 1, Math.ceil(py + radius + 1));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
      if (dist <= radius + 0.5) {
        const alpha = dist <= radius ? 255 : Math.round(255 * (1 - (dist - radius) / 0.5));
        const idx = (y * size + x) * 4;
        // Blend white on top
        const srcA = alpha / 255;
        const dstA = pixels[idx + 3] / 255;
        const outA = srcA + dstA * (1 - srcA);
        if (outA > 0) {
          pixels[idx] = Math.round((255 * srcA + pixels[idx] * dstA * (1 - srcA)) / outA);
          pixels[idx + 1] = Math.round((255 * srcA + pixels[idx + 1] * dstA * (1 - srcA)) / outA);
          pixels[idx + 2] = Math.round((255 * srcA + pixels[idx + 2] * dstA * (1 - srcA)) / outA);
          pixels[idx + 3] = Math.round(outA * 255);
        }
      }
    }
  }
}

function encodePNG(pixels, size) {
  const rawRows = [];
  for (let y = 0; y < size; y++) {
    rawRows.push(0); // filter: none
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      rawRows.push(pixels[idx], pixels[idx+1], pixels[idx+2], pixels[idx+3]);
    }
  }

  const compressed = deflateSync(Buffer.from(rawRows));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function makeChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Generate
const dir = path.join(__dirname, 'icons');
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

[16, 48, 128].forEach(s => {
  const png = createPNG(s);
  const p = path.join(dir, `icon${s}.png`);
  fs.writeFileSync(p, png);
  console.log(`${p} (${png.length} bytes)`);
});
console.log('Done!');
