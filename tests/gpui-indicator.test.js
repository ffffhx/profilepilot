const test = require('node:test');
const assert = require('node:assert/strict');
const { GpuiAnnotationIndicator, indicatorRect } = require('../dist/main/gpui/indicator');

function fixture(t, target = 'any-gpui-app') {
  const app = { target_id: target, app_id: 'arbitrary', app_name: 'Any GPUI app', pid: 1234 };
  const calls = [], failures = [];
  let width = 800, height = 600, closed = false, selected = app, block, release;
  const client = { async start() {}, close() { closed = true; }, async call(name, args) {
    calls.push({ name, args });
    if (name === 'select_app') return { structuredContent: { selected } };
    if (name === 'get_ui_tree') { if (block) await block; return { structuredContent: { roots: ['root'], nodes: { root: { bounds: { x: 0, y: 0, width, height } } } } }; }
    return { structuredContent: { ok: true } };
  } };
  const indicator = new GpuiAnnotationIndicator(client, app, error => failures.push(error));
  t.after(() => indicator.close());
  return { indicator, calls, failures, get closed() { return closed; }, resize(w, h) { width = w; height = h; },
    mismatch() { selected = { ...app, pid: app.pid + 1 }; },
    defer() { block = new Promise(resolve => release = resolve); return () => { block = undefined; release(); }; } };
}

test('each arbitrary GPUI target receives only its own display annotation; cleanup preserves other annotations', async t => {
  const a = fixture(t, 'first'), b = fixture(t, 'second');
  await Promise.all([a.indicator.setState('active'), b.indicator.setState('active')]);
  assert.deepEqual(a.calls[0].args, { target_id: 'first' }); assert.deepEqual(b.calls[0].args, { target_id: 'second' });
  const badge = a.calls.find(call => call.name === 'annotate_elements').args;
  assert.match(badge.annotations[0].label, /控制中/);
  assert.equal(badge.annotations[0].ttl_ms, 5000);
  assert.deepEqual(badge.annotations[0].rect, { x: 644, y: 590, width: 1, height: 1 });
  assert.notEqual(badge.replace_group, b.calls.find(call => call.name === 'annotate_elements').args.replace_group);
  await a.indicator.close();
  assert.deepEqual(a.calls.at(-1), { name: 'remove_annotations', args: { group: badge.replace_group } });
  assert.equal(a.closed, true);
  assert.ok(a.calls.every(call => ['select_app', 'get_ui_tree', 'annotate_elements', 'remove_annotations'].includes(call.name)));
});
test('resizing and pausing reposition the badge without global coordinates or input', async t => {
  const f = fixture(t); await f.indicator.setState('active'); f.resize(1000, 700);
  await f.indicator.setState('paused');
  const badge = f.calls.at(-1).args.annotations[0];
  assert.deepEqual(badge.rect, { x: 844, y: 690, width: 1, height: 1 }); assert.match(badge.label, /已暂停/);
});
test('a pause arriving during a read cannot paint an active label afterward', async t => {
  const f = fixture(t); const release = f.defer();
  const active = f.indicator.setState('active'); await new Promise(resolve => setImmediate(resolve));
  const paused = f.indicator.setState('paused'); release(); await Promise.all([active, paused]);
  assert.ok(f.calls.filter(call => call.name === 'annotate_elements').every(call => /已暂停/.test(call.args.annotations[0].label)));
});
test('close while a read is pending cannot resurrect the badge', async t => {
  const f = fixture(t), release = f.defer(); const running = f.indicator.setState('active');
  await new Promise(resolve => setImmediate(resolve)); const closing = f.indicator.close(); release();
  await Promise.all([running, closing]); assert.equal(f.calls.filter(call => call.name === 'annotate_elements').length, 0);
  assert.equal(f.closed, true);
});
test('target identity mismatch never paints a different process', async t => {
  const f = fixture(t); f.mismatch(); await assert.rejects(f.indicator.setState('active'), { code: 'GPUI_TARGET_CHANGED' });
  assert.equal(f.failures.length, 1); assert.equal(f.closed, true); assert.equal(f.calls.length, 1);
});
test('missing or hidden geometry is reported instead of guessing a screen coordinate', () => {
  assert.throws(() => indicatorRect({ roots: ['r'], nodes: { r: { bounds: { x: 0, y: 0, width: NaN, height: 10 } } } }));
  assert.throws(() => indicatorRect({ roots: ['r'], nodes: { r: { state: { visible: false }, bounds: { x: 0, y: 0, width: 10, height: 10 } } } }));
  assert.deepEqual(indicatorRect({ roots: ['r'], nodes: { r: { bounds: { x: 0, y: 0, width: 10, height: 10 } } } }), { x: 0, y: 0, width: 1, height: 1 });
});

async function serviceFixture(t, failFirst = false) {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { GpuiService } = require('../dist/main/gpui/service');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpui-indicator-service-'));
  const target = { target_id: 'unrelated-app', app_id: 'demo', app_name: 'Demo', pid: 901 };
  const indicators = [];
  const service = new GpuiService({ directory, defaultBackend: process.execPath,
    guardFactory: callbacks => ({ sync() { queueMicrotask(() => callbacks.onStatus({ status: 'guard-active' })); }, dispose() {} }),
    backendFactory: () => ({ start: async () => {}, close() {}, async call(name) {
      return { structuredContent: name === 'list_apps' ? { apps: [target] } : name === 'select_app' ? { selected: target } : { protocol_version: 14 } };
    } }),
    indicatorFactory: () => {
      const item = { states: [], closed: false, async setState(state) {
        if (failFirst && indicators.length === 1) throw new Error('annotations unsupported'); this.states.push(state);
      }, async close() { this.closed = true; } }; indicators.push(item); return item;
    } });
  t.after(() => { service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await service.execute({ action: 'gpui', method: 'claim', target: target.target_id, session: 'task' });
  return { service, indicators, control: action => { const state = service.status().sessions[0]; return service.control(action, state.name, state.revision); } };
}
test('service lifecycle paints preparation, active and pause, then removes the badge on stop', async t => {
  const f = await serviceFixture(t); assert.deepEqual(f.indicators[0].states, ['preparing', 'active']);
  await f.control('takeover'); assert.equal(f.indicators[0].states.at(-1), 'paused');
  await assert.rejects(f.service.execute({ action: 'gpui', method: 'resume', session: 'task' }), { code: 'GPUI_PAUSED' });
  await f.control('return'); assert.equal(f.indicators.length, 1);
  await f.control('stop'); assert.equal(f.indicators[0].closed, true); assert.equal(f.service.status().sessions.length, 0);
});
test('missing annotation support is visible without blocking control; explicit return can retry', async t => {
  const f = await serviceFixture(t, true);
  assert.equal(f.service.status().sessions[0].state, 'active');
  assert.equal(f.service.status().sessions[0].indicator, 'unavailable');
  assert.match(f.service.status().sessions[0].indicatorReason, /unsupported/);
  await f.control('takeover'); await f.control('return');
  assert.equal(f.indicators.length, 2); assert.equal(f.service.status().sessions[0].indicator, 'embedded');
});
