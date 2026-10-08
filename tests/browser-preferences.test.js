const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readBrowserPreferences, writeBrowserPreferences } = require('../dist/main/browser-preferences.js');
const { agentSkillTargetPaths } = require('../dist/main/agent-skill-integration.js');

function fixture(t, count = 3) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ppilot 偏好 test-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const targets = agentSkillTargetPaths('profilepilot', home).slice(0, count);
  for (const target of targets) {
    fs.mkdirSync(target.path, { recursive: true });
    fs.writeFileSync(path.join(target.path, 'SKILL.md'), '# ProfilePilot');
  }
  return { home, files: targets.map(target => path.join(target.path, 'local/browser-routing.md')) };
}
function put(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, 'utf8'); }
const save = (home, snapshot, content, syncAll = true) => writeBrowserPreferences({ content, expectedRevision: snapshot.revision, syncAll }, home);

test('first in-app save creates UTF-8 preferences for installed clients, including empty preferences', async t => {
  const { home, files } = fixture(t);
  const initial = await readBrowserPreferences(home);
  assert.equal(initial.exists, false);
  assert.equal(initial.content, '');
  const content = '# 个人浏览器偏好\r\n默认 Chrome，通过扩展连接。\r\n';
  const saved = await save(home, initial, content);
  assert.equal(saved.content, content);
  assert.equal(saved.exists, true);
  for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), content);
  const cleared = await save(home, saved, '');
  assert.equal(cleared.exists, true);
  assert.equal(cleared.content, '');
});

test('different client policies remain separate unless syncing is explicitly selected', async t => {
  const { home, files } = fixture(t);
  put(files[0], 'Shared'); put(files[1], 'Codex custom');
  const initial = await readBrowserPreferences(home);
  assert.equal(initial.differs, true);
  const saved = await save(home, initial, 'Shared edited', false);
  assert.equal(fs.readFileSync(files[1], 'utf8'), 'Codex custom');
  assert.equal(fs.existsSync(files[2]), false);
  const synced = await save(home, saved, 'Unified', true);
  assert.equal(synced.differs, false);
  for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'Unified');
});

test('existing secondary preference is used when shared preference has not been created', async t => {
  const { home, files } = fixture(t);
  put(files[1], 'Personal policy');
  const initial = await readBrowserPreferences(home);
  assert.equal(initial.path, files[1]);
  await save(home, initial, 'Edited policy', false);
  assert.equal(fs.existsSync(files[0]), false);
  assert.equal(fs.readFileSync(files[1], 'utf8'), 'Edited policy');
});

test('external changes and newly installed clients reject stale saves', async t => {
  const { home, files } = fixture(t);
  put(files[0], 'Original');
  const initial = await readBrowserPreferences(home);
  put(files[1], 'Changed in another session');
  await assert.rejects(save(home, initial, 'My draft'), /其他会话修改/);
  assert.equal(fs.readFileSync(files[0], 'utf8'), 'Original');
  assert.equal(fs.readFileSync(files[1], 'utf8'), 'Changed in another session');
});

test('concurrent saves with the same revision cannot silently overwrite each other', async t => {
  const { home } = fixture(t);
  const initial = await readBrowserPreferences(home);
  const results = await Promise.allSettled([save(home, initial, 'First'), save(home, initial, 'Second')]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal((await readBrowserPreferences(home)).content, 'First');
});

test('failed sync restores earlier files and cleans temporary writes', async t => {
  const { home, files } = fixture(t);
  for (const file of files) put(file, 'Original');
  const initial = await readBrowserPreferences(home);
  const rename = fs.promises.rename;
  const mock = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === files[1]) throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
    return rename(from, to);
  });
  await assert.rejects(save(home, initial, 'Edited'), /Access denied/);
  mock.mock.restore();
  for (const file of files) {
    assert.equal(fs.readFileSync(file, 'utf8'), 'Original');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['browser-routing.md']);
  }
});

test('shared Skill symlinks or Windows junctions are edited only once', async t => {
  const { home, files } = fixture(t, 1);
  const targets = agentSkillTargetPaths('profilepilot', home);
  fs.mkdirSync(path.dirname(targets[1].path), { recursive: true });
  fs.symlinkSync(targets[0].path, targets[1].path, process.platform === 'win32' ? 'junction' : 'dir');
  const initial = await readBrowserPreferences(home);
  assert.equal(initial.locations.length, 1);
  await save(home, initial, '中文 <script> is plain text');
  assert.equal(fs.readFileSync(files[0], 'utf8'), '中文 <script> is plain text');
});

test('missing installation and invalid requests return useful errors', async t => {
  const { home } = fixture(t, 0);
  await assert.rejects(readBrowserPreferences(home), /请先安装/);
  await assert.rejects(writeBrowserPreferences({ content: null }, home), /参数无效/);
  await assert.rejects(writeBrowserPreferences({ content: '中'.repeat(400000), expectedRevision: '', syncAll: true }, home), /1 MB/);
});
