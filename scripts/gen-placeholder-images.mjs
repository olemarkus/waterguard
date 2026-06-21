// One-off generator for the solid-colour placeholder PNGs Homey requires for the
// app and each driver. Run with `node scripts/gen-placeholder-images.mjs`.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const COLOR = [21, 101, 192, 255]; // Waterguard blue, #1565C0

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 4] = COLOR[0];
    row[1 + x * 4 + 1] = COLOR[1];
    row[1 + x * 4 + 2] = COLOR[2];
    row[1 + x * 4 + 3] = COLOR[3];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(path, width, height) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png(width, height));
  console.log(`wrote ${path} (${width}x${height})`);
}

// App images.
write('assets/images/small.png', 250, 175);
write('assets/images/large.png', 500, 350);
write('assets/images/xlarge.png', 1000, 700);

// Driver images.
for (const driver of ['linkbox', 'watersensor']) {
  write(`drivers/${driver}/assets/images/small.png`, 75, 75);
  write(`drivers/${driver}/assets/images/large.png`, 500, 500);
  write(`drivers/${driver}/assets/images/xlarge.png`, 1000, 1000);
}
