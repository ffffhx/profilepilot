const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { createPhoneInspector } = loadCli('src/renderer/phone-inspector.ts');

// Exercise the renderer request lifecycle without launching Electron or a phone.
function harness(t) {
  class Element {
    constructor() { this.hidden = false; this.disabled = false; this.dataset = {}; this.children = []; this.src = ''; this.textContent = ''; }
    querySelector(selector) { return selector === '[role=status]' ? this.status ||= new Element() : this.children.find(child => selector === `[data-action="${child.dataset.action}"]`) || null; }
    append(child) { this.children.push(child); }
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
  let now = 100000, calls = 0;
  const requests = [];
  const saved = new Map(['window', 'document', 'Image', 'innerHeight'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const dateNow = Date.now;
  globalThis.document = { hidden: false, querySelector: () => null, createElement: () => new Element() };
  globalThis.window = { workspacePane: { active: true }, phones: { screen: () => {
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
  h.tick(12000); h.requests[0].reject(new Error('capture timed out')); await h.flush();
  await h.inspector.refresh();
  assert.equal(h.calls, 1, 'a twelve-second timeout must not immediately start another screencap');
  h.tick(1999); await h.inspector.refresh(); assert.equal(h.calls, 1);
  h.tick(1); const retry = h.inspector.refresh(); assert.equal(h.calls, 2);
  h.requests[1].resolve(h.frame()); await retry;
});
