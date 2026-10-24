const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { createPhoneInspector } = loadCli('src/renderer/phone-inspector.ts');

// Exercise the renderer request lifecycle without launching Electron or a phone.
function harness(t) {
  class Element {
    constructor() { this.hidden = false; this.disabled = false; this.dataset = {}; this.children = []; this.src = ''; this.textContent = ''; }
    querySelector(selector) { return selector === '[role=status]' ? this.status ||= new Element() : this.children.find(child => selector === `[data-action="${child.dataset.action}"]`) || null; }
    append(...children) { this.children.push(...children); }
    setAttribute(name,value) { this[name]=value; }
    addEventListener(name,listener) { (this.listeners ||= {})[name]=listener; }
    showModal() { this.open=true; }
    close() { this.open=false; this.listeners?.close?.(); }
    remove() { this.removed=true; }
    removeAttribute(name) { this[name] = ''; }
    replaceWith(next) { this.replacement = next; }
  }
  class ImageElement extends Element {
    constructor() { super(); this.naturalWidth = 1; this.naturalHeight = 1; }
    async decode() {}
  }
  const nodes = new Map();
  const container = new Element();
  container.querySelector = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  container.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
  let now = 100000, calls = 0, timerId = 0;
  const timers = new Map();
  const requests = [];
  const saved = new Map(['window', 'document', 'Image', 'innerHeight','VideoDecoder','EncodedVideoChunk'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const dateNow = Date.now;
  globalThis.document = { hidden: false, body:new Element(), querySelector: () => null, createElement: () => new Element() };
  globalThis.window = { workspacePane: { active: true }, setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); }, phones: { screen: () => {
    calls++;
    return new Promise((resolve, reject) => requests.push({ resolve, reject }));
  } } };
  globalThis.Image = ImageElement;
  globalThis.innerHeight = 1000;
  Date.now = () => now;
  t.after(() => {
    Date.now = dateNow;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const inspector = createPhoneInspector(container);
  const phone = () => ({ id: 'phone', name: 'Phone', transport: 'wifi', connection: 'device', companion: 'ready', confirmedAt: now, pending: null,
    state: { instanceId: 'app', sessionId: 'desktop-session', generation: 1, phase: 'controlling', mode: 'control', permissions: { overlay: true, accessibility: true, notifications: true } } });
  return { inspector, phone, nodes, requests, get calls() { return calls; }, tick(ms) { now += ms; },
    due() { for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } }, get timers() { return timers.size; },
    frame() { return { mime: 'image/png', base64: 'YQ==', width: 1, height: 1, capturedAt: now }; },
    async flush() { await new Promise(resolve => setImmediate(resolve)); } };
}

test('inspector pauses task capture and resumes only after ownership and takeover pause clear', async t => {
  const h = harness(t), phone = h.phone();
  h.inspector.update({ ...phone, taskCaptureActive: true }, false);
  await h.inspector.refresh(true);
  assert.equal(h.calls, 0);
  assert.match(h.nodes.get('.phone-inspector-caption').textContent, /手机任务期间暂停预览/);
  assert.equal(h.nodes.get('[data-action="refresh-phone-screen"]').disabled, true);

  h.inspector.update({ ...phone, taskCaptureActive: false, state: { ...phone.state, phase: 'paused' } }, false);
  await h.inspector.refresh(true);
  assert.equal(h.calls, 0, 'ending capture ownership cannot bypass a user pause');
  h.inspector.update({ ...phone, taskCaptureActive: false }, false);
  assert.equal(h.calls, 1, 'trusted desktop session still gets its normal preview');
  h.requests[0].resolve(h.frame()); await h.flush();
  assert.equal(h.nodes.get('.phone-inspector-placeholder').hidden, true);
});

test('inspector discards a pending sidebar frame when an external task takes capture ownership', async t => {
  const h = harness(t), phone = h.phone();
  h.inspector.update(phone, false);
  assert.equal(h.calls, 1);
  h.inspector.update({ ...phone, taskCaptureActive: true }, false);
  h.requests[0].resolve(h.frame()); await h.flush();
  assert.equal(h.nodes.get('.phone-inspector-placeholder').hidden, false);
  assert.equal(h.nodes.get('.phone-inspector-screen').disabled, true);
  h.tick(15000); await h.inspector.refresh(true);
  assert.equal(h.calls, 1, 'even explicit refresh stays paused throughout the task');
});

test('inspector waits two seconds after a slow failed capture before polling again', async t => {
  const h = harness(t), phone = h.phone();
  h.inspector.update(phone, false);
  h.tick(12000); phone.confirmedAt = Date.now(); // Background status polling stays healthy during the slow capture.
  h.requests[0].reject(new Error('capture timed out')); await h.flush();
  await h.inspector.refresh();
  assert.equal(h.calls, 1, 'a twelve-second timeout must not immediately start another screencap');
  h.tick(1999); await h.inspector.refresh(); assert.equal(h.calls, 1);
  h.tick(1); h.inspector.update(h.phone(), false); const retry = h.inspector.refresh(); assert.equal(h.calls, 2);
  h.requests[1].resolve(h.frame()); await retry;
});

test('continuous preview caps fast captures at two fps and never overlaps a slow capture', async t => {
  const h = harness(t), phone = h.phone();
  h.inspector.update(phone, false); h.requests[0].resolve(h.frame()); await h.flush();
  h.tick(499); h.due(); assert.equal(h.calls, 1);
  h.tick(1); h.due(); assert.equal(h.calls, 2);
  h.tick(700); h.due(); await h.inspector.refresh(true); assert.equal(h.calls, 2, 'only one capture may be in flight');
  h.requests[1].resolve(h.frame()); await h.flush();
  h.tick(149); h.due(); assert.equal(h.calls, 2);
  h.tick(1); h.due(); assert.equal(h.calls, 3, 'slow captures retain an idle gap instead of queuing work');
  h.requests[2].resolve(h.frame()); await h.flush();
  assert.match(h.nodes.get('.phone-inspector-caption').textContent, /连续预览/);
  window.workspacePane.active = false; h.inspector.update(phone, false);
  assert.equal(h.timers, 0, 'a hidden workspace releases its refresh timer');
  h.tick(1000); h.due(); assert.equal(h.calls, 3);
});

test('sidebar never starts video; opening a preview starts once and closing stops it',async t=>{
  const h=harness(t),starts=[],stops=[];
  globalThis.VideoDecoder=class{state='unconfigured';close(){this.state='closed';}};
  globalThis.EncodedVideoChunk=class{};
  window.phones.videoStart=async id=>{starts.push(id);return{streamId:'preview-stream'};};
  window.phones.videoRead=()=>new Promise(()=>{});
  window.phones.videoStop=async id=>{stops.push(id);};
  h.inspector.update(h.phone(),false);h.requests[0].resolve(h.frame());await h.flush();
  assert.equal(starts.length,0);
  h.inspector.enlarge();await h.flush();assert.deepEqual(starts,['phone']);
  h.inspector.enlarge();assert.equal(starts.length,1);
  document.body.children[0].close();await h.flush();assert.ok(stops.includes('preview-stream'));
  assert.match(h.nodes.get('.phone-inspector-caption').textContent,/连续预览/);
});

test('ADB-only phones offer connection and never request or retain a sidebar frame', async t => {
  const h = harness(t), phone = h.phone();
  h.inspector.update({ ...phone, companion: 'unavailable', state: null }, false);
  await h.inspector.refresh(true);
  assert.equal(h.calls, 0);
  assert.match(h.nodes.get('.phone-inspector-actions').innerHTML, /connect-phone/);
  h.inspector.update({ ...phone, state: { ...phone.state, phase: 'idle' } }, false);
  assert.equal(h.calls, 1);
  assert.match(h.nodes.get('.phone-inspector-actions').innerHTML, /disconnect-phone/);
  h.inspector.update({ ...phone, companion: 'unavailable' }, false);
  h.requests[0].resolve(h.frame()); await h.flush();
  assert.equal(h.nodes.get('.phone-inspector-screen').disabled, true);
  assert.equal(h.nodes.get('.phone-inspector-placeholder').hidden, false);
  h.tick(3000); await h.inspector.refresh(true);
  assert.equal(h.calls, 1, 'late capture and manual refresh cannot display a disconnected phone');
});

test('a displayed frame is removed when App heartbeat expires or reports disconnected', async t => {
  const h = harness(t), phone = h.phone();
  h.inspector.update(phone, false); h.requests[0].resolve(h.frame()); await h.flush();
  assert.equal(h.nodes.get('.phone-inspector-placeholder').hidden, true);
  h.tick(8001); h.inspector.update(phone, false);
  assert.equal(h.nodes.get('.phone-inspector-placeholder').hidden, false);
  assert.equal(h.nodes.get('.phone-inspector-screen').disabled, true);
  h.inspector.update({ ...h.phone(), state: { ...phone.state, readiness: { computerConnected: false } } }, false);
  await h.inspector.refresh(true); assert.equal(h.calls, 1);
});
