import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ElectronDriver, delay, repoRoot } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const fixture = await mkdtemp(path.join(os.tmpdir(), 'pp-camera-ui-'));
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\pp-camera-ui-${process.pid}` : path.join(fixture, 'driver.sock');
const output = path.join(repoRoot, 'artifacts/screen-camera'); await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'qr.png'), await require('qrcode').toBuffer('ProfilePilot UI fixture', { width: 480, margin: 4 }));
const child = spawn(require('electron'), [path.join(repoRoot, 'scripts/e2e/fixtures/phone-ui-main.cjs')], {
  cwd: repoRoot, windowsHide: true, env: { ...process.env, PHONE_UI_FIXTURE: fixture, PHONE_UI_SOCKET: socket, PHONE_UI_CAMERA: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let d, logs = ''; child.stdout.on('data', v => logs += v); child.stderr.on('data', v => logs += v);
try {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error(logs);
    try { d = new ElectronDriver(await new Promise((resolve, reject) => { const c = net.createConnection(socket); c.once('connect', () => resolve(c)); c.once('error', e => { c.destroy(); reject(e); }); })); break; } catch { await delay(100); }
  }
  assert.ok(d, logs); await d.waitFor('[data-action="screen-camera"]');
  await d.domClick('[data-action="screen-camera"]'); await d.waitFor('.screen-camera-columns', e => !('hidden' in e.attributes));
  assert.equal((await d.query('[data-source]')).value, 'window:camera-fixture:0');
  const crop = await d.query('[data-crop]');
  await d.evaluate(`(()=>{const c=document.querySelector('[data-crop]'), r=c.getBoundingClientRect();c.setPointerCapture=()=>{};c.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,clientX:r.left+r.width*.1,clientY:r.top+r.height*.2}));c.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:r.left+r.width*.8,clientY:r.top+r.height*.9}));c.dispatchEvent(new PointerEvent('pointerup',{pointerId:1}));return true;})()`);
  await writeFile(path.join(output, 'ui-selection.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  await d.domClick('[data-start]'); await d.waitFor('[data-controls]', e => !('hidden' in e.attributes));
  const calls = await d.evaluate('window.cameraFixture.calls()');
  const started = calls.find(c => c.method === 'camera-start'); assert.ok(started.sessionId); assert.equal(started.sourceId, 'window:camera-fixture:0');
  assert.ok(Math.abs(started.crop.width - .7) < .01, JSON.stringify(started.crop)); assert.ok(Math.abs(started.crop.y - .2) < .01, JSON.stringify(started.crop));
  await d.domClick('[data-launch]'); await d.waitFor('[data-phone]', e => !!e.attributes.src);
  assert.ok((await d.evaluate('window.cameraFixture.calls()')).some(c => c.op === 'launch' && c.component === 'com.tencent.mm/.ui.LauncherUI'));
  await writeFile(path.join(output, 'ui-running-fixture.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  await d.domClick('[data-stop]'); await d.waitFor('[data-start]', e => !e.disabled);
  assert.ok((await d.evaluate('window.cameraFixture.calls()')).some(c => c.op === 'stop'));
  assert.equal(await d.evaluate('(async()=> (await window.phones.snapshot()).devices.find(d=>d.id==="UI-TEST-1").state.phase)()'), 'stopped');
  await d.domClick('[data-close]'); await d.waitFor('.screen-camera-dialog', e => !e.exists);
  await d.evaluate('window.cameraFixture.unsupported(true)');
  await d.domClick('[data-action="screen-camera"]'); await d.waitFor('[data-status]', e => e.text.includes('不支持'));
  assert.equal(await d.evaluate('document.querySelector(".screen-camera-columns").hidden'), true);
  await d.domClick('[data-close]');
  console.log('PASS: camera UI source selection, crop, session, app launch, stop cleanup and unsupported device. Android camera is explicitly mocked in this UI test.');
} finally { if (d) await d.request('quit').catch(() => {}); if (child.exitCode === null) child.kill(); }
