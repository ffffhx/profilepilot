import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchProfilePilotE2e, repoRoot } from "./e2e/lib/electron-driver.mjs";

let fail = false;
const requests = [];
const server = createServer((req, res) => {
  requests.push({ url: req.url, key: req.headers['x-api-key'] });
  res.writeHead(fail ? 404 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'fixture-balanced' }, { id: 'fixture-fast' }, { id: 'fixture-reasoning' }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const app = await launchProfilePilotE2e({ name: 'model picker and return navigation' });
try {
  const d = app.driver;
  await d.domClick('[data-workspace-trigger]');
  await d.domClick('a[href="./tasks.html"]');
  await d.waitFor('#create-task');
  await d.evaluate(`window.tasks.snapshot().then(({settings})=>window.tasks.saveSettings({...settings,model:'fixture-balanced',baseUrl:${JSON.stringify(baseUrl)},apiKey:'fixture-model-key'}))`);
  await d.domInput('#prompt', '保留对话草稿，不要切换页面');
  await d.domClick('#agent-model-trigger');
  await d.waitFor('[role=option]', option => option.text.includes('fixture-fast'));
  assert.equal(requests[0].url, '/v1/models');
  assert.equal(requests[0].key, 'fixture-model-key');
  assert.equal((await d.query('#settings-form')).exists, false);
  const dir = path.join(repoRoot, 'test-results', 'browser-tasks', 'model-picker'); await mkdir(dir, {recursive:true});
  const shot = async name => { await d.screenshot(); await new Promise(resolve=>setTimeout(resolve,250)); await writeFile(path.join(dir,name),Buffer.from((await d.screenshot()).pngBase64,'base64')); };
  await shot('model-menu.png');
  await d.domClick('[role=option][data-value="fixture-fast"]');
  await d.waitFor('#task-toast', s => s.text.includes('已选择 fixture-fast'));
  await d.waitFor('#task-app', s => s.attributes['aria-busy'] !== 'true');
  assert.equal((await d.evaluate('window.tasks.snapshot()')).settings.model, 'fixture-fast');
  assert.equal(await d.evaluate('document.querySelector("#prompt").value'), '保留对话草稿，不要切换页面');
  assert.equal((await d.evaluate('window.tasks.snapshot()')).settings.baseUrl, baseUrl);
  assert.equal((await d.evaluate('window.tasks.snapshot()')).settings.hasApiKey, true);

  await d.domClick('#agent-model-trigger');
  await d.domClick('.model-service-link');
  await d.waitFor('#settings-form');
  assert.equal(await d.evaluate('document.activeElement.id'), 'model');
  assert.equal((await d.query('.return-agent')).text, '← 返回 Agent 对话');
  const backVisible = await d.evaluate(`(() => { const r=document.querySelector('.return-agent').getBoundingClientRect(); return r.top>=0&&r.bottom<innerHeight; })()`);
  assert.equal(backVisible, true);
  await shot('settings-return.png');
  await d.domClick('.return-agent');
  await d.waitFor('#create-task');
  assert.equal(await d.evaluate('document.querySelector("#prompt").value'), '保留对话草稿，不要切换页面');
  assert.match((await d.query('#agent-model-trigger')).text, /fixture-fast/);

  await d.domClick('#agent-model-trigger');
  await d.domInput('.select-search', 'custom-model-id');
  await d.dispatch('.select-search', 'keydown', {key:'Enter'});
  await d.waitFor('#task-toast', s => s.text.includes('custom-model-id'));
  await d.waitFor('#task-app', s => s.attributes['aria-busy'] !== 'true');
  assert.equal((await d.evaluate('window.tasks.snapshot()')).settings.model, 'custom-model-id');

  // An unavailable model-list endpoint must still leave custom selection and
  // the settings/return path usable, without losing the current model or draft.
  fail = true;
  await d.evaluate(`window.tasks.snapshot().then(({settings})=>window.tasks.saveSettings({...settings,baseUrl:${JSON.stringify(baseUrl + '/unavailable')}}))`);
  await d.domClick('#agent-model-trigger');
  await d.waitFor('.model-menu-status', s => s.text.includes('暂时无法读取'));
  assert.match((await d.query('[role=option]')).text, /custom-model-id/);
  await d.domClick('.model-service-link');
  await d.domClick('.return-agent');
  assert.equal(await d.evaluate('document.querySelector("#prompt").value'), '保留对话草稿，不要切换页面');
  console.log('PASS model picker: service catalog, credentials stay in main, in-place selection, custom IDs, failed catalog fallback, visible return and draft preservation');
} finally { await app.stop(); await new Promise(resolve => server.close(resolve)); }
