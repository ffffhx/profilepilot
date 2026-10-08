import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = data => createHash('sha256').update(data).digest('hex');
export const extensionIdForKey = key => sha(Buffer.from(key, 'base64')).slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
export function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
export async function validateExtension(source = path.join(repo, 'extensions/profilepilot')) {
  const files = [];
  async function walk(relative = '') {
    for (const item of (await readdir(path.join(source, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.')) continue;
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw Error(`Symlinks are not publishable: ${name}`);
      if (item.isDirectory()) await walk(name);
      else if (/\.(?:json|js|html|css|png|svg|webp|jpg|woff2?|txt)$/.test(name)) files.push({ name, data: await readFile(path.join(source, name)) });
      else throw Error(`Unexpected extension asset: ${name}`);
    }
  }
  await walk();
  const manifest = JSON.parse(files.find(f => f.name === 'manifest.json')?.data.toString() || '{}');
  if (manifest.manifest_version !== 3 || !manifest.key || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(manifest.version || '') || manifest.version.split('.').some(v => +v > 65535) || !manifest.version.split('.').some(v => +v > 0)) throw Error('Invalid MV3 manifest, key or version');
  const names = new Set(files.map(f => f.name));
  const references = [manifest.background?.service_worker, manifest.action?.default_popup, manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}), ...Object.values(typeof manifest.action?.default_icon === 'object' ? manifest.action.default_icon : {}),
    ...(manifest.content_scripts || []).flatMap(s => [...s.js || [], ...s.css || []])].filter(Boolean);
  for (const file of files) {
    if (file.name.endsWith('.js')) {
      execFileSync(process.execPath, ['--input-type=module', '--check'], { windowsHide: true, stdio: 'pipe', input: file.data });
      for (const match of file.data.toString().matchAll(/\b(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) references.push(path.posix.normalize(path.posix.join(path.posix.dirname(file.name), match[1])));
    }
    if (file.name.endsWith('.html')) for (const match of file.data.toString().matchAll(/(?:src|href)=["']([^"'#]+)["']/g)) {
      if (!/^(?:https?:|data:)/.test(match[1])) references.push(path.posix.normalize(path.posix.join(path.posix.dirname(file.name), match[1])));
    }
  }
  for (const reference of references) if (!names.has(reference)) throw Error(`Missing asset (case-sensitive): ${reference}`);
  for (const size of [16, 32, 48, 128]) {
    const icon = files.find(f => f.name === manifest.icons?.[size]);
    if (!icon || icon.data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || icon.data.readUInt32BE(16) !== size || icon.data.readUInt32BE(20) !== size) throw Error(`Missing ${size}px PNG icon`);
  }
  return { files, manifest, extensionId: extensionIdForKey(manifest.key) };
}

// Deterministic ZIP, STORE entries, fixed timestamps, UTF-8 names; no shell/OS zip dependency.
export function extensionZip(files) {
  const entries = []; const central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name); const crc = crc32(file.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(file.data.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50, 0); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x800, 8); index.writeUInt16LE(33, 14);
    index.writeUInt32LE(crc, 16); index.writeUInt32LE(file.data.length, 20); index.writeUInt32LE(file.data.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    entries.push(local, name, file.data); central.push(index, name); offset += local.length + name.length + file.data.length;
  }
  const index = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, index, end]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const source = path.resolve(value('--source') || path.join(repo, 'extensions/profilepilot'));
  const { files, manifest, extensionId } = await validateExtension(source);
  const configuredId = /NATIVE_EXTENSION_ID\s*=\s*["']([a-p]{32})/.exec(await readFile(path.join(repo, 'src/main/tasks/native-bridge.ts'), 'utf8'))?.[1];
  if (configuredId !== extensionId) throw Error('Manifest key and bridge extension ID disagree');
  if (value('--store-id') && value('--store-id') !== extensionId) throw Error('Store ID differs: adopt the Developer Dashboard public key in manifest and update bridge ID together before publishing');
  const report = { version: manifest.version, extensionId, published: false, storeIdDeclared: value('--store-id') || null,
    permissions: manifest.permissions, hostPermissions: manifest.host_permissions,
    files: files.map(f => ({ name: f.name, bytes: f.data.length, sha256: sha(f.data) })) };
  if (args.includes('--check')) console.log(JSON.stringify(report, null, 2));
  else {
    const destination = path.resolve(value('--out') || path.join(repo, 'artifacts/native-extension-release'));
    if (destination === source || destination.startsWith(source + path.sep)) throw Error('Output must be outside the extension source');
    await mkdir(destination, { recursive: true });
    const zip = extensionZip(files); const filename = `profilepilot-extension-${manifest.version}.zip`;
    await writeFile(path.join(destination, filename), zip);
    await writeFile(path.join(destination, `${filename}.sha256`), `${sha(zip)}  ${filename}\n`);
    await writeFile(path.join(destination, 'validation.json'), JSON.stringify({ ...report, zip: filename, sha256: sha(zip) }, null, 2) + '\n');
    console.log(JSON.stringify({ directory: destination, zip: filename, sha256: sha(zip), extensionId, published: false }, null, 2));
  }
}
