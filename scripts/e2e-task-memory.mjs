import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

const app = await launchProfilePilotE2e({ name: 'task memory' });
const output = path.join(repoRoot, 'test-results/browser-tasks');
await mkdir(output, { recursive: true });
try {
  const d = app.driver;
  const first = await d.evaluate(`window.profileManager.createProfile('记忆验收 A').then(s => s.profiles.find(p => p.name === '记忆验收 A'))`);
  const second = await d.evaluate(`window.profileManager.createProfile('记忆验收 B').then(s => s.profiles.find(p => p.name === '记忆验收 B'))`);
  const memory = id => d.evaluate(`window.tasks.getMemory(${JSON.stringify(id)})`);
  await d.domClick('.workspace-link[data-workspace="agent"]');
  await d.waitFor('#create-task');
  await d.domInput('select[name="profileId"]', first.id);
  await d.domClick('[data-nav="settings"]');
  await d.waitFor('[data-action="memory"]');
  await d.domClick('[data-action="memory"]');
  await d.waitFor('#memory-content');
  await d.domInput('#memory-profile', first.id);
  await d.waitFor('#memory-content');
  await d.domInput('#memory-content', '# 记忆索引\n- 回答优先使用简洁中文。');
  await d.domClick('[data-save]');
  await d.waitFor('[data-memory-status]', s => s.text.includes('记忆已保存'));
  assert.match((await memory(first.id)).files[0].content, /简洁中文/);
  await d.domInput('#memory-profile', second.id);
  await d.waitFor('[data-memory-content]', s => s.text.includes('尚无记忆'));
  assert.equal(await d.evaluate('document.querySelector("#memory-content").value'), '');
  await d.domInput('#memory-profile', first.id);
  await d.waitFor('[data-delete]', s => s.exists && !s.disabled);
  await d.domClick('[data-toggle]');
  await d.waitFor('[data-memory-status]', s => s.text.includes('已停用'));
  assert.equal((await memory(first.id)).enabled, false);
  assert.equal((await memory(second.id)).enabled, true);
  await d.domClick('[data-toggle]');
  await d.waitFor('[data-memory-status]', s => s.text.includes('已启用'));

  // A second window's edit must not be silently overwritten; preserve the draft.
  const previous = (await memory(first.id)).files[0];
  await d.evaluate(`window.tasks.writeMemory(${JSON.stringify(first.id)}, 'MEMORY.md', '# 另一窗口更新', ${JSON.stringify(previous.revision)})`);
  await d.domInput('#memory-content', '# 本窗口尚未保存');
  await d.domClick('[data-save]');
  await d.waitFor('[data-memory-status]', s => s.text.includes('刷新后再编辑'));
  assert.equal(await d.evaluate('document.querySelector("#memory-content").value'), '# 本窗口尚未保存');
  await d.domClick('[data-refresh]');
  await d.waitFor('.task-confirm');
  await d.domClick('.task-confirm button[value="cancel"]');
  assert.equal(await d.evaluate('document.querySelector("#memory-content").value'), '# 本窗口尚未保存');
  await d.domClick('[data-refresh]');
  await d.waitFor('.task-confirm');
  await d.domClick('[data-confirm-action]');
  await d.waitFor('[data-memory-status]', s => s.text.includes('已启用'));
  assert.equal(await d.evaluate('document.querySelector("#memory-content").value'), '# 另一窗口更新');

  // Topic deletion removes its index entry without erasing unrelated notes.
  const index = (await memory(first.id)).files[0];
  await d.evaluate(`window.tasks.writeMemory(${JSON.stringify(first.id)}, 'feedback.md', '回答优先使用简洁中文，避免表格。', null)`);
  await d.evaluate(`window.tasks.writeMemory(${JSON.stringify(first.id)}, 'MEMORY.md', ${JSON.stringify('# 记忆索引\n- [回答偏好](feedback.md)')}, ${JSON.stringify(index.revision)})`);
  await d.domClick('[data-refresh]');
  await d.waitFor('[data-memory-file="feedback.md"]');
  await d.domClick('[data-memory-file="feedback.md"]');
  assert.match(await d.evaluate('document.querySelector("#memory-content").value'), /避免表格/);
  await d.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const screenshot = await d.screenshot();
  await writeFile(path.join(output, 'memory-management.png'), Buffer.from(screenshot.pngBase64, 'base64'));
  await d.domClick('[data-delete]');
  await d.waitFor('.task-confirm');
  await d.domClick('[data-confirm-action]');
  await d.waitFor('[data-memory-file="feedback.md"]', s => !s.exists);
  const after = await memory(first.id);
  assert.equal(after.files.length, 1);
  assert.ok(!after.files[0].content.includes('feedback.md'));
  await d.domClick('[data-close]');
  await d.waitFor('.task-artifact-dialog', s => !s.exists);
  await writeFile(path.join(output, 'memory-ui-result.json'), JSON.stringify({ passed: true, editing: true, isolation: true, toggle: true, revisionConflict: true, draftPreserved: true, deleteTopic: true }, null, 2));
  console.log('PASS memory management UI: save, Profile isolation, toggle, conflicts, draft preservation and deletion');
} catch (error) {
  console.error(app.output());
  console.error(await app.driver.evaluate('document.body.innerText').catch(() => 'Renderer unavailable'));
  throw error;
} finally { await app.stop(); }
