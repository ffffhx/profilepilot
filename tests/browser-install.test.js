const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadCli } = require('./cli-test-build.cjs');
const { installedExtension } = loadCli('src/main/native-control/install.ts');
const { runBrowserCli } = loadCli('src/main/browser-cli.ts');

test('identify the durable Default installation separately from temporary, disabled and unrelated records', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ppilot-install-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const folder = path.join(profile, 'native-extension', 'current');
  const id = 'gmdaabnoocjlpimglalnbegfdaklfnaj';
  const local = { location: 4, path: folder, creation_flags: 38 };
  const record = setting => JSON.stringify({ extensions: { settings: { [id]: setting } } });
  assert.equal(await installedExtension(profile, folder), 'missing');
  await fs.writeFile(path.join(profile, 'Preferences'), record(local));
  assert.equal(await installedExtension(profile, folder), 'local');
  for (const [setting, expected] of [
    [{ ...local, creation_flags: 38 | (1 << 15) }, 'temporary'],
    [{ ...local, disable_reasons: [1] }, 'disabled'],
    [{ ...local, path: '/elsewhere' }, 'other'],
    [{ from_webstore: true }, 'store']
  ]) {
    await fs.writeFile(path.join(profile, 'Secure Preferences'), record(setting));
    assert.equal(await installedExtension(profile, folder), expected);
  }
});

test('extension install documents the fixed target and rejects attempts to select a different Profile', async () => {
  let out = '', err = '';
  const io = { stdout: { write: s => out += s }, stderr: { write: s => err += s } };
  assert.equal(await runBrowserCli(['install', '--help'], io), 0);
  assert.match(out, /ppilot browser install.*\n.*Default/);
  assert.equal(await runBrowserCli(['install', '--profile', 'native:Profile 3'], io), 64);
  assert.equal(JSON.parse(err).code, 'BROWSER_CLI_INVALID_ARGUMENTS');
});
