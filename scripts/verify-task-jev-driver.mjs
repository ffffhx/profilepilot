import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfiguredTaskProvider } from './task-provider-fixture.mjs';
import { startTaskFixture } from './browser-task-fixture.mjs';

const [profileId, portText, mode = 'driver'] = process.argv.slice(2);
const port = Number(portText);
assert.ok(profileId?.startsWith('isolated:') && Number.isInteger(port) && port >= 1024, 'Provide the explicitly allocated test profile and logical port.');
assert.ok(['driver', 'advisory'].includes(mode));
const require = createRequire(import.meta.url);
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');
const { WrapperBrowser } = require('../dist/main/tasks/browser');
const { chooseJevAction } = require('../dist/main/tasks/jev-actions');
const { requestBrowserGateway, subscribeBrowserGatewayEvents } = require('../dist/main/browser-gateway-client');
const gateway = await requestBrowserGateway({ action: 'status' });
const binding = gateway.state.profiles.find(p => p.publicPort === port && p.profileId === profileId);
assert.ok(binding && (!binding.ownerSessionId || binding.sessionStatus === 'stopped'), 'Allocated profile is absent or occupied; do not override it.');
const provider = await loadConfiguredTaskProvider({ includeJev: true });
assert.ok(provider.jevApiKey && provider.apiKey, 'Both configured keys are needed.');
const fixture = await startTaskFixture();
const root = path.resolve('.cpm-data', `jev-driver-${mode}-${Date.now()}`);
const resultRoot = path.resolve('test-results/browser-tasks', path.basename(root));
await mkdir(resultRoot, { recursive: true });
const store = new TaskStore(root);
store.data.settings = { ...store.data.settings, ...provider.settings, jevEnabled: true, jevMode: mode, notifications: false };
const redact = s => [provider.apiKey, provider.jevApiKey].reduce((v, k) => k ? v.replaceAll(k, '[REDACTED]') : v, s);
const decisions = [], observations = [], browser = new WrapperBrowser(path.join(root, 'artifacts'));
const fastObserve = browser.observeFast.bind(browser);
browser.observeFast = async task => { const start = Date.now(); const o = await fastObserve(task); observations.push({ at: o.at, title: o.title, snapshot: o.snapshot, elapsedMs: Date.now() - start }); return o; };
let task, lastEvent;
const service = new TaskService(store, {
  browser, apiKey: () => provider.apiKey, jevApiKey: () => provider.jevApiKey,
  profileName: async id => { assert.equal(id, profileId); return binding.profileName; },
  prepareProfile: async id => { assert.equal(id, profileId); return { name: binding.profileName, port }; },
  chooseJev: async (...args) => { const result = await chooseJevAction(...args); decisions.push(result); console.log('JEV', JSON.stringify(result)); return result; },
  changed: snapshot => { const event = snapshot.tasks[0]?.events.at(-1); if (event && event.id !== lastEvent) { lastEvent = event.id; console.log(event.kind, redact(event.text).slice(0, 800)); } }, notify: () => {}
});
const subscription = subscribeBrowserGatewayEvents({ onEvent: event => { const p = event.controlEvent?.profile; if (task && p?.ownerSessionId === task.sessionId) service.externalControl(task.sessionId, p.ownership, p.sessionStatus, event.controlEvent.reason); } });
await subscription.ready;
const start = Date.now();
try {
  task = await service.create({ profileId,
    prompt: `打开 ${fixture.url}/apply ，填写招聘申请：姓名为“Jev测试员”，邮箱为“jev.test@example.test”，城市选择“上海”，勾选确认资料正确，然后提交申请。附件不需要上传，不需要展开额外信息，也不要模拟连接中断。看到页面显示提交成功后，报告回执编号。`,
    authorization: '这是本地测试表单，允许填写并提交一条虚构资料。',
    grant: { origin: fixture.url, effects: ['submit'], maxActions: 1 }, limits: { minutes: 8, actions: 30, budgetUsd: 1 }
  });
  while (Date.now() - start < 500000 && (['queued', 'running'].includes(task.status) || service.runs.has(task.id))) await new Promise(r => setTimeout(r, 500));
  const record = fixture.records[0];
  const passed = task.status === 'completed' && fixture.records.length === 1 && record.name === 'Jev测试员' && record.email === 'jev.test@example.test' && record.city === '上海' && (mode !== 'driver' || task.usage.jevActions >= 4);
  const result = { passed, mode, elapsedMs: Date.now() - start, status: task.status, result: task.result, pending: task.pending, usage: task.usage, records: fixture.records, events: task.events, receipts: task.receipts, decisions, observations, limitation: 'One controlled local task with real model APIs and real Chrome; not a broad browser benchmark.' };
  await writeFile(path.join(resultRoot, 'result.json'), redact(JSON.stringify(result, null, 2)));
  console.log('RESULT', JSON.stringify({ ...result, events: undefined, receipts: undefined, decisions: undefined, observations: undefined, evidence: path.join(resultRoot, 'result.json') }));
  process.exitCode = passed ? 0 : 1;
} finally {
  subscription.close();
  if (task && ['queued', 'running'].includes(task.status)) await service.control(task.id, 'pause');
  await service.close(); await fixture.close();
}
