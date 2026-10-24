import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(target));
    else if (/\.(?:c?js|json)$/.test(entry.name) && entry.name !== 'control-build.json') result.push(target);
  }
  return result;
}
const entries = {};
entries['public/phone-video/preview.dex'] = hash(await readFile(path.join(root, 'public/phone-video/preview.dex')));
for (const file of (await files(path.join(root, 'dist/main'))).sort()) {
  entries[path.relative(root, file).replaceAll('\\', '/')] = hash(await readFile(file));
}
const extension = JSON.parse(await readFile(path.join(root, 'extensions/profilepilot/manifest.json'), 'utf8'));
entries['dist/browser-runtime/profilepilot-browser-engine.cjs'] = hash(await readFile(path.join(root, 'dist/browser-runtime/profilepilot-browser-engine.cjs')));
for (const file of (await files(path.join(root, 'extensions/profilepilot'))).sort()) entries[path.relative(root, file).replaceAll('\\', '/')] = hash(await readFile(file));
const manifest = { version: 1, buildId: hash(JSON.stringify(entries)), builtAt: new Date().toISOString(),
  cliSha256: entries['dist/main/profilepilot-cli.cjs'], extensionVersion: extension.version, components: entries };
await writeFile(path.join(root, 'dist/main/control-build.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(root, 'dist/browser-runtime/control-build.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Control build ${manifest.buildId.slice(0, 16)} · extension ${manifest.extensionVersion}`);
