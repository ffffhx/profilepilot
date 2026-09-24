import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';
import { startTaskFixture } from './browser-task-fixture.mjs';
const require = createRequire(import.meta.url);
const { WrapperBrowser } = require('../dist/main/tasks/browser');
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');
const { subscribeBrowserGatewayEvents } = require('../dist/main/browser-gateway-client');
const output = path.resolve(process.env.PP_DOGFOOD_OUTPUT || `test-results/pause-runtime-${Date.now()}`);
await mkdir(output, { recursive: true });
const fixture = await startTaskFixture(), gateway = await startTaskGatewayFixture();
const results = [];
let service, subscription, task;
const wait = async (fn, label) => { const end = Date.now() + 60000; while (!fn()) { if (Date.now() > end) throw Error(label); await new Promise(r => setTimeout(r, 50)); } };
try {
  for (let round = 0; round < 12; round++) {
    const store = new TaskStore(path.join(output, `round-${round}`));
    store.data.settings.jevEnabled = true; store.data.settings.jevMode = 'driver';
    const browser = new WrapperBrowser(output);
    // No model/API call: exercise the real service/driver/transport lifecycle,
    // stopping immediately after the resumed observation reaches Chrome.
    service = new TaskService(store, { browser, apiKey: () => 'unused-fixture-key', jevApiKey: () => 'unused-fixture-key',
      profileName: async () => gateway.name, prepareProfile: async () => ({ name: gateway.name, port: gateway.port }),
      changed: () => {}, notify: () => {}, chooseJev: async () => ({ operation: 'WAIT' }),
      worker: () => { throw Error('This transport test must not start a model'); },
    });
    subscription = subscribeBrowserGatewayEvents({ onEvent: event => { const p = event.controlEvent?.profile; if (task && p?.ownerSessionId === task.sessionId) service.externalControl(task.sessionId, p.ownership, p.sessionStatus, event.controlEvent.reason); } }, { homeDir: gateway.home });
    await subscription.ready;
    let resumed = false, observed = false;
    const tool = service.handleTool.bind(service);
    service.handleTool = async (t, run, name, args) => {
      const response = await tool(t, run, name, args);
      if (resumed && name === 'observe' && !response.isError) { observed = true; await service.control(t.id, 'cancel'); }
      return response;
    };
    task = await service.create({ profileId: gateway.id, prompt: `Open ${fixture.url}/apply`, limits: { minutes: 2, actions: 10, budgetUsd: 1 } });
    await wait(() => task.receipts.length > 0, 'Initial action never started');
    await new Promise(r => setTimeout(r, round % 6 * 150));
    await service.control(task.id, 'pause');
    await wait(() => !service.runs.has(task.id), 'Pause did not drain');
    const sessionId = task.sessionId;
    resumed = true; await service.control(task.id, 'resume');
    await wait(() => !['running', 'queued'].includes(task.status) && !service.runs.has(task.id), 'Resumed run did not stop');
    results.push({ round, observed, sameSession: task.sessionId === sessionId, task });
    await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    assert.ok(observed, JSON.stringify(task.events.at(-1)));
    assert.equal(task.sessionId, sessionId);
    assert.equal(task.usage.costUsd, 0);
    subscription.close(); subscription = undefined; await service.close(); service = undefined;
    console.log('PASS runtime pause during startup', round);
  }
} catch (error) {
  results.push({ failure: String(error), task });
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  throw error;
} finally {
  if (task && service && !['completed', 'cancelled', 'failed', 'partial'].includes(task.status)) await service.control(task.id, 'cancel').catch(() => {});
  subscription?.close(); await service?.close(); await gateway.close(); await fixture.close();
}
