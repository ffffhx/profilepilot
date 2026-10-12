import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Build first. This fixture owns only its temporary Gateway and Chrome profile.
// Usage: node scripts/verify-capture-input.mjs [--output <directory>]
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output'), 'Expected --output <directory>');
const output = path.resolve(args[1] || 'test-results/capture-input');
const require = createRequire(import.meta.url);
const { BrowserGatewayDaemon } = require('../dist/main/browser-gateway-daemon.js');
const { requestBrowserGateway } = require('../dist/main/browser-gateway-client.js');
const { getDirectChromeCommand } = require('../dist/main/chrome-launch.js');
const { PNG } = require('pngjs');
const executable = getDirectChromeCommand();
assert.ok(executable, 'Chrome must be installed');
await mkdir(output, { recursive: true });
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'pp-capture-input-'));
const gatewayHome = path.join(temporaryRoot, 'gateway');
await mkdir(gatewayHome);
const listener = net.createServer();
await new Promise((resolve, reject) => {
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', resolve);
});
const publicPort = listener.address().port;
await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const identity = { publicPort, sessionId: `capture-input-${randomUUID()}`, daemonInstanceId: `fixture-${randomUUID()}` };
const daemon = new BrowserGatewayDaemon(gatewayHome);
const request = body => requestBrowserGateway(body, { homeDir: gatewayHome, timeoutMs: 20000 });
const report = { passed: false, startedAt: new Date().toISOString(), platform: process.platform, temporaryRoot, publicPort, sessionId: identity.sessionId, records: [], checks: {}, cleanup: [] };
let started = false, launched = false, acquired = false, generation, targetId, stopped;
const checked = response => {
  if (!response.ok) throw Object.assign(new Error(response.message || response.error_code || 'Gateway request failed'), { code: response.error_code });
  return response;
};
async function assertControl() {
  if (stopped) throw stopped;
  try {
    const state = checked(await request({ action: 'status' })).state;
    const profile = state?.profiles.find(item => item.publicPort === publicPort);
    assert.ok(profile && profile.profileId === identity.sessionId && profile.ownerSessionId === identity.sessionId &&
      profile.daemonInstanceId === identity.daemonInstanceId && profile.ownership === 'agent' &&
      profile.sessionStatus === 'active' && profile.controlGeneration === generation,
    'Fixture control was lost; no more browser commands will be sent');
  } catch (error) {
    stopped = error;
    throw error;
  }
}
async function cdp(label, method, params = {}) {
  await assertControl();
  const record = { label, method, startedMs: performance.now() };
  report.records.push(record);
  try {
    // The daemon guards this identity again at dispatch and completion. No direct
    // Chrome HTTP/WebSocket connection, and no global HOME/environment changes.
    const response = checked(await request({ action: 'raw-cdp', ...identity, targetId, method, params, timeoutMs: 10000 }));
    return response.result;
  } catch (error) {
    stopped = error; // Never replay input after an ambiguous error or control loss.
    record.error = String(error);
    throw error;
  } finally {
    record.finishedMs = performance.now();
    record.ms = Math.round(record.finishedMs - record.startedMs);
  }
}
async function evaluate(label, expression) {
  const result = await cdp(label, 'Runtime.evaluate', { expression, returnByValue: true });
  assert.ok(!result.exceptionDetails, `Fixture evaluation failed: ${label}`);
  return result.result.value;
}
async function screenshot(label) {
  const result = await cdp(label, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const bytes = Buffer.from(result.data, 'base64');
  const png = PNG.sync.read(bytes);
  const file = `${label}.png`;
  await writeFile(path.join(output, file), bytes);
  report.records.find(item => item.label === label).image = { file, bytes: bytes.length, width: png.width, height: png.height };
  return png;
}
function sample(png, viewport, x, y) {
  // These scales apply only to screenshot pixels. CDP Input always takes CSS coordinates.
  const px = Math.floor(x * png.width / viewport.width);
  const py = Math.floor(y * png.height / viewport.height);
  return [...png.data.subarray((py * png.width + px) * 4, (py * png.width + px) * 4 + 3)];
}
function assertDimensions(png, viewport) {
  assert.ok(png.width >= 400 && png.height >= 300, 'Capture must be a normal viewport, not a 1x1/2x2 pulse');
  assert.ok(Math.abs(png.width - viewport.width * viewport.dpr) <= 1, 'Screenshot width must match the CSS viewport and DPR');
  assert.ok(Math.abs(png.height - viewport.height * viewport.dpr) <= 1, 'Screenshot height must match the CSS viewport and DPR');
}
const stateExpression = `({ viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, visibility: document.visibilityState, events: window.events, paint: window.paint, ready: window.fixtureReady })`;
const fixture = `<!doctype html><meta charset="utf-8"><title>ProfilePilot isolated capture/input regression</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:rgb(243,240,220)}#box{position:absolute;left:84px;top:84px;width:32px;height:32px;background:rgb(33,160,80);touch-action:none}#anchor{position:absolute;left:320px;top:50px;width:40px;height:40px;background:rgb(34,119,187)}</style>
<div id="box"></div><div id="anchor"></div><script>
window.events=[];window.paint={x:100,y:100};let dragging=false;
for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,event=>{
  events.push({type:event.type,x:event.clientX,y:event.clientY,buttons:event.buttons,trusted:event.isTrusted,target:event.target.id});
  if(type==='pointerdown')dragging=true;
  if(!dragging)return;
  const x=event.clientX,y=event.clientY;
  requestAnimationFrame(()=>{box.style.left=(x-16)+'px';box.style.top=(y-16)+'px';paint={x,y}});
  if(type==='pointerup')dragging=false;
});window.fixtureReady=true;
</script>`;
try {
  await daemon.start();
  started = true;
  checked(await request({ action: 'launch-profile', profileId: identity.sessionId, profileName: 'Isolated capture input regression', publicPort, executable,
    args: [`--user-data-dir=${path.join(temporaryRoot, 'chrome')}`, '--no-first-run', '--no-default-browser-check',
      // Preserve the managed pipe if an elevated Windows runner starts Chrome.
      ...(process.platform === 'win32' ? ['--do-not-de-elevate'] : [])] }));
  launched = true;
  const lease = checked(await request({ action: 'acquire', ...identity }));
  acquired = true;
  generation = lease.profile.controlGeneration;
  targetId = (await cdp('create-hidden-target', 'Target.createTarget', { url: 'data:text/html,' + encodeURIComponent(fixture), background: true })).targetId;
  assert.ok(targetId);
  report.targetId = targetId;
  let before;
  for (let attempt = 0; attempt < 20; attempt++) {
    before = await evaluate(`initial-state-${attempt}`, stateExpression);
    if (before.ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(before.ready, true, 'Fixture document must finish loading');
  assert.equal(before.visibility, 'hidden', 'The fixture must stay in a background tab');
  report.before = before;
  const initial = await screenshot('before-input');
  assertDimensions(initial, before.viewport);
  assert.deepEqual(sample(initial, before.viewport, 100, 100), [33, 160, 80], 'Initial box must be painted');
  assert.deepEqual(sample(initial, before.viewport, 340, 70), [34, 119, 187], 'Initial anchor must be painted');

  const input = (label, type, x, y, buttons, extra = {}) => cdp(label, 'Input.dispatchMouseEvent', { type, x, y, buttons, ...extra });
  await input('move-to-box', 'mouseMoved', 100, 100, 0);
  await input('mouse-down', 'mousePressed', 100, 100, 1, { button: 'left', clickCount: 1 });
  for (let step = 1; step <= 8; step++) {
    const coordinate = 100 + step * 15;
    if (step === 4 || step === 8) {
      const captureLabel = `during-drag-${step}`;
      // The external capture races the frame pulse generated by actual input.
      // Wait for both promises to settle before cleanup, including on failure.
      const pair = await Promise.allSettled([
        input(`drag-${step}`, 'mouseMoved', coordinate, coordinate, 1, { button: 'left' }),
        screenshot(captureLabel)
      ]);
      const failure = pair.find(item => item.status === 'rejected');
      if (failure) throw failure.reason;
      assertDimensions(pair[1].value, before.viewport);
      const move = report.records.find(item => item.label === `drag-${step}`);
      const capture = report.records.find(item => item.label === captureLabel);
      assert.ok(Math.max(move.startedMs, capture.startedMs) < Math.min(move.finishedMs, capture.finishedMs), 'Input and screenshot requests must overlap');
    } else {
      await input(`drag-${step}`, 'mouseMoved', coordinate, coordinate, 1, { button: 'left' });
    }
  }
  await input('mouse-up', 'mouseReleased', 220, 220, 0, { button: 'left', clickCount: 1 });
  const after = await evaluate('after-input-state', stateExpression);
  report.after = after;
  assert.equal(after.visibility, 'hidden', 'Input and captures must not activate the fixture tab');
  assert.deepEqual(after.viewport, before.viewport, 'Input frame pulses must not change viewport dimensions or DPR');
  assert.deepEqual(after.paint, { x: 220, y: 220 }, 'Input must flush the final rAF paint without a dummy click');
  assert.equal(after.events.filter(event => event.type === 'pointerdown').length, 1);
  assert.equal(after.events.filter(event => event.type === 'pointerup').length, 1);
  assert.equal(after.events.filter(event => event.type === 'pointermove' && event.buttons === 1).length, 8);
  assert.ok(after.events.every(event => event.trusted), 'All mouse events must be native trusted input');
  assert.equal(after.events.find(event => event.type === 'pointerdown').target, 'box', 'The drag must start on the actual painted box');
  assert.deepEqual(after.events.filter(event => event.type === 'pointermove' && event.buttons === 1).map(event => [event.x, event.y]),
    Array.from({ length: 8 }, (_, index) => [115 + index * 15, 115 + index * 15]), 'Input coordinates must stay in CSS pixels');
  const final = await screenshot('after-input');
  assertDimensions(final, before.viewport);
  assert.deepEqual([final.width, final.height], [initial.width, initial.height], 'Capture size must remain unchanged after input');
  report.pixels = { movedBox: sample(final, before.viewport, 220, 220), oldBox: sample(final, before.viewport, 100, 100), anchor: sample(final, before.viewport, 340, 70) };
  assert.deepEqual(report.pixels.movedBox, [33, 160, 80], 'Screenshot must show the final painted box');
  assert.deepEqual(report.pixels.oldBox, [243, 240, 220], 'Screenshot must clear the old box position');
  assert.deepEqual(report.pixels.anchor, [34, 119, 187], 'Static anchor must retain its position and color');
  const finalState = await evaluate('after-capture-state', stateExpression);
  assert.deepEqual(finalState.viewport, before.viewport);
  assert.equal(finalState.visibility, 'hidden');
  report.checks = { hiddenTab: true, trustedDrag: true, cssInputCoordinates: true, concurrentCapture: true, viewportUnchanged: true, fullSizeCaptures: true, visiblePaint: true };
  report.passed = true;
} catch (error) {
  report.error = { message: String(error), code: error.code, stack: error.stack };
} finally {
  async function cleanup(label, operation) {
    try {
      await operation();
      report.cleanup.push({ label, ok: true });
    } catch (error) {
      report.cleanup.push({ label, ok: false, error: String(error) });
      report.passed = false;
    }
  }
  // Cleanup is restricted to this temporary daemon and the profile we launched.
  if (acquired) await cleanup('complete', async () => checked(await request({ action: 'control', sessionId: identity.sessionId, command: 'complete' })));
  if (launched) await cleanup('unregister-profile', async () => checked(await request({ action: 'unregister-profile', publicPort, closeChrome: true })));
  if (started) await cleanup('stop-daemon', () => daemon.stop());
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, platform: report.platform, output, checks: report.checks, viewport: report.before?.viewport, pixels: report.pixels, error: report.error?.message, cleanup: report.cleanup }));
if (!report.passed) process.exitCode = 1;
