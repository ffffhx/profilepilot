import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import yaml from 'js-yaml';
import {createHash} from 'node:crypto';

export function releaseVersion(base, count, explicit = '') {
  if (explicit) {
    if (!/^\d+\.\d+\.\d+$/.test(explicit)) throw new Error('Invalid release version');
    return explicit;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (!match || !Number.isSafeInteger(count) || count < 1) throw new Error('Invalid release version inputs');
  return `${match[1]}.${match[2]}.${Number(match[3]) + count}`;
}
export function prepareAssets(source, output, notes = '') {
  fs.mkdirSync(output, {recursive: true});
  const manifests = new Map();
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!/\.(?:exe|zip|dmg|blockmap|yml)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.yml')) {
        const next = yaml.load(fs.readFileSync(file, 'utf8'));
        const old = manifests.get(entry.name);
        if (old && old.version !== next.version) throw new Error('Architecture versions differ');
        manifests.set(entry.name, old ? {...old, files: [...old.files, ...next.files]} : next);
      } else {
        const target = path.join(output, entry.name);
        if (fs.existsSync(target) && !fs.readFileSync(target).equals(fs.readFileSync(file))) throw new Error(`Conflicting artifact: ${entry.name}`);
        fs.copyFileSync(file, target);
      }
    }
  }
  visit(source);
  for (const [name, manifest] of manifests) {
    if (notes) manifest.releaseNotes = notes;
    for (const file of manifest.files) if (!fs.existsSync(path.join(output, file.url))) throw new Error(`Missing update package: ${file.url}`);
    fs.writeFileSync(path.join(output, name), yaml.dump(manifest));
  }
  if (!manifests.has('latest.yml') || !manifests.has('latest-mac.yml')) throw new Error('Both Windows and macOS update feeds are required');
  const version = manifests.get('latest.yml').version;
  if (manifests.get('latest-mac.yml').version !== version) throw new Error('Platform versions differ');
  const mac = ['arm64', 'x64'].map(arch => {
    const name = `ProfilePilot-mac-${arch}.dmg`, file = path.join(output, name);
    const bytes = fs.readFileSync(file);
    return {arch, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: `https://github.com/ffffhx/profilepilot/releases/download/v${version}/${name}`};
  });
  fs.writeFileSync(path.join(output, 'desktop-update.json'), JSON.stringify({version, notes, mac}, null, 2) + '\n');
}
function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'assets') return prepareAssets(first, second, execFileSync('git', ['log', '-12', '--format=- %s'], {encoding: 'utf8'}).trim());
  if (command !== 'version') throw new Error('Use version [version] or assets <input> <output>');
  const metadata = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const count = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], {encoding: 'utf8'}).trim());
  const requested = process.env.RELEASE_TAG || '';
  if (requested && requested !== 'latest' && !/^v\d+\.\d+\.\d+$/.test(requested)) throw new Error('Release tag must be latest or vX.Y.Z');
  const version = releaseVersion(metadata.version, count, first || (requested !== 'latest' ? requested.replace(/^v/, '') : '') || (/^refs\/tags\/v\d/.test(process.env.GITHUB_REF || '') ? process.env.GITHUB_REF.slice(11) : ''));
  metadata.version = version;
  fs.writeFileSync('package.json', JSON.stringify(metadata, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`);
  console.log(version);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
