const test = require('node:test');
const assert = require('node:assert/strict');
const { Script, createContext } = require('node:vm');
const source = import('../scripts/e2e/wgc-fixture-source.mjs');

function evidence() {
  const page = { dpr: 1.25, contentRevision: 0,
    markers: [{ id: 'green', x: 64, y: 79 }, { id: 'blue', x: 314, y: 164 }, { id: 'red', x: 564, y: 304 }] };
  const content = { x: 108, y: 130, width: 1000, height: 625 };
  const capture = { x: 100, y: 100, width: 1016, height: 663 };
  const decoded = { width: 1016, height: 663, markers: page.markers.map(marker => ({ count: 3600,
    x: content.x - capture.x + marker.x * page.dpr, y: content.y - capture.y + marker.y * page.dpr })) };
  return { page, content, capture, decoded };
}

test('owned freshness fixture parses without Electron, processes or capture', async () => {
  const { fixtureSource } = await source;
  new Script(fixtureSource);
});

test('known DOM marker revision is checked against actual decoded positions without granting coordinates', async () => {
  const { evaluateWgcMarkerEvidence } = await source;
  const e = evidence();
  const result = evaluateWgcMarkerEvidence(e.decoded, e.page, e.content, e.capture);
  assert.equal(result.matches, true); assert.equal(result.classification, 'current_markers_match');
  assert.ok(result.measurements.every(marker => marker.coordinateAuthority === false));
});

test('new timestamps and observation ids cannot turn old pixels into evidence for a changed DOM revision', async () => {
  const { evaluateWgcMarkerEvidence } = await source;
  const e = evidence(); e.page.contentRevision = 1; e.page.markers[0].x += 40;
  e.decoded.frameTimestampTicks = '999999999999'; e.decoded.version = 'fresh-observation-id';
  const result = evaluateWgcMarkerEvidence(e.decoded, e.page, e.content, e.capture);
  assert.equal(result.expectedRevision, 1); assert.equal(result.matches, false); assert.equal(result.classification, 'markers_mismatch');
});

test('missing marker pixels stay an explicit diagnostic failure rather than being accepted as fresh', async () => {
  const { evaluateWgcMarkerEvidence } = await source;
  const e = evidence(); e.decoded.markers[1] = { count: 0, x: -1, y: -1 };
  const result = evaluateWgcMarkerEvidence(e.decoded, e.page, e.content, e.capture);
  assert.equal(result.matches, false); assert.equal(result.classification, 'markers_missing');
  assert.equal(result.measurements[1].measured, null);
});

test('empty marker sets and invalid dimensions cannot produce a vacuous freshness pass', async () => {
  const { evaluateWgcMarkerEvidence } = await source;
  const e = evidence();
  for (const input of [{ ...e.page, markers: [] }, { ...e.page, dpr: 0 }]) {
    assert.equal(evaluateWgcMarkerEvidence(e.decoded, input, e.content, e.capture).classification, 'invalid_marker_evidence');
  }
  assert.equal(evaluateWgcMarkerEvidence({ ...e.decoded, width: 0 }, e.page, e.content, e.capture).matches, false);
});

