const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 table for PNG chunk checksums
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) {
      c = 0xedb88320 ^ (c >>> 1);
    } else {
      c = c >>> 1;
    }
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const toChecksum = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(toChecksum), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function generatePng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // 8-bit depth
  ihdrData.writeUInt8(6, 9); // RGBA
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // Generate pixels
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  const centerX = width / 2;
  const centerY = height / 2;
  const radius = width * 0.42;
  const playRadius = width * 0.18;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter: None

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Background: CineTrack dark #0b0d13 (11, 13, 19)
      let r = 11;
      let g = 13;
      let b = 19;
      let a = 255;

      // Outer circular badge: Red gradient #e50914 (229, 9, 20)
      if (dist <= radius) {
        // Red circle background with slight gradient
        const t = (y / height);
        r = Math.floor(229 - t * 40);
        g = 9;
        b = 20;

        // Inside the red circle, draw a film play triangle in white #ffffff
        // Triangle vertices: Left-top (cx - pR*0.5, cy - pR*0.7), Left-bottom (cx - pR*0.5, cy + pR*0.7), Right (cx + pR*0.7, cy)
        const tx1 = centerX - playRadius * 0.5;
        const ty1 = centerY - playRadius * 0.75;
        const tx2 = centerX - playRadius * 0.5;
        const ty2 = centerY + playRadius * 0.75;
        const tx3 = centerX + playRadius * 0.8;
        const ty3 = centerY;

        // Barycentric inside triangle check
        const dX = x - tx3;
        const dY = y - ty3;
        const dX21 = tx3 - tx2;
        const dY12 = ty2 - ty3;
        const D = dY12 * (tx1 - tx3) + dX21 * (ty1 - ty3);
        const s = (dY12 * dX + dX21 * dY) / D;
        const tCoord = ((ty3 - ty1) * dX + (tx1 - tx3) * dY) / D;
        const c = 1 - s - tCoord;

        if (s >= 0 && tCoord >= 0 && c >= 0) {
          // Play icon: crisp white
          r = 255;
          g = 255;
          b = 255;
        }
      }

      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressedData);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const publicDir = path.join(__dirname, '..', 'client', 'public');
const icon192 = generatePng(192, 192);
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), icon192);

const icon512 = generatePng(512, 512);
fs.writeFileSync(path.join(publicDir, 'icon-512.png'), icon512);

const appleIcon = generatePng(180, 180);
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), appleIcon);

console.log('✅ Generated valid PNG icons: icon-192.png, icon-512.png, apple-touch-icon.png');
