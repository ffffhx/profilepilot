const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readControlPreferences: read, writeControlPreferences: write } = require('../dist/main/control-preferences.js');
const { readBrowserPreferences } = require('../dist/main/browser-preferences.js');
const { agentSkillTargetPaths } = require('../dist/main/agent-skill-integration.js');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ppilot 控制偏好-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const targets = agentSkillTargetPaths('profilepilot', home);
  for (const target of targets) {
    fs.mkdirSync(path.join(target.path, 'local'), { recursive: true });
    fs.writeFileSync(path.join(target.path, 'SKILL.md'), '# ProfilePilot');
    fs.writeFileSync(path.join(target.path, 'local/browser-routing.md'), 'Existing browser policy');
  }
  return { home, files: targets.map(target => path.join(target.path, 'local/phone-control.md')) };
}
const save = (home, snapshot, content, syncAll = true) => write({ domain: snapshot.domain, content, expectedRevision: snapshot.revision, syncAll }, home);

test('Electron defaults are read-only until saved, independent of browser and phone, and clearing is preserved', async t => {
  const { home } = fixture(t);
  const browser = await read('browser', home), phone = await read('phone', home);
  const electron = await read('electron', home);
  assert.equal(electron.exists, false);
  assert.ok(electron.content.includes('ppilot browser'));
  for (const location of electron.locations) assert.equal(fs.existsSync(location.path), false);
  await assert.rejects(write({ domain: 'electron', content: 'Wrong tab', expectedRevision: browser.revision, syncAll: true }, home), /其他会话修改/);
  const saved = await save(home, electron, electron.content + '\n优先使用指定应用。');
  for (const location of saved.locations) {
    assert.equal(path.basename(location.path), 'electron-control.md');
    assert.equal(fs.readFileSync(location.path, 'utf8'), saved.content);
  }
  assert.deepEqual(await read('browser', home), browser);
  assert.deepEqual(await read('phone', home), phone);
  await save(home, saved, '');
  assert.equal((await read('electron', home)).content, '');
});

test('phone saves create UTF-8 files for clients and never modify the existing browser policy or revision', async t => {
  const { home, files } = fixture(t);
  const browser = await readBrowserPreferences(home);
  const phone = await read('phone', home);
  assert.equal(phone.exists, false);
  assert.equal(phone.content, '');
  const text = '# 手机控制偏好\r\n优先使用我指定的安卓设备；默认仅查看。\r\n';
  const saved = await save(home, phone, text);
  for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(await readBrowserPreferences(home), browser);
  const cleared = await save(home, saved, '');
  assert.equal(cleared.exists, true);
  assert.equal(cleared.content, '');
});

test('simultaneous browser and phone saves are independent, including conflict tokens', async t => {
  const { home } = fixture(t);
  const browser = await read('browser', home), phone = await read('phone', home);
  assert.notEqual(browser.revision, phone.revision);
  await assert.rejects(write({ domain: 'phone', content: 'Wrong tab', expectedRevision: browser.revision, syncAll: true }, home), /其他会话修改/);
  await Promise.all([save(home, browser, 'New browser'), save(home, phone, 'New phone')]);
  assert.equal((await read('browser', home)).content, 'New browser');
  assert.equal((await read('phone', home)).content, 'New phone');
});

test('phone file conflicts preserve existing contents and different client policies sync only on request', async t => {
  const { home, files } = fixture(t);
  fs.writeFileSync(files[0], 'Shared'); fs.writeFileSync(files[1], 'Codex');
  const first = await read('phone', home);
  assert.equal(first.differs, true);
  const saved = await save(home, first, 'Edited shared', false);
  assert.equal(fs.readFileSync(files[1], 'utf8'), 'Codex');
  fs.writeFileSync(files[1], 'External edit');
  await assert.rejects(save(home, saved, 'My draft'), /手机控制偏好已被其他会话修改/);
  assert.equal(fs.readFileSync(files[0], 'utf8'), 'Edited shared');
  const synced = await save(home, await read('phone', home), 'Synced');
  assert.equal(synced.differs, false);
  for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'Synced');
});

test('only supported preference domains can be read or written', async t => {
  const { home } = fixture(t);
  for (const domain of [undefined, null, '', '../browser-routing.md', '__proto__', 'toString']) {
    await assert.rejects(read(domain, home), /不支持的控制偏好类型/);
    await assert.rejects(write({ domain, content: 'x', expectedRevision: '', syncAll: true }, home), /不支持的控制偏好类型/);
  }
});
