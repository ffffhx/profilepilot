// Preserve the existing app artwork: extract its exact 32-bit ICO sizes as PNG.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { crc32 } from './package-native-extension.mjs';
const ico = await readFile(new URL('../build/icon.ico', import.meta.url));
const root = new URL('../extensions/profilepilot/icons/', import.meta.url);
await mkdir(root, { recursive: true });
function chunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(bytes));
  return Buffer.concat([length, bytes, crc]);
}
for (const size of [16, 32, 48, 128]) {
  let image;
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const offset = 6 + i * 16;
    if ((ico[offset] || 256) === size) image = ico.subarray(ico.readUInt32LE(offset + 12), ico.readUInt32LE(offset + 12) + ico.readUInt32LE(offset + 8));
  }
  if (!image || image.readUInt16LE(14) !== 32 || image.readUInt32LE(16) !== 0) throw Error('Expected uncompressed 32-bit application icon');
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const from = image.readUInt32LE(0) + ((size - y - 1) * size + x) * 4; const to = y * (size * 4 + 1) + 1 + x * 4;
    pixels[to] = image[from + 2]; pixels[to + 1] = image[from + 1]; pixels[to + 2] = image[from]; pixels[to + 3] = image[from + 3];
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  await writeFile(new URL(`icon-${size}.png`, root), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
}
console.log('Prepared 16/32/48/128px icons from existing ProfilePilot artwork');
