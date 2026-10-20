import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type); const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8); return result;
}
function icon(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x / size, py = y / size;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const outer = px < .06 || px > .94 || py < .06 || py > .94;
      const leftPage = px > .23 && px < .46 && py > .26 && py < .72;
      const rightPage = px > .53 && px < .77 && py > .26 && py < .72;
      const line = (py > .38 && py < .43) || (py > .52 && py < .57);
      const color = (leftPage || rightPage) && !line ? [249, 245, 225] : [37, 100, 79];
      raw.set([...color, outer ? 0 : 255], i);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
export async function buildExtension() {
  const out = path.join(root, "dist");
  await mkdir(path.join(out, "icons"), { recursive: true });
  await cp(path.join(root, "public"), out, { recursive: true });
  await cp(path.join(root, "manifest.json"), path.join(out, "manifest.json"));
  await build({ entryPoints: ["background", "options", "popup", "demo"].map(name => path.join(root, "src", name + ".ts")), bundle: true, outdir: out, format: "esm", platform: "browser", target: "chrome138", sourcemap: false, minify: false, legalComments: "none" });
  await build({ entryPoints: [path.join(root, "src/content.ts")], bundle: true, outfile: path.join(out, "content.js"), format: "iife", platform: "browser", target: "chrome138", legalComments: "none" });
  for (const size of [16, 32, 48, 128]) await writeFile(path.join(out, "icons", `${size}.png`), icon(size));
  const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
  for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts.flatMap(s => s.js)]) await readFile(path.join(out, file));
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`Built extension: ${await buildExtension()}`);
