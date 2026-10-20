import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { buildExtension, crc32, root } from "./build.mjs";
const output = await buildExtension();
async function files(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const list = [];
  for (const entry of entries) {
    if (entry.isDirectory()) list.push(...await files(path.join(directory, entry.name), prefix + entry.name + "/"));
    else list.push({ name: prefix + entry.name, path: path.join(directory, entry.name) });
  }
  return list;
}
const local = [], central = [];
let offset = 0;
for (const file of await files(output)) {
  const name = Buffer.from(file.name), data = await readFile(file.path), compressed = deflateRawSync(data), crc = crc32(data);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0x21, 12); // Valid DOS date: 1980-01-01, including Windows Explorer.
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10);
  record.writeUInt16LE(0x21, 14);
  record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
  local.push(header, name, compressed); central.push(record, name); offset += header.length + name.length + compressed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const destination = path.join(root, "bilingual-reader-0.1.0.zip");
await writeFile(destination, Buffer.concat([...local, directory, end]));
console.log(destination);
