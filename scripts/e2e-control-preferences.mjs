import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

// Exercise the real renderer, preload and file writer in a disposable home.
const app = await launchProfilePilotE2e({ env: { CPM_START_VIEW: 'tools', PROFILEPILOT_TEST_WINDOWS_USER_PATH: '' } });
try {
  const d = app.driver;
  const edit = '[data-action="open-control-preferences"]';
  const textarea = '#control-preferences-editor';
  const save = '[data-action="save-control-preferences"]';
  const close = '.control-preferences-footer [data-action="close-modal"]';
  await d.waitFor('[data-action="install-profilepilot-cli"]', s => s.exists && !s.disabled);
  await d.domClick('[data-action="install-profilepilot-cli"]');
  await d.waitFor(edit, s => s.exists && !s.disabled, { timeoutMs: 20000 });
  await d.domClick(edit);
  await d.waitFor(textarea, s => s.exists && !s.disabled);
  const locations = await d.evaluate('window.profileManager.readControlPreferences("browser").then(snapshot => snapshot.locations)');
  assert.ok(locations.every(location => path.resolve(location.path).startsWith(path.resolve(app.homeDir) + path.sep)), 'Never test saves against real user preferences');
  assert.equal((await d.query(textarea)).value, '');
  const content = '# 个人浏览器偏好\n\n- 默认使用系统 Chrome，通过 ProfilePilot 扩展连接。\n- 切换账号前先询问我。\n\n<script>这是普通文字，不应执行。</script>\n';
  await d.domInput(textarea, content);
  await d.domClick(save);
  await d.waitFor('[data-control-preferences-state]', s => s.text === '已与本地内容同步');
  const files = ['.agents', '.codex', '.claude'].map(dir => path.join(app.homeDir, dir, 'skills/profilepilot/local/browser-routing.md'));
  for (const file of files) assert.equal(await readFile(file, 'utf8'), content);
  assert.equal((await d.query('.control-preferences-modal script')).count, 0);
  await d.domClick(close);
  await d.domClick(edit);
  await d.waitFor(textarea, s => s.value === content && !s.disabled);

  // Unsaved changes survive the close prompt and are discarded only explicitly.
  await d.domInput(textarea, content + '\n未保存的草稿');
  await d.domClick(close);
  await d.waitFor('[data-action="keep-control-preferences"]', s => s.exists);
  await d.domClick('[data-action="keep-control-preferences"]');
  assert.equal((await d.query(textarea)).value, content + '\n未保存的草稿');
  await d.domClick(close);
  await d.domClick('[data-action="discard-control-preferences"]');
  assert.equal((await d.query(textarea)).exists, false);
  assert.equal(await readFile(files[0], 'utf8'), content);

  // Detect an external edit without losing the user's local draft.
  await d.domClick(edit);
  await d.waitFor(textarea, s => s.exists && !s.disabled);
  const draft = content + '\n本次草稿';
  await d.domInput(textarea, draft);
  const external = content + '\n另一个会话的修改';
  await writeFile(files[0], external, 'utf8');
  await d.domClick(save);
  await d.waitFor('.control-preferences-error', s => s.text?.includes('其他会话修改'));
  assert.equal((await d.query(textarea)).value, draft);
  assert.equal(await readFile(files[0], 'utf8'), external);
  await d.domClick('[data-action="reload-control-preferences"]');
  await d.domClick('[data-action="discard-control-preferences"]');
  await d.waitFor(textarea, s => s.value === external && !s.disabled);
  assert.equal((await d.query('[data-control-preferences-sync]')).checked, false);
  assert.equal((await d.query('.control-preferences-note')).exists, true);

  // Ctrl+S and Command+S share the same in-app save action.
  const final = '# 个人浏览器偏好\n\n## 浏览器与账号\n\n- 优先使用系统默认 Chrome Profile。\n- 复用已登录的页面，不另建浏览器。\n\n## 连接方式\n\n- 通过 ProfilePilot 扩展与 ppilot browser 控制。\n- 切换账号前先询问我。\n';
  await d.domInput(textarea, final);
  await d.domInput('[data-control-preferences-sync]', '', { checked: true });
  await d.dispatch(textarea, 'keydown', { key: 's', ctrlKey: true, bubbles: true });
  await d.waitFor('[data-control-preferences-state]', s => s.text === '已与本地内容同步');
  for (const file of files) assert.equal(await readFile(file, 'utf8'), final);
  await d.domInput(textarea, final + '\n');
  await d.dispatch(textarea, 'keydown', { key: 's', metaKey: true, bubbles: true });
  await d.waitFor('[data-control-preferences-state]', s => s.text === '已与本地内容同步');
  assert.equal(await readFile(files[0], 'utf8'), final + '\n');
  const artifacts = path.join(repoRoot, 'artifacts/control-preferences-20261005');
  await mkdir(artifacts, { recursive: true });
  // Hidden Windows windows can retain the previous compositor frame until a
  // capture wakes painting; allow that frame to settle before recording it.
  await d.screenshot();
  await new Promise(resolve => setTimeout(resolve, 1200));
  await writeFile(path.join(artifacts, 'editor.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  const geometry = await d.evaluate(`(() => { const dialog = document.querySelector('.control-preferences-modal'); const rect = dialog.getBoundingClientRect(); return { bottom: rect.bottom, height: innerHeight, overflow: dialog.scrollWidth > dialog.clientWidth, unobscured: dialog.contains(document.elementFromPoint(rect.left + 4, rect.top + 50)) }; })()`);
  assert.ok(geometry.bottom <= geometry.height && !geometry.overflow && geometry.unobscured, JSON.stringify(geometry));
  // Independent drafts survive tab changes; saving one tab leaves the other untouched.
  const browserTab = '#control-preferences-tab-browser', phoneTab = '#control-preferences-tab-phone';
  const phoneFiles = files.map(file => file.replace('browser-routing.md', 'phone-control.md'));
  const browserDraft = final + '\n浏览器暂存内容';
  const phoneContent = '# 手机控制偏好\n\n- 优先使用我指定的安卓手机，多台设备时先确认。\n- 默认仅查看，点击或输入前先询问我。\n- 切换设备前先询问我。\n';
  await d.domInput(textarea, browserDraft);
  await d.domClick(phoneTab);
  await d.waitFor(textarea, s => s.exists && !s.disabled);
  assert.equal((await d.query(textarea)).value, '');
  const phoneLocations = await d.evaluate('window.profileManager.readControlPreferences("phone").then(snapshot => snapshot.locations)');
  assert.ok(phoneLocations.every(location => path.resolve(location.path).startsWith(path.resolve(app.homeDir) + path.sep)));
  await d.domInput(textarea, phoneContent);
  await d.domClick(browserTab);
  assert.equal((await d.query(textarea)).value, browserDraft);
  await d.domClick(phoneTab);
  assert.equal((await d.query(textarea)).value, phoneContent);
  await d.domClick(save);
  await d.waitFor('[data-control-preferences-state]', s => s.text === '已与本地内容同步');
  for (const file of phoneFiles) assert.equal(await readFile(file, 'utf8'), phoneContent);
  assert.equal(await readFile(files[0], 'utf8'), final + '\n');
  await d.domClick(close);
  assert.match((await d.query('.control-preferences-discard')).text, /浏览器/);
  await d.domClick('[data-action="keep-control-preferences"]');
  await d.domClick(browserTab);
  await d.domClick(save);
  await d.waitFor('[data-control-preferences-state]', s => s.text === '已与本地内容同步');
  assert.equal(await readFile(files[0], 'utf8'), browserDraft);

  // A phone conflict and reload must preserve the unrelated browser draft.
  await d.domInput(textarea, browserDraft + '\n另一个浏览器草稿');
  await d.domClick(phoneTab);
  await d.domInput(textarea, phoneContent + '\n手机草稿');
  await writeFile(phoneFiles[0], phoneContent + '\n外部修改', 'utf8');
  await d.domClick(save);
  await d.waitFor('.control-preferences-error', s => s.text?.includes('手机控制偏好已被其他会话修改'));
  assert.equal((await d.query(textarea)).value, phoneContent + '\n手机草稿');
  await d.domClick('[data-action="reload-control-preferences"]');
  assert.match((await d.query('.control-preferences-discard')).text, /手机/);
  await d.domClick('[data-action="discard-control-preferences"]');
  await d.waitFor(textarea, s => s.value === phoneContent + '\n外部修改' && !s.disabled);
  await d.domClick(browserTab);
  assert.equal((await d.query(textarea)).value, browserDraft + '\n另一个浏览器草稿');
  await d.domClick(close);
  await d.domClick('[data-action="discard-control-preferences"]');
  assert.equal(await readFile(files[0], 'utf8'), browserDraft);
  await d.domClick(edit);
  await d.waitFor(textarea, s => s.value === browserDraft && !s.disabled);
  await d.domClick(phoneTab);
  await d.waitFor(textarea, s => s.value === phoneContent + '\n外部修改' && !s.disabled);
  assert.equal((await d.query('[data-control-preferences-sync]')).checked, false);
  await d.domInput(textarea, phoneContent);
  await d.domInput('[data-control-preferences-sync]', '', { checked: true });
  await d.domClick(save);
  await d.waitFor('[data-control-preferences-state]', s => s.text === '已与本地内容同步');
  // All three tabs participate in keyboard navigation and preserve independent drafts.
  const electronTab = '#control-preferences-tab-electron';
  await d.dispatch(phoneTab, 'keydown', { key: 'ArrowLeft', bubbles: true });
  await d.waitFor(textarea, s => !s.disabled && s.value.includes('# Electron 控制偏好'));
  const electronContent = (await d.query(textarea)).value + '\n优先使用已登记的编辑器。';
  await d.domInput(textarea, electronContent);
  await d.dispatch(electronTab, 'keydown', { key: 'ArrowLeft', bubbles: true });
  assert.equal((await d.query(textarea)).value, browserDraft);
  await d.dispatch(browserTab, 'keydown', { key: 'ArrowRight', bubbles: true });
  assert.equal((await d.query(textarea)).value, electronContent);
  await d.domClick(save);
  await d.waitFor('[data-control-preferences-state]', s => s.text === '已与本地内容同步');
  const electronFiles = files.map(file => file.replace('browser-routing.md', 'electron-control.md'));
  for (const file of electronFiles) assert.equal(await readFile(file, 'utf8'), electronContent);
  await d.screenshot();
  await new Promise(resolve => setTimeout(resolve, 1200));
  await writeFile(path.join(artifacts, 'electron-editor.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  await d.dispatch(electronTab, 'keydown', { key: 'End', bubbles: true });
  assert.equal((await d.query(textarea)).value, phoneContent);
  await d.screenshot();
  await new Promise(resolve => setTimeout(resolve, 1200));
  await writeFile(path.join(artifacts, 'phone-editor.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  // Updating the unified CLI also updates the phone guide and retains both preferences.
  await d.domClick(close);
  await d.domClick('[data-action="install-profilepilot-cli"]');
  await d.waitFor(edit, s => s.exists && !s.disabled, { timeoutMs: 20000 });
  for (const file of files) assert.equal(await readFile(file, 'utf8'), browserDraft);
  for (const file of phoneFiles) assert.equal(await readFile(file, 'utf8'), phoneContent);
  for (const file of electronFiles) assert.equal(await readFile(file, 'utf8'), electronContent);
  console.log('PASS browser + Electron + phone tabs, independent drafts/saves, conflict recovery, keyboard navigation, client sync and CLI update preservation');
} finally { await app.stop(); }
