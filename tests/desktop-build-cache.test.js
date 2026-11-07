const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('desktop build cache verifies output bytes, migrates legacy metadata and preserves an artifact on compiler failure', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { WINRT_CONTRACTS } = await import('../scripts/windows-winrt-contracts.mjs');
  const cacheRelative = path.join('node_modules', '.cache', 'profilepilot', 'windows-winrt-contracts', WINRT_CONTRACTS.version);
  if (!WINRT_CONTRACTS.files.every(file => fs.existsSync(path.join(root, cacheRelative, file.name)))) {
    return t.skip('Build the Windows helper once to create its pinned metadata cache; this test never downloads dependencies');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desktop-build-cache-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('pp-desktop-build-cache-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  for (const relative of ['scripts', path.join('native', 'desktop'), cacheRelative]) fs.mkdirSync(path.join(directory, relative), { recursive: true });
  for (const name of ['build-desktop.mjs', 'desktop-source-files.mjs', 'windows-winrt-contracts.mjs']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
  const { desktopSourceFiles } = await import('../scripts/desktop-source-files.mjs');
  for (const name of desktopSourceFiles) {
    fs.copyFileSync(path.join(root, 'native', 'desktop', name), path.join(directory, 'native', 'desktop', name));
  }
  for (const file of WINRT_CONTRACTS.files) fs.copyFileSync(path.join(root, cacheRelative, file.name), path.join(directory, cacheRelative, file.name));
  // Exercise the production build script and compiler flags. Only csc runs;
  // the generated desktop executable is inspected as bytes and never started.
  const build = () => execFileSync(process.execPath, [path.join(directory, 'scripts', 'build-desktop.mjs')], { cwd: directory, windowsHide: true, stdio: 'pipe', timeout: 15000, encoding: 'utf8' });
  const executable = path.join(directory, 'dist', 'native', 'ProfilePilot.Desktop.exe');
  const inputIdentity = executable + '.sha256', outputIdentity = executable + '.output.sha256';
  const matchesOutput = () => assert.equal(fs.readFileSync(outputIdentity, 'utf8'), hash(fs.readFileSync(executable)));
  build(); matchesOutput();
  assert.match(fs.readFileSync(inputIdentity, 'utf8'), /^[a-f0-9]{64}$/);

  const marker = new Date('2001-01-01T00:00:00.000Z');
  fs.utimesSync(executable, marker, marker);
  const preservedTime = fs.statSync(executable).mtimeMs;
  build();
  assert.equal(fs.statSync(executable).mtimeMs, preservedTime, 'an intact cached output should not be rebuilt');

  fs.unlinkSync(outputIdentity);
  build(); matchesOutput();
  assert.notEqual(fs.statSync(executable).mtimeMs, preservedTime, 'a legacy input-only cache must be rebuilt');

  const inputBeforeCorruption = fs.readFileSync(inputIdentity, 'utf8');
  const corrupt = fs.readFileSync(executable); corrupt[0] ^= 0xff;
  fs.writeFileSync(executable, corrupt);
  build(); matchesOutput();
  assert.equal(fs.readFileSync(inputIdentity, 'utf8'), inputBeforeCorruption);
  assert.notDeepEqual(fs.readFileSync(executable), corrupt, 'same-length binary corruption was reused');
  assert.equal(fs.readFileSync(executable).subarray(0, 2).toString('ascii'), 'MZ');

  fs.writeFileSync(outputIdentity, '0'.repeat(64));
  build(); matchesOutput();
  assert.notEqual(fs.readFileSync(outputIdentity, 'utf8'), '0'.repeat(64));

  const source = path.join(directory, 'native', 'desktop', 'input-delivery.cs');
  const oldBuildId = fs.readFileSync(inputIdentity, 'utf8');
  fs.appendFileSync(source, '\n// Isolated cache invalidation fixture.\n');
  build(); matchesOutput();
  assert.notEqual(fs.readFileSync(inputIdentity, 'utf8'), oldBuildId, 'input-delivery changes must invalidate the helper');

  const good = fs.readFileSync(executable), goodInput = fs.readFileSync(inputIdentity), goodOutput = fs.readFileSync(outputIdentity);
  fs.appendFileSync(source, '\n#error Deliberate isolated build failure\n');
  assert.throws(build);
  assert.deepEqual(fs.readFileSync(executable), good, 'failed compilation replaced the last complete artifact');
  assert.deepEqual(fs.readFileSync(inputIdentity), goodInput);
  assert.deepEqual(fs.readFileSync(outputIdentity), goodOutput);
  assert.deepEqual(fs.readdirSync(path.dirname(executable)).sort(), ['ProfilePilot.Desktop.exe', 'ProfilePilot.Desktop.exe.output.sha256', 'ProfilePilot.Desktop.exe.sha256']);
});

test('the desktop build entry point skips Windows SDK resolution on macOS', () => {
  const entry = pathToFileURL(path.join(root, 'scripts', 'build-desktop.mjs')).href;
  const script = `Object.defineProperty(process, 'platform', { value: 'darwin' }); globalThis.fetch = () => { throw new Error('Unexpected SDK fetch'); }; import(${JSON.stringify(entry)});`;
  const output = execFileSync(process.execPath, ['-e', script], { cwd: root, windowsHide: true, timeout: 5000, encoding: 'utf8' });
  assert.match(output, /Windows helper is not required on this platform/);
});
