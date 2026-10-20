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
  cwd: repoRoot, windowsHide: true, env: { ...process.env, PHONE_UI_FIXTURE: fixture, PHONE_UI_SOCKET: socket },
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
  await driver.domClick('[data-gf-close]');
  console.log('PASS: real OpenCV analysis, route preview, animated feedback, stop, persistence, and dialog cleanup. Phone I/O is mocked.');
} finally {
  if (driver) await driver.request('quit').catch(() => {});
  for (let i=0; i<30 && child.exitCode===null; i++) await delay(100);
  if (child.exitCode === null) child.kill();
}
