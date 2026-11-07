const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { loadCli } = require('./cli-test-build.cjs');
const { spawnWindowsInputObserver } = loadCli('src/main/desktop/input-observer-process.ts');

test('observer factory never starts a Windows helper on macOS or when its component is missing', () => {
  const spawnProcess = () => assert.fail('No child may start');
  assert.throws(() => spawnWindowsInputObserver({ platform: 'darwin', spawnProcess }), { code: 'DESKTOP_PLATFORM_UNAVAILABLE' });
  assert.throws(() => spawnWindowsInputObserver({ platform: 'win32', executable: path.join(os.tmpdir(), randomBytes(16).toString('hex')), spawnProcess }), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
});

test('observer spawn uses a verified independent copy and preserves a damaged live-cache candidate', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-observer-spawn-test-'));
  const source = path.join(directory, 'fixture.exe'), bytes = randomBytes(128);
  fs.writeFileSync(source, bytes);
  const cacheDirectory = path.join(os.tmpdir(), 'profilepilot-input-observer-runtime');
  const cached = path.join(cacheDirectory, createHash('sha256').update(bytes).digest('hex') + '.exe');
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const corrupted = Buffer.from(bytes); corrupted[0] ^= 255;
  fs.writeFileSync(cached, corrupted, { flag: 'wx' });
  let spawned;
  t.after(() => {
    for (const file of [source, cached, spawned]) if (file && fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  const child = {};
  const result = spawnWindowsInputObserver({ platform: 'win32', executable: source,
    spawnProcess(file, args, options) {
      spawned = file;
      assert.notEqual(file, cached); assert.equal(path.dirname(file), cacheDirectory);
      assert.deepEqual(fs.readFileSync(file), bytes);
      assert.deepEqual(args, ['--stdio-observer']);
      assert.deepEqual(options, { windowsHide: true, stdio: 'pipe' });
      return child;
    }
  });
  assert.strictEqual(result, child);
  assert.deepEqual(fs.readFileSync(cached), corrupted);
});

test('observer production build validates cache bytes and preserves the last artifact on compiler failure', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const root = path.resolve(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-observer-build-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('pp-observer-build-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  for (const name of ['scripts', 'native']) fs.mkdirSync(path.join(directory, name));
  fs.copyFileSync(path.join(root, 'scripts/build-input-observer.mjs'), path.join(directory, 'scripts/build-input-observer.mjs'));
  const source = path.join(directory, 'native/input-observer-win.cs');
  fs.copyFileSync(path.join(root, 'native/input-observer-win.cs'), source);
  const build = () => JSON.parse(execFileSync(process.execPath, [path.join(directory, 'scripts/build-input-observer.mjs'), '--production'], { cwd: directory, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 10000 }));
  const first = build(), output = first.output, info = output + '.build.json';
  assert.equal(first.hookStarted, false); assert.equal(first.production, true);
  const hash = () => createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  assert.equal(first.outputSha256, hash());
  const old = new Date('2001-01-01T00:00:00Z'); fs.utimesSync(output, old, old);
  const mtime = fs.statSync(output).mtimeMs;
  build(); assert.equal(fs.statSync(output).mtimeMs, mtime);
  const corrupted = fs.readFileSync(output); corrupted[0] ^= 255; fs.writeFileSync(output, corrupted);
  const repaired = build(); assert.equal(repaired.buildId, first.buildId);
  assert.equal(repaired.outputSha256, hash()); assert.equal(fs.readFileSync(output).subarray(0, 2).toString(), 'MZ');
  const good = fs.readFileSync(output), goodInfo = fs.readFileSync(info);
  fs.appendFileSync(source, '\n#error Intentional isolated compiler failure\n');
  assert.throws(build); assert.deepEqual(fs.readFileSync(output), good); assert.deepEqual(fs.readFileSync(info), goodInfo);
  assert.deepEqual(fs.readdirSync(path.dirname(output)).sort(), ['ProfilePilot.InputObserver.exe', 'ProfilePilot.InputObserver.exe.build.json']);
});

test('observer build on macOS does not compile or resolve Windows metadata', () => {
  const entry = pathToFileURL(path.resolve(__dirname, '../scripts/build-input-observer.mjs')).href;
  const script = `Object.defineProperty(process, 'platform', { value: 'darwin' }); import(${JSON.stringify(entry)});`;
  const output = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
  assert.equal(output.hookStarted, false); assert.match(output.skipped, /macOS guard is unchanged/);
});
