const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const metadata = () => ({ applicationId: 'io.github.profilepilot.phone', variantName: 'release',
  minSdkVersionForDexing: 30, elements: [{ type: 'SINGLE', filters: [], versionCode: 8, versionName: '0.3.2' }] });
const apk = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3]);

test('Android update manifest uses APK version instead of desktop release tag, with matching bytes and digest', async () => {
  const { androidUpdateManifest } = await import('../scripts/prepare-android-update.mjs');
  for (const tag of ['latest', 'v0.1.0']) {
    const manifest = androidUpdateManifest(metadata(), apk, tag, '更新内容\n保留配对');
    assert.equal(manifest.versionCode, 8); assert.equal(manifest.versionName, '0.3.2');
    assert.equal(manifest.size, apk.length);
    assert.equal(manifest.sha256, createHash('sha256').update(apk).digest('hex'));
    assert.equal(manifest.url, `https://github.com/ffffhx/profilepilot/releases/download/${tag}/ProfilePilot-android.apk`);
    assert.equal(JSON.parse(JSON.stringify(manifest)).notes, '更新内容\n保留配对');
  }
});
test('Android update publication refuses debug, split, mismatched, invalid or incomplete inputs', async () => {
  const { androidUpdateManifest } = await import('../scripts/prepare-android-update.mjs');
  for (const change of [m => m.variantName = 'debug', m => m.applicationId = 'other.app',
    m => m.elements.push(m.elements[0]), m => m.elements[0].versionCode = 0,
    m => m.elements[0].filters = ['arm64'], m => m.minSdkVersionForDexing = undefined]) {
    const m = metadata(); change(m); assert.throws(() => androidUpdateManifest(m, apk, 'latest', 'notes'));
  }
  assert.throws(() => androidUpdateManifest(metadata(), apk, '../bad', 'notes'));
  assert.throws(() => androidUpdateManifest(metadata(), Buffer.from('invalid'), 'latest', 'notes'));
});
