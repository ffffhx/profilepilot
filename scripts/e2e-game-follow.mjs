import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ElectronDriver, delay, repoRoot } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const fixture = await mkdtemp(path.join(os.tmpdir(), 'pp-follow-ui-'));
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\pp-follow-ui-${process.pid}` : path.join(fixture, 'driver.sock');
const output = path.join(repoRoot, 'artifacts/game-follow'); await mkdir(output, { recursive: true });
const child = spawn(require('electron'), [path.join(repoRoot, 'scripts/e2e/fixtures/phone-ui-main.cjs')], {
  cwd: repoRoot, windowsHide: true, env: { ...process.env, PHONE_UI_FIXTURE: fixture, PHONE_UI_SOCKET: socket, PHONE_UI_GAME_FOLLOW: '1' },
  stdio: ['ignore', 'pipe', 'pipe'] });
let driver, logs = '';
child.stdout.on('data', v => logs += v); child.stderr.on('data', v => logs += v);
try {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(logs);
    try { driver = new ElectronDriver(await new Promise((resolve, reject) => { const c = net.createConnection(socket); c.once('connect', () => resolve(c)); c.once('error', error => { c.destroy(); reject(error); }); })); break; }
    catch { await delay(100); }
  }
  assert.ok(driver, logs);
  await driver.waitFor('[data-phone-row="UI-TEST-1"] .phone-device-link');
  await driver.domClick('[data-phone-row="UI-TEST-1"] .phone-device-link');
  await driver.waitFor('[data-action="game-follow"]');
  await driver.domClick('[data-action="game-follow"]');
  await driver.waitFor('[data-gf-runtime]', e => e.text.includes('已就绪'));
  await driver.domClick('[data-gf-demo]');
  await driver.waitFor('[data-gf-source]', e => e.text.includes('演示地图'));
  await driver.request('resize', {width:1200,height:650}); await delay(150);
  const layout = await driver.evaluate(`(() => {
    const c=document.querySelector('[data-gf-canvas]'), r=c.getBoundingClientRect();
    const stop=document.querySelector('[data-gf-stop]').getBoundingClientRect();
    return {ratio:r.width/r.height, expected:c.width/c.height, stopBottom:stop.bottom, viewport:innerHeight};
  })()`);
  assert.ok(Math.abs(layout.ratio-layout.expected)<.001,'calibration coordinates must match the visible image');
  assert.ok(layout.stopBottom<=layout.viewport,'stop must remain visible without scrolling the dialog');
  await driver.domClick('[data-gf-analyze]');
  await driver.waitFor('[data-gf-status]', e => e.text.includes('连续确认'));
  await driver.domClick('[data-gf-analyze]');
  await driver.waitFor('[data-gf-status]', e => e.text.includes('沿路线'));
  await driver.domClick('[data-gf-save]');
  await driver.waitFor('[data-gf-saved]', e => e.text.includes('已保存'));
  const initial = await driver.evaluate('document.querySelector("[data-gf-canvas]").toDataURL()');
  await driver.domClick('[data-gf-replay]');
  await delay(1800);
  const changed = await driver.evaluate('document.querySelector("[data-gf-canvas]").toDataURL()');
  assert.notEqual(changed, initial, 'demo must actually move pixels through the real OpenCV loop');
  await writeFile(path.join(output, 'desktop-demo.png'), Buffer.from((await driver.screenshot()).pngBase64, 'base64'));
  await driver.domClick('[data-gf-stop]');
  await driver.waitFor('[data-gf-stop]', e => e.disabled);
  const current = await driver.evaluate('document.querySelector("[data-gf-canvas]").toDataURL()');
  await delay(650);
  assert.equal(await driver.evaluate('document.querySelector("[data-gf-canvas]").toDataURL()'), current);
  await driver.domClick('[data-gf-close]');
  await driver.waitFor('.game-follow-dialog', e => !e.exists);
  await driver.domClick('[data-action="game-follow"]');
  await driver.waitFor('[data-gf-name]', e => e.value === '演示地图');
  await driver.waitFor('[data-gf-runtime]', e => e.text.includes('已就绪'));
  await driver.waitFor('[data-gf-capture]', e => !e.disabled);

  // Exercise the actual renderer with asymmetric, lossless crop pixels. The
  // synthetic phone response retains physical screen dimensions and a nonzero origin.
  await driver.evaluate(`(() => {
    const make = (width, height, paint) => {
      const c=document.createElement('canvas'); c.width=width; c.height=height;
      paint(c.getContext('2d'));
      return {mime:'image/png',width,height,base64:c.toDataURL('image/png').split(',')[1]};
    };
    const fullFrame=make(1280,720,g=>{g.fillStyle='#203040';g.fillRect(0,0,1280,720);});
    const crop=make(240,160,g=>{
      g.fillStyle='#173d70';g.fillRect(0,0,240,160);
      g.fillStyle='#f97316';g.fillRect(0,0,24,24);
      g.fillStyle='#22c55e';g.fillRect(216,136,24,24);
    });
    return window.phones.followCommand({op:'fixture-follow-frame',fullFrame,
      frame:{...crop,width:1280,height:720,region:{x:96,y:144,width:240,height:160}}});
  })()`);
  const canvasState = () => driver.evaluate(`(() => {
    const c=document.querySelector('[data-gf-canvas]'),g=c.getContext('2d');
    const pixel=(x,y)=>Array.from(g.getImageData(x,y,1,1).data);
    return {width:c.width,height:c.height,origin:pixel(104,152),center:pixel(216,224),
      opposite:pixel(328,296),outside:pixel(8,8),
      tools:Array.from(document.querySelectorAll('[data-gf-tool]'),b=>b.disabled)};
  })()`);
  await driver.domClick('[data-gf-capture]');
  await driver.waitFor('[data-gf-capture]', e => !e.disabled);
  assert.ok((await canvasState()).tools.every(disabled=>!disabled),'full screenshot enables calibration');
  await driver.domClick('[data-gf-tool="joystick"]');
  const calibrated = await driver.evaluate(`window.phones.followCommand({op:'load'})`);
  await driver.domClick('[data-gf-observe]');
  await driver.waitFor('[data-gf-source]', e => e.text.includes('仅更新小地图'));
  const roi = await canvasState();
  assert.deepEqual([roi.width,roi.height],[1280,720],'crop must preserve the full physical canvas coordinate system');
  assert.deepEqual(roi.origin,[249,115,22,255],'top-left crop marker must appear at its nonzero physical origin');
  assert.deepEqual(roi.center,[23,61,112,255],'crop pixels must not be stretched to screen size');
  assert.deepEqual(roi.opposite,[34,197,94,255],'opposite crop corner must preserve its physical position');
  assert.deepEqual(roi.outside,[17,24,39,255],'pixels outside the live crop must not pretend to be a current full screenshot');
  assert.ok(roi.tools.every(Boolean),'calibration tools are disabled while the crop is displayed');
  await driver.domClick('[data-gf-stop]');
  await driver.waitFor('[data-gf-stop]', e => e.disabled);
  assert.ok((await canvasState()).tools.every(Boolean),'stopping cannot enable calibration on incomplete screen pixels');
  const pointerCaptures = await driver.evaluate(`(() => {
    const c=document.querySelector('[data-gf-canvas]'),r=c.getBoundingClientRect();
    const original=c.setPointerCapture;let captures=0;
    // A synthetic pointer has no native capture slot. Count capture attempts so
    // a missing crop guard cannot pass merely because native capture throws.
    c.setPointerCapture=()=>{captures++;};
    try {
      c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,
        clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
      c.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:1}));
      return captures;
    } finally {c.setPointerCapture=original;}
  })()`);
  assert.equal(pointerCaptures,0,'cropped canvas rejects pointer input before capture');
  await driver.domClick('[data-gf-save]');
  await driver.waitFor('[data-gf-save]', e => !e.disabled);
  const afterClick = await driver.evaluate(`window.phones.followCommand({op:'load'})`);
  assert.deepEqual(afterClick.joystick,calibrated.joystick,'canvas pointer input cannot change calibration after a cropped run stops');
  await driver.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(100);
  await writeFile(path.join(output,'desktop-cropped-preview.png'),Buffer.from((await driver.screenshot()).pngBase64,'base64'));

  await driver.domClick('[data-gf-capture]');
  await driver.waitFor('[data-gf-capture]', e => !e.disabled);
  const full = await canvasState();
  assert.deepEqual([full.width,full.height],[1280,720]);
  assert.deepEqual(full.outside,[32,48,64,255],'fetching a full screenshot replaces the crop-only background');
  assert.ok(full.tools.every(disabled=>!disabled),'fresh full pixels restore calibration tools');
  assert.ok(!(await driver.query('[data-gf-source]')).text.includes('仅更新小地图'));

  // Invalid response metadata must not resize or replace the last valid canvas.
  for (const region of [{x:96,y:144,width:239,height:160},{x:1200,y:144,width:240,height:160}]) {
    const beforeInvalid = await driver.evaluate('document.querySelector("[data-gf-canvas]").toDataURL()');
    await driver.evaluate(`(() => {
      const c=document.createElement('canvas');c.width=240;c.height=160;
      c.getContext('2d').fillRect(0,0,240,160);
      return window.phones.followCommand({op:'fixture-follow-frame',frame:{mime:'image/png',
        width:1280,height:720,base64:c.toDataURL('image/png').split(',')[1],region:${JSON.stringify(region)}}});
    })()`);
    await driver.domClick('[data-gf-observe]');
    await driver.waitFor('[data-gf-status]', e => e.text.includes('小地图画面尺寸无效'));
    assert.equal(await driver.evaluate('document.querySelector("[data-gf-canvas]").toDataURL()'),beforeInvalid,
      'mismatched or out-of-bounds crop must leave the last valid full canvas intact');
    assert.deepEqual([(await canvasState()).width,(await canvasState()).height],[1280,720]);
    await driver.domClick('[data-gf-stop]');
    await driver.waitFor('[data-gf-stop]', e => e.disabled);
  }
  await driver.domClick('[data-gf-close]');
  await driver.waitFor('.game-follow-dialog', e => !e.exists);

  // An external (for example CLI-owned) follow run must also suspend an already
  // open live inspector. Real service snapshots drive both renderer views.
  await driver.waitFor('[data-action="enlarge-phone-screen"]', e => !e.disabled);
  await driver.domClick('[data-action="enlarge-phone-screen"]');
  await driver.waitFor('.phone-image-dialog[open]');
  const screenCalls = () => driver.evaluate(`window.phones.followCommand({op:'fixture-follow-screen-calls'})`);
  const beforeLive = await screenCalls();
  await delay(700);
  assert.ok(await screenCalls() > beforeLive, 'open inspector must actually refresh before follow owns capture');
  const external = await driver.evaluate(`window.phones.followCommand({op:'start',id:'UI-TEST-1',mode:'observe',backend:'app'})`);
  await driver.waitFor('.phone-inspector-caption', e => e.text.includes('视觉跟随期间暂停预览'));
  await driver.waitFor('.phone-image-dialog p', e => e.text.includes('视觉跟随期间暂停预览'));
  assert.equal((await driver.query('[data-action="refresh-phone-screen"]')).disabled, true);
  const suppressedAt = await screenCalls();
  await delay(2200);
  assert.equal(await screenCalls(), suppressedAt, 'follow ownership suppresses both the 500ms live timer and normal sidebar refresh');
  assert.equal(await driver.evaluate('document.querySelector(".phone-image-dialog img").hidden'), true,
    'an older full screenshot must not remain presented as a live preview');
  await driver.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(100);
  await writeFile(path.join(output,'desktop-follow-preview-paused.png'),Buffer.from((await driver.screenshot()).pngBase64,'base64'));
  await driver.evaluate(`window.phones.followCommand({op:'stop',runId:${JSON.stringify(external.runId)}})`);
  await driver.waitFor('.phone-image-dialog p', e => e.text.includes('实时更新'));
  assert.ok(await screenCalls() > suppressedAt, 'ending follow resumes screenshot requests for the existing preview');
  assert.equal(await driver.evaluate('document.querySelector(".phone-image-dialog img").hidden'), false);
  await driver.domClick('.phone-image-dialog button');
  await driver.waitFor('.phone-image-dialog', e => !e.exists);
  console.log('PASS: real OpenCV demo, persistence, crop origin and physical dimensions, calibration lock/recovery, invalid crop rejection, live/sidebar preview suppression and resume, and dialog cleanup. Phone I/O is mocked; this is not hardware acceptance.');
} finally {
  if (driver) await driver.request('quit').catch(() => {});
  for (let i=0; i<30 && child.exitCode===null; i++) await delay(100);
  if (child.exitCode === null) child.kill();
}
