import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {releaseVersion, prepareAssets} from '../scripts/desktop-release.mjs';
test('release versions increase with commits and respect explicit version tags', () => {
  assert.equal(releaseVersion('0.1.0', 504), '0.1.504');
  assert.equal(releaseVersion('0.1.0', 505), '0.1.505');
  assert.equal(releaseVersion('0.1.900', 505), '0.1.1405');
  assert.equal(releaseVersion('0.1.0', 505, '1.0.0'), '1.0.0');
  assert.throws(() => releaseVersion('0.1.0', NaN));
});
test('release keeps both mac architectures instead of overwriting one update feed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-release-'));
  try {
    const source = path.join(root, 'input'), output = path.join(root, 'output');
    for (const [arch, feed] of [['arm64','latest-mac.yml'], ['x64','latest-mac.yml'], ['win','latest.yml']]) {
      const directory = path.join(source, arch); fs.mkdirSync(directory, {recursive: true});
      const file = `${arch}.zip`; fs.writeFileSync(path.join(directory, file), arch);
      if (arch !== 'win') fs.writeFileSync(path.join(directory, `ProfilePilot-mac-${arch}.dmg`), arch);
      fs.writeFileSync(path.join(directory, feed), `version: 0.1.8\nfiles:\n  - url: ${file}\n    sha512: fixture\n`);
    }
    prepareAssets(source, output);
    const text = fs.readFileSync(path.join(output, 'latest-mac.yml'), 'utf8');
    assert.match(text, /arm64.zip/); assert.match(text, /x64.zip/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
