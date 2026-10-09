const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLocalAppIconResolver, localAppIconCandidates, icnsPng } = require('../dist/main/local-apps/icons');

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-icons-'));
  t.after(async () => {
    assert.ok(path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return { id: 'app', name: 'My App', cwd, command: '', mode: 'launch' };
}

test('project icons prefer platform metadata and use a PNG companion for native formats', async t => {
  const config = await fixture(t);
  await fs.writeFile(path.join(config.cwd, 'package.json'), JSON.stringify({ build: { win: { icon: 'branding/windows.ico' }, mac: { icon: 'branding/mac.icns' } } }));
  const windows = await localAppIconCandidates(config, 'win32');
  const mac = await localAppIconCandidates(config, 'darwin');
  assert.deepEqual(windows.slice(0, 2), ['windows.png', 'windows.ico'].map(name => path.join(config.cwd, 'branding', name)));
  assert.deepEqual(mac.slice(0, 2), ['mac.png', 'mac.icns'].map(name => path.join(config.cwd, 'branding', name)));
});

test('native fallback recognizes quoted Windows executables and macOS bundles without borrowing runtime icons', async t => {
  const config = await fixture(t);
  const executable = path.join(config.cwd, 'My App.exe');
  const bundle = path.join(config.cwd, 'My App.app');
  assert.ok((await localAppIconCandidates({ ...config, command: `"${executable}" --inspect=9222` }, 'win32')).includes(executable));
  assert.ok((await localAppIconCandidates({ ...config, command: `"${bundle}/Contents/MacOS/My App"` }, 'darwin')).includes(bundle));
  const runtime = path.join(config.cwd, 'electron.exe');
  assert.ok(!(await localAppIconCandidates({ ...config, command: `"${runtime}" .` }, 'win32')).includes(runtime));
  await fs.writeFile(executable, 'fixture');
  assert.ok((await localAppIconCandidates(config, 'win32')).includes(executable));
  const namedIcon = path.join(config.cwd, 'my-app.ico');
  await fs.writeFile(namedIcon, 'fixture');
  assert.ok((await localAppIconCandidates(config, 'win32')).includes(namedIcon));
});

test('missing, oversized and broken icons fall through; cache is shared and configuration changes invalidate it', async t => {
  const config = await fixture(t);
  await fs.mkdir(path.join(config.cwd, 'build'));
  await fs.writeFile(path.join(config.cwd, 'build/icon.png'), 'broken');
  await fs.writeFile(path.join(config.cwd, 'build/icon.svg'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await fs.writeFile(path.join(config.cwd, 'logo.svg'), '<svg/>');
  const calls = [];
  const resolve = createLocalAppIconResolver(async file => {
    calls.push(file);
    if (file.endsWith('icon.png')) throw new Error('invalid image');
    return 'data:image/svg+xml;base64,fixture';
  });
  const [one, two] = await Promise.all([resolve(config), resolve(config)]);
  assert.equal(one, two);
  assert.match(one, /^data:image/);
  assert.equal(calls.length, 2);
  assert.ok(!calls.some(file => file.endsWith('icon.svg')));
  assert.equal(await resolve({ ...config, cwd: path.join(config.cwd, 'missing') }), undefined);
  await fs.writeFile(path.join(config.cwd, 'package.json'), '{broken');
  assert.match(await resolve({ ...config, name: 'Renamed' }), /^data:image/);
});

test('ICNS selects a PNG representation and rejects invalid chunk lengths', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const file = Buffer.alloc(16 + png.length);
  file.write('icns'); file.writeUInt32BE(file.length, 4); file.write('icp4', 8); file.writeUInt32BE(8 + png.length, 12); png.copy(file, 16);
  assert.deepEqual(icnsPng(file), png);
  file.writeUInt32BE(0, 12);
  assert.equal(icnsPng(file), undefined);
});
