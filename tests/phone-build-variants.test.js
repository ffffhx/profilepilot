const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { readCompanion, verifyCompanionApk } = loadCli('src/main/phones/companion.ts');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { PhoneCloud } = loadCli('src/main/phones/cloud.ts');

const releasePackage = 'io.github.profilepilot.phone';
const bytes = Buffer.from([0x50, 0x4b, 3, 4, 10, 11]);
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-variants-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function bundle(root, variant, apk = bytes) {
  const { phoneBuildMetadata } = await import('../scripts/phone-build-metadata.mjs');
  const apkPath = path.join(root, variant + '.apk');
  const metadata = phoneBuildMetadata({ applicationId: releasePackage + (variant === 'debug' ? '.debug' : ''), variantName: variant,
    elements: [{ filters: [], versionCode: 10, versionName: variant === 'debug' ? '0.3.4-dev' : '0.3.4' }] }, apk);
  fs.writeFileSync(apkPath, apk); fs.writeFileSync(apkPath + '.json', JSON.stringify(metadata));
  return apkPath;
}

test('build output selects separate packages, components and ports; legacy APKs remain release', async t => {
  const root = directory(t), debug = readCompanion(await bundle(root, 'debug')), release = readCompanion(await bundle(root, 'release'));
  assert.equal(debug.packageName, releasePackage + '.debug');
  assert.equal(debug.mainActivity, releasePackage + '.debug/' + releasePackage + '.MainActivity');
  assert.equal(debug.accessibilityService, releasePackage + '.debug/' + releasePackage + '.PhoneAccessibility');
  assert.equal(debug.port, 18763); assert.equal(release.port, 18761);
  assert.equal(release.packageName, releasePackage);
  assert.equal(readCompanion(path.join(root, 'legacy.apk')).packageName, releasePackage);
  const { phoneBuildMetadata } = await import('../scripts/phone-build-metadata.mjs');
  assert.throws(() => phoneBuildMetadata({ applicationId: releasePackage, variantName: 'debug', elements: [{ versionCode: 10, versionName: 'test' }] }, bytes));
});

test('development connect, repeated install and settings never use release package or pairing records', async t => {
  const root = directory(t), apkPath = await bundle(root, 'debug'), calls = [];
  const original = JSON.stringify({ 'TEST-PHONE': { token: 'a'.repeat(64), installedHash: 'b'.repeat(64), name: 'Release' } });
  fs.writeFileSync(path.join(root, 'devices.json'), original);
  const service = new PhonesService({ root, apkPath, adb: { run: async args => {
    calls.push(args);
    if (args[0] === 'devices') return 'TEST-PHONE device model:Test';
    if (args.includes('tcp:0')) return '28000';
    if (args[3]?.startsWith("'pm' 'path'")) return 'package:/data/app/debug/base.apk';
    if (args[3] === "'getprop' 'ro.serialno'") return 'TEST-PHONE';
    return '';
  } }, request: async () => ({ ok: true, state: { protocol: 1, instanceId: 'debug-instance', sessionId: null,
    generation: 0, phase: 'idle', mode: 'view', computer: 'Test', controller: '', task: '', startedAt: null,
    lastAction: '', permissions: { overlay: false, notifications: false, accessibility: false } } }) });
  t.after(() => service.close());
  await service.refresh();
  assert.equal(calls.filter(c => c.includes('tcp:0')).length, 0, 'Never uses the release pairing to connect debug');
  await service.prepare('TEST-PHONE');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'development', 'devices.json')));
  assert.notEqual(saved['TEST-PHONE'].token, 'a'.repeat(64));
  assert.equal(fs.readFileSync(path.join(root, 'devices.json'), 'utf8'), original);
  assert.ok(calls.some(c => c.includes('tcp:18763')));
  assert.ok(calls.some(c => c[3]?.includes("'io.github.profilepilot.phone.debug/io.github.profilepilot.phone.MainActivity'")));
  assert.ok(calls.filter(c => c[3]?.startsWith("'pm' 'path'")).every(c => c[3].endsWith("'io.github.profilepilot.phone.debug'")));
  assert.equal(service.snapshot().companionApp.variant, 'debug');
  await service.prepare('TEST-PHONE');
  assert.equal(calls.filter(c => c[2] === 'install').length, 1, 'Unchanged build is reused');
  await bundle(root, 'debug', Buffer.concat([bytes, Buffer.from([12])]));
  await service.prepare('TEST-PHONE');
  assert.equal(calls.filter(c => c[2] === 'install').length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'development', 'devices.json')))['TEST-PHONE'].token, saved['TEST-PHONE'].token);
  await service.openSettings('TEST-PHONE', 'overlay');
  assert.ok(calls.some(c => c[3]?.includes("'package:io.github.profilepilot.phone.debug'")));
  assert.ok(calls.every(c => !c.includes('uninstall') && !c.includes('-d')));
  assert.equal(fs.readFileSync(path.join(root, 'devices.json'), 'utf8'), original);
});

test('corrupt APK metadata and changing build variant require repair before installation', async t => {
  const root = directory(t), apkPath = await bundle(root, 'debug');
  assert.equal(verifyCompanionApk(apkPath, bytes, releasePackage + '.debug'), readCompanion(apkPath).sha256);
  assert.throws(() => verifyCompanionApk(apkPath, Buffer.concat([bytes, bytes]), releasePackage + '.debug'), /校验失败/);
  assert.throws(() => verifyCompanionApk(apkPath, bytes, releasePackage), /重启/);
  const metadata = JSON.parse(fs.readFileSync(apkPath + '.json')); metadata.applicationId = releasePackage;
  fs.writeFileSync(apkPath + '.json', JSON.stringify(metadata));
  assert.throws(() => readCompanion(apkPath), /不匹配/);
});

test('development and release QR links address only their own app', async t => {
  const root = directory(t);
  const request = async (_url, options) => new Response(JSON.stringify(JSON.parse(options.body).pairToken
    ? { expires: Date.now() + 60000 } : { paired: false }));
  for (const scheme of ['profilepilot', 'profilepilot-dev']) {
    const location = path.join(root, scheme); fs.mkdirSync(location);
    const cloud = new PhoneCloud(location, () => {}, request, Date.now, scheme);
    t.after(() => cloud.close());
    const result = await cloud.pair();
    assert.equal(new URL(result.uri).protocol, scheme + ':');
  }
});
