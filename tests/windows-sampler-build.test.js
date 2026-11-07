const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sha = value => createHash('sha256').update(value).digest('hex');
function directory(t, prefix) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { assert.equal(path.dirname(path.resolve(target)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith(prefix)); fs.rmSync(target, { recursive: true, force: true }); });
  return target;
}
test('production sampler compiler verifies cached bytes and preserves last artifact on failed compilation', { skip: process.platform !== 'win32' }, async t => {
  const { buildWindowsSampler, samplerSources } = await import('../scripts/build-windows-sampler.mjs');
  const projectRoot = directory(t, 'pp-sampler-cache-');
  fs.mkdirSync(path.join(projectRoot, 'native/windows-sampler'), { recursive: true });
  for (const source of samplerSources) fs.copyFileSync(path.join(root, 'native/windows-sampler', source), path.join(projectRoot, 'native/windows-sampler', source));
  const run = () => buildWindowsSampler({ projectRoot });
  const first = await run(); assert.equal(first.helperStarted, false); assert.equal(first.cached, false);
  assert.equal((await run()).cached, true);
  const bytes = fs.readFileSync(first.executable); bytes[0] ^= 0xff; fs.writeFileSync(first.executable, bytes);
  const repaired = await run(); assert.equal(repaired.cached, false);
  assert.equal(repaired.sha256, sha(fs.readFileSync(first.executable))); assert.notEqual(repaired.sha256, sha(bytes));
  const metadata = JSON.parse(fs.readFileSync(first.executable + '.build.json'));
  assert.deepEqual(metadata.inputs.references.map(row => row.name), ['System.Management.dll', 'System.Web.Extensions.dll']);
  const good = fs.readFileSync(first.executable), goodMetadata = fs.readFileSync(first.executable + '.build.json');
  fs.appendFileSync(path.join(projectRoot, 'native/windows-sampler/model.cs'), '\n#error isolated compile failure\n');
  await assert.rejects(run());
  assert.deepEqual(fs.readFileSync(first.executable), good); assert.deepEqual(fs.readFileSync(first.executable + '.build.json'), goodMetadata);
  assert.deepEqual(fs.readdirSync(path.dirname(first.executable)).sort(), ['ProfilePilot.WindowsSampler.exe', 'ProfilePilot.WindowsSampler.exe.build.json']);
});
test('macOS sampler build skips before touching any Windows compiler or source path', async () => {
  const { buildWindowsSampler } = await import('../scripts/build-windows-sampler.mjs');
  assert.equal((await buildWindowsSampler({ projectRoot: 'path-that-does-not-exist', platform: 'darwin' })).skipped, true);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.ok(pkg.scripts.build.includes('npm run build:windows-sampler'));
  assert.equal(pkg.scripts['build:windows-sampler'], 'node scripts/build-windows-sampler.mjs --production');
  assert.ok(pkg.build.win.extraResources.some(row => row.from === 'dist/native/ProfilePilot.WindowsSampler.exe' && row.to === 'native/ProfilePilot.WindowsSampler.exe'));
  assert.equal(pkg.build.mac.extraResources.some(row => /WindowsSampler/.test(row.from)), false);
});
test('every desktop protocol resource and the Windows sampler bytes change the generated build identity', async t => {
  const { buildControlManifest, desktopProtocolResources } = await import('../scripts/build-control-manifest.mjs');
  const projectRoot = directory(t, 'pp-control-manifest-');
  const seed = ['public/phone-video/preview.dex', 'native/input-guard-win.ps1', 'dist/native/ProfilePilot.Desktop.exe',
    'dist/native/ProfilePilot.InputObserver.exe', 'dist/native/ProfilePilot.WindowsSampler.exe', 'dist/main/profilepilot-cli.cjs',
    'dist/browser-runtime/profilepilot-browser-engine.cjs', 'extensions/profilepilot/manifest.json', ...desktopProtocolResources];
  for (const entry of seed) { const file = path.join(projectRoot, entry); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.endsWith('manifest.json') ? '{"version":"test"}' : 'original fixture bytes'); }
  const first = await buildControlManifest(projectRoot, 'win32');
  assert.equal((await buildControlManifest(projectRoot, 'win32')).buildId, first.buildId, 'build timestamp and existing output do not feed back into identity');
  for (const entry of [...desktopProtocolResources, 'dist/native/ProfilePilot.WindowsSampler.exe']) {
    fs.appendFileSync(path.join(projectRoot, entry), ' changed');
    const next = await buildControlManifest(projectRoot, 'win32');
    assert.notEqual(next.buildId, first.buildId, entry); assert.notEqual(next.components[entry], first.components[entry]);
    fs.writeFileSync(path.join(projectRoot, entry), 'original fixture bytes');
  }
  const mac = await buildControlManifest(projectRoot, 'darwin');
  assert.equal(Object.hasOwn(mac.components, 'dist/native/ProfilePilot.WindowsSampler.exe'), false);
  for (const resource of desktopProtocolResources) assert.ok(mac.components[resource]);
});
