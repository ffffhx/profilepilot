const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadTsModule } = require('./helpers/load-ts-module');

function fixture(t, observe) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-local-loading-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { id: randomUUID(), name: 'Slow app', cwd: root, command: 'must-not-run', mode: 'launch', environment: '', cdpPort: null, inspectPort: null, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, 'apps.json'), JSON.stringify([config]));
  const { LocalAppsService } = loadTsModule('src/main/local-apps/service.ts', { stubs: {
    './service-runtime': { processRuntime: observe, invalidateProcessRuntime() {} }
  } });
  return { config, service: new LocalAppsService(root) };
}

test('first-paint snapshot remains available while a runtime probe is unresolved', async t => {
  let finish, calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const { service, config } = fixture(t, () => { calls++; return pending; });
  const initial = service.snapshot();
  assert.equal(initial[0].name, config.name);
  assert.equal(calls, 0);
  assert.equal(initial[0].runtime.status, 'unknown');
  assert.deepEqual(initial[0].controls, { start: false, stop: false, restart: false });
  const probing = service.list();
  assert.equal(calls, 1);
  assert.equal(service.snapshot()[0].runtime.status, 'unknown');
  finish({ status: 'running', pid: 123, startedAt: null, exitCode: null, error: '' });
  await probing;
  assert.equal(service.snapshot()[0].runtime.status, 'running');
  assert.equal(service.snapshot()[0].managed, false);
  assert.equal(service.snapshot()[0].controls.stop, false);
});

test('configuration edits and removal cannot inherit an in-flight result for the old app', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { service, config } = fixture(t, () => pending);
  const probing = service.list();
  await service.save({ ...config, name: 'Edited app' });
  finish({ status: 'running', pid: 123, startedAt: null, exitCode: null, error: '' });
  await probing;
  const current = service.snapshot()[0];
  assert.equal(current.name, 'Edited app');
  assert.equal(current.runtime.status, 'unknown');
  await service.remove(config.id);
  assert.deepEqual(service.snapshot(), []);
});