for (const iframe of [false, true]) test(`startup occlusion ${iframe ? 'iframe' : 'direct'} creates a visible cover before a visible non-activating target and its first navigation`, async () => {
  const { fixtureSource } = await source;
  const events = [], windows = [];
  class FakeWindow {
    constructor(options) {
      this.options = options; this.visible = options.show !== false; this.events = new Map();
      this.kind = options.alwaysOnTop ? 'cover' : 'target';
      this.webContents = { backgroundThrottling: options.webPreferences.backgroundThrottling ?? true,
        once: (name, callback) => this.events.set(name, callback) };
      windows.push(this); events.push(this.kind + ':construct');
    }
    async loadURL(url) { this.url = url; events.push(this.kind + ':load'); this.events.get('did-finish-load')?.(); }
    showInactive() { this.visible = true; events.push(this.kind + ':show-inactive'); }
    hide() { this.visible = false; events.push(this.kind + ':hide'); }
    close() { this.destroyed = true; events.push(this.kind + ':close'); }
    isDestroyed() { return Boolean(this.destroyed); }
    setAlwaysOnTop(value) { this.options.alwaysOnTop = value; events.push(this.kind + ':topmost:' + value); }
    getBounds() { const { x, y, width, height } = this.options; return { x, y, width, height }; }
    getNativeWindowHandle() { const value = Buffer.alloc(8); value.writeBigUInt64LE(BigInt(windows.indexOf(this) + 1)); return value; }
    isVisible() { return this.visible; }
    isFocused() { return false; }
    isAlwaysOnTop() { return Boolean(this.options.alwaysOnTop); }
    once(name, callback) { this.events.set(name, callback); }
  }
  const context = createContext({
    require(name) {
      if (name === 'electron') return { BrowserWindow: FakeWindow,
        app: { setPath() {}, on() {}, whenReady: () => new Promise(() => {}) },
        screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1536, height: 864 } }) } };
      if (name === 'node:fs') return {};
      if (name === 'node:path') return require('node:path');
      throw new Error('Unexpected fixture import: ' + name);
    },
    process: { argv: ['electron', 'fixture', 'fake-owned-user-data', 'fake-owned-home'] },
    setTimeout(callback, milliseconds) { if (milliseconds < 8000) queueMicrotask(callback); return 1; }, clearTimeout() {}
  });
  new Script(fixtureSource).runInContext(context);
  await new Script(`create(true, 'default', ${iframe}, true)`).runInContext(context);
  assert.deepEqual(events.filter(event => !event.endsWith(':did-finish-load')), [
    'cover:construct', 'cover:load', 'cover:show-inactive', 'target:construct', 'target:load'
  ]);
  const target = windows[1];
  assert.equal(target.options.show, true); assert.equal(target.options.focusable, false);
  assert.equal(Object.hasOwn(target.options.webPreferences, 'backgroundThrottling'), false);
  const evidence = JSON.parse(new Script('JSON.stringify(startupEvidence)').runInContext(context));
  assert.equal(evidence.targetCreatedAfterVisibleCover, true);
  assert.equal(evidence.loadStartedWhileCovered, true);
  assert.equal(decodeURIComponent(target.url).includes('id="fixture-frame"'), iframe);
  assert.equal(new Script('lastPageCapture').runInContext(context), undefined, 'Startup cannot be prewarmed with capturePage');
  new Script('revealOwnedTarget()').runInContext(context);
  assert.equal(windows[0].isDestroyed(), true, 'Only the owned cover is closed');
  assert.equal(target.isAlwaysOnTop(), true);
  assert.equal(target.isFocused(), false);
  assert.deepEqual(events.slice(-3), ['cover:close', 'target:topmost:true', 'target:show-inactive']);
  assert.throws(() => new Script('revealOwnedTarget()').runInContext(context), /already active/);
  const exposure = JSON.parse(new Script('JSON.stringify(exposure)').runInContext(context));
  assert.equal(exposure.physicalVisibility, 'not_independently_sampled', 'A z-order request alone cannot prove actual pixels or physical exposure');
  new Script('restoreOwnedTargetLayer()').runInContext(context);
  assert.equal(target.isAlwaysOnTop(), false);
  assert.equal(target.isVisible(), true);
  assert.equal(new Script('layerLease').runInContext(context), undefined);
  const restored = JSON.parse(new Script('JSON.stringify(exposure)').runInContext(context));
  assert.equal(restored.restoredAlwaysOnTop, false); assert.equal(restored.restoredVisible, true);
  assert.equal(Number.isFinite(restored.restoredAt), true);

  target.hide();
  target.showInactive = () => { throw new Error('simulated inactive-show failure'); };
  assert.throws(() => new Script('revealOwnedTarget()').runInContext(context), /simulated inactive-show failure/);
  assert.equal(target.isAlwaysOnTop(), false, 'A failed exposure restores the original layer');
  assert.equal(target.isVisible(), false, 'A failed exposure restores an originally hidden target');
  assert.equal(new Script('layerLease').runInContext(context), undefined);
});
