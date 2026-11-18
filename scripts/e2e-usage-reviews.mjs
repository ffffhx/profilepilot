import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot, delay } from './e2e/lib/electron-driver.mjs';

let calls = 0, fail = false;
const server = http.createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk;
  if (fail) { response.writeHead(503); response.end(); return; }
  const body = JSON.parse(text), input = JSON.parse(body.messages[0].content);
  assert.equal(body.tools, undefined);
  assert.equal(input.evidence.some(row => row.source === 'codex'), true);
  calls++;
  await delay(500); // Leave time to verify the disabled mutation controls.
  const evidenceIds = input.evidence.slice(0, 2).map(row => row.id);
  const findings = [{ key: 'browser.connection-diagnostics', kind: 'tool', title: '连接失败时给出下一步检查入口', observation: '测试记录中出现连接失败，检查连接后成功。根因尚未确认。', suggestion: '在错误信息中指向连接检查入口。', verification: '观察后续任务是否减少无效重试。', evidenceIds, confidence: 'medium' },
    { key: 'workflow.connection-check', kind: 'workflow', title: '操作前检查目标与连接', observation: '一段测试对话展示了检查、连接和核实的顺序。', suggestion: '保留为候选，下一次同类任务再验证。', verification: '确认目标正确，成功读取状态。', evidenceIds, confidence: 'medium', workflow: { when: '连接工具并开始读取之前', inputs: ['目标名称'], steps: ['核对目标', '检查连接', '读取并核实状态'], exceptions: ['用户接管时等待交还'], done: '成功读取目标状态' } }];
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: '隔离测试数据：发现一项工具建议和一个待验证的工作流。', findings }) }], usage: { input_tokens: 100, output_tokens: 200 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const output = path.join(repoRoot, 'test-results', 'usage-review-ui');
await mkdir(output, { recursive: true });
let app, stage = 'launch';
try {
  app = await launchProfilePilotE2e({ mode: 'background', experimentalAgent: false, readySelector: '#usage-reviews', env: { CPM_START_VIEW: 'settings', CLAUDE_CONFIG_DIR: '' }, prepareFixture: async ({ homeDir }) => {
    const directory = path.join(homeDir, '.codex', 'sessions'); await mkdir(directory, { recursive: true });
    const timestamp = new Date(Date.now() - 60000).toISOString();
    const rows = ['请先检查目标与连接，再读取状态。', '连接失败后检查了扩展，已连接并成功读取目标状态。'].map((text, i) => ({ timestamp, type: 'response_item', payload: { type: 'message', role: i ? 'assistant' : 'user', channel: 'final', content: [{ type: 'output_text', text }] } }));
    await writeFile(path.join(directory, 'rollout-fixture.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  } });
  await writeFile(path.join(output, 'instance.json'), JSON.stringify({ purpose: 'usage review background acceptance fixture', pid: app.child.pid, dataDir: app.dataDir, homeDir: app.homeDir }, null, 2));
  const d = app.driver;
  stage = 'model-and-settings';
  await d.evaluate(`window.tasks.saveSettings({baseUrl:'http://127.0.0.1:${port}',model:'fixture-model',apiKey:'fixture-secret',notifications:false})`, { target: 'shell' });
  await d.domClick('.workspace-settings', { target: 'shell' });
  await d.waitFor('#review-enabled', state => state.attributes['aria-checked'] === 'false' && !state.disabled);
  assert.equal(await d.evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  await d.domClick('.review-options summary');
  await d.domInput('[name="time"]', '20:45');
  await d.domInput('[name="timezone"]', 'Asia/Shanghai');
  await d.domClick('#review-settings-form button');
  await d.waitFor('#review-notice', state => state.text.includes('已保存'));
  assert.equal(await d.evaluate('window.tasks.reviewSnapshot().then(s => s.settings.time)'), '20:45');
  await d.domClick('[data-review-run="daily"]');
  stage = 'first-report';
  await d.waitFor('.review-finding', state => state.exists, { timeoutMs: 15000 });
  assert.equal(calls, 1);
  await d.domInput('[data-feedback-note]', '测试反馈：已有处理方案');
  await d.domInput('[data-feedback-note]', '另一个尚未保存的备注', { index: 1 });
  await d.evaluate(`document.querySelectorAll('.review-finding details').forEach(item => item.open = true); document.querySelector('[data-feedback-note]').focus(); true`);
  stage = 'feedback';
  await d.domClick('[data-review-feedback="dismissed"]');
  await d.waitFor('#review-notice', state => state.text.includes('反馈已保存'));
  assert.equal(await d.evaluate('window.tasks.reviewSnapshot().then(s => s.feedback[0].value)'), 'dismissed');
  assert.equal(await d.evaluate('document.querySelectorAll("[data-feedback-note]")[1].value'), '另一个尚未保存的备注');
  assert.equal(await d.evaluate('document.querySelector(".review-finding details").open'), true);
  assert.equal(await d.evaluate('document.activeElement.hasAttribute("data-feedback-note")'), true);
  await d.evaluate(`document.querySelectorAll('.review-finding details').forEach(item => item.open = true); true`);
  await d.domClick('[data-review-export]');
  await d.waitFor('#review-notice', state => state.text.includes('草稿已保存'));
  const snapshot = await d.evaluate('window.tasks.reviewSnapshot()');
  stage = 'workflow-export';
  const report = await d.evaluate(`window.tasks.reviewReport('${snapshot.reports[0].id}')`);
  const workflow = report.findings.find(row => row.kind === 'workflow');
  const draft = path.join(app.dataDir, 'browser-tasks', 'usage-reviews', 'drafts', `${report.id}-${workflow.id}.md`);
  assert.match(await readFile(draft, 'utf8'), /尚未安装/);
  await d.request('resize', { width: 1440, height: 1000 });
  await d.evaluate(`document.querySelectorAll('.review-finding')[1].scrollIntoView(); true`); await delay(200);
  await writeFile(path.join(output, 'workflow.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  await d.evaluate(`document.querySelector('.review-feedback').scrollIntoView({block:'center'}); true`); await delay(200);
  await writeFile(path.join(output, 'feedback.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  await d.evaluate(`document.querySelector('#usage-reviews').scrollIntoView(); true`); await delay(200);
  await writeFile(path.join(output, 'schedule.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  await d.evaluate(`document.querySelector('.review-options').open = false; document.querySelectorAll('.review-finding details').forEach(item => item.open = false); document.querySelector('#usage-reviews').scrollIntoView(); true`);
  for (const [name, width, height] of [['desktop', 1440, 1000], ['narrow', 560, 850]]) {
    stage = `capture-${name}`;
    await d.request('resize', { width, height }); await delay(250);
    assert.equal(await d.evaluate('document.documentElement.scrollWidth > innerWidth'), false, `${name} has no overflow`);
    await d.screenshot(); await delay(150);
    await writeFile(path.join(output, `${name}.png`), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  }
  const windows = await d.windows();
  stage = 'deduplication';
  assert.equal(windows.main.focused, false); assert.equal(windows.main.visible, false);
  await d.domClick('[data-review-run="daily"]');
  assert.equal(await d.evaluate('Array.from(document.querySelectorAll("[data-review-feedback], [data-review-export]")).every(button => button.disabled)'), true, 'feedback and export cannot silently ignore clicks while analysis runs');
  await d.waitFor('#review-notice', state => state.text === '复盘已完成。');
  assert.equal(calls, 2);
  assert.equal(await d.evaluate('document.querySelectorAll(".review-finding").length'), 0, 'dismissed and repeated suggestions are suppressed');
  fail = true;
  stage = 'model-error';
  await d.domClick('[data-review-run="weekly"]');
  await d.waitFor('#review-notice', state => state.text.includes('503'));
  assert.equal((await d.query('[data-review-run="daily"]')).disabled, false, 'failure restores available controls');
  stage = 'reload';
  await d.request('reload', { target: 'shell' });
  await delay(500); // reload() returns before the old document is replaced.
  await d.waitFor('html[data-workspace-loading="false"]', state => state.exists, { target: 'shell' });
  await d.evaluate("window.workspaceHost.navigate('./settings.html'); true", { target: 'shell' });
  await d.waitFor('#review-enabled', state => state.attributes['aria-checked'] === 'false');
  assert.equal(await d.evaluate('window.tasks.reviewSnapshot().then(s => s.feedback[0].note)'), '测试反馈：已有处理方案');
  console.log('PASS: isolated review sources, model response, settings, evidence, feedback, export, deduplication, error, persistence, responsive and no-focus checks');
} catch (error) {
  console.error(`Usage review E2E failed at ${stage}`);
  throw error;
} finally {
  if (app) {
    const pid = app.child.pid;
    await app.driver.request('quit', {}, 10000).catch(() => {});
    for (let attempt = 0; attempt < 100 && app.child.exitCode === null && app.child.signalCode === null; attempt++) await delay(100);
    await app.stop();
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, 'temporary main process exited');
    await writeFile(path.join(output, 'cleanup.json'), JSON.stringify({ pid, exited: true, fixtureRemoved: true }, null, 2));
  }
  await new Promise(resolve => server.close(resolve));
}
