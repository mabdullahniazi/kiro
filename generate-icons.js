/**
 * Generates minimal placeholder PNG icons for TermsLens using pure Node.js.
 * No external dependencies required.
 * Run: node generate-icons.js
 */

const fs = require('fs');
const path = require('path');

// Minimal PNG encoder (pure JS, no deps)
// Creates a solid colored circle on dark background
function createPNG(size, filename) {
  // We'll create a raw RGBA bitmap and encode as PNG manually
  const width = size, height = size;
  const pixels = new Uint8Array(width * height * 4);

  const cx = width / 2, cy = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const r = size / 2 - 1;

      // Background: dark circle
      if (dist <= r) {
        // Dark blue background
        pixels[idx]     = 26;   // R
        pixels[idx + 1] = 36;   // G
        pixels[idx + 2] = 85;   // B
        pixels[idx + 3] = 255;  // A

        // Lens circle stroke
        const lensR = size * 0.28;
        const lensX = size * 0.38, lensY = size * 0.38;
        const ldx = x - lensX, ldy = y - lensY;
        const ldist = Math.sqrt(ldx * ldx + ldy * ldy);
        const strokeW = Math.max(1.5, size / 16);
        if (Math.abs(ldist - lensR) < strokeW) {
          pixels[idx]     = 79;   // R
          pixels[idx + 1] = 142;  // G
          pixels[idx + 2] = 247;  // B
          pixels[idx + 3] = 255;
        }

        // Handle line (diagonal)
        const angle = Math.PI * 0.75;
        const hx1 = lensX + Math.cos(angle) * lensR;
        const hy1 = lensY + Math.sin(angle) * lensR;
        const hx2 = lensX + Math.cos(angle) * (lensR + size * 0.22);
        const hy2 = lensY + Math.sin(angle) * (lensR + size * 0.22);

        // Point-to-segment distance
        const segDx = hx2 - hx1, segDy = hy2 - hy1;
        const segLen2 = segDx * segDx + segDy * segDy;
        let t = ((x - hx1) * segDx + (y - hy1) * segDy) / segLen2;
        t = Math.max(0, Math.min(1, t));
        const closestX = hx1 + t * segDx;
        const closestY = hy1 + t * segDy;
        const segDist = Math.sqrt((x - closestX) ** 2 + (y - closestY) ** 2);
        const handleW = Math.max(1.5, size / 12);
        if (segDist < handleW) {
          pixels[idx]     = 79;
          pixels[idx + 1] = 142;
          pixels[idx + 2] = 247;
          pixels[idx + 3] = 255;
        }
      }
      // Outside circle = transparent
    }
  }

  return encodePNG(width, height, pixels);
}

// ---- Minimal PNG encoder ----
function encodePNG(width, height, rgba) {
  const IHDR = chunk('IHDR', ihdrData(width, height));
  const IDAT = chunk('IDAT', idatData(width, height, rgba));
  const IEND = chunk('IEND', new Uint8Array(0));

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, IHDR, IDAT, IEND]);
}

function ihdrData(width, height) {
  const buf = new Uint8Array(13);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  buf[8] = 8;  // bit depth
  buf[9] = 2;  // color type: RGB (we'll handle alpha via type 6)
  // Use RGBA color type 6
  buf[9] = 6;
  buf[10] = 0; // compression
  buf[11] = 0; // filter
  buf[12] = 0; // interlace
  return buf;
}

function idatData(width, height, rgba) {
  // Build raw scanlines with filter byte 0 (None)
  const scanlines = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    scanlines[y * (1 + width * 4)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (1 + width * 4) + 1 + x * 4;
      scanlines[dst]     = rgba[src];
      scanlines[dst + 1] = rgba[src + 1];
      scanlines[dst + 2] = rgba[src + 2];
      scanlines[dst + 3] = rgba[src + 3];
    }
  }
  return zlibDeflate(scanlines);
}

function zlibDeflate(data) {
  // Minimal zlib: CMF + FLG + deflate (stored, no compression) + Adler32
  const CMF = 0x78, FLG = 0x01; // zlib header, no compression
  const maxBlock = 65535;
  const blocks = [];
  let offset = 0;

  while (offset < data.length) {
    const end = Math.min(offset + maxBlock, data.length);
    const blockData = data.slice(offset, end);
    const isLast = end === data.length ? 1 : 0;
    const len = blockData.length;

    const header = new Uint8Array([
      isLast,
      len & 0xff, (len >> 8) & 0xff,
      (~len) & 0xff, ((~len) >> 8) & 0xff,
    ]);
    blocks.push(header, blockData);
    offset = end;
  }

  const adler = adler32(data);
  const adlerBuf = new Uint8Array([
    (adler >> 24) & 0xff,
    (adler >> 16) & 0xff,
    (adler >> 8) & 0xff,
    adler & 0xff,
  ]);

  return Buffer.concat([
    new Uint8Array([CMF, FLG]),
    ...blocks,
    adlerBuf,
  ]);
}

function adler32(data) {
  let s1 = 1, s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return (s2 << 16) | s1;
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = crc32Table();
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

let _crcTable = null;
function crc32Table() {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _crcTable[i] = c;
  }
  return _crcTable;
}

function chunk(type, data) {
  const typeBytes = new Uint8Array(type.split('').map(c => c.charCodeAt(0)));
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setUint32(0, data.length);

  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = crc32(crcInput);
  const crcBuf = new Uint8Array(4);
  new DataView(crcBuf.buffer).setUint32(0, crc);

  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// ---- Main ----
const iconsDir = path.join(__dirname, 'extension', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = createPNG(size, `icon${size}.png`);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`✓ Generated ${outPath} (${png.length} bytes)`);
}

console.log('\nIcons generated successfully!');
