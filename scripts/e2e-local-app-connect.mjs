import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

const require = createRequire(import.meta.url);
const { BrowserGatewayDaemon } = require('../dist/main/browser-gateway-daemon');
const electronPath = require('electron');
const id = randomUUID();
const results = path.join(repoRoot, 'test-results', 'local-app-connect');
await mkdir(results, { recursive: true });
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const cdpPort = await freePort();
let agentPort = await freePort(); while (agentPort === cdpPort) agentPort = await freePort();
let app, daemon, target, project;
const quote = value => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  app = await launchProfilePilotE2e({
    env: { CPM_E2E_LOCAL_APP_GATEWAY: '1' },
    prepareFixture: async fixture => {
      project = path.join(fixture.fixtureRoot, 'Connect app');
      await mkdir(project);
      daemon = new BrowserGatewayDaemon(fixture.homeDir);
      await daemon.start();
      const source = path.join(project, 'main.cjs');
      await writeFile(source, `
        const { app, BrowserWindow } = require('electron');
        const fs = require('node:fs');
        const path = require('node:path');
        app.setPath('userData', path.join(__dirname, 'data'));
        app.disableHardwareAcceleration();
        if (process.platform === 'darwin') app.setActivationPolicy('accessory');
        const log = event => fs.appendFileSync(path.join(__dirname, 'events.jsonl'), JSON.stringify({event,pid:process.pid})+'\\n');
        app.on('before-quit', () => log('quit'));
        app.on('window-all-closed', () => app.quit());
        app.whenReady().then(async () => {
          const win = new BrowserWindow({show:false,focusable:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
          win.on('close', event => { log('close'); if (fs.existsSync(path.join(__dirname,'hold-exit'))) event.preventDefault(); });
          await win.loadURL('data:text/html,<title>Connection fixture</title><h1>Connection ready</h1>');
          fs.writeFileSync(path.join(__dirname,'state.json'),JSON.stringify({pid:process.pid}));
          log('ready');
        });
      `);
      await mkdir(path.join(fixture.dataDir, 'local-apps'), { recursive: true });
      await writeFile(path.join(fixture.dataDir, 'local-apps', 'apps.json'), JSON.stringify([{
        id, name: '连接流程测试应用', mode: 'launch', cwd: project,
        command: `${quote(electronPath)} --remote-debugging-port={cdpPort} --remote-debugging-address=127.0.0.1 ${quote(source)}`,
        environment: '', cdpPort, inspectPort: null, agentPort, createdAt: new Date().toISOString()
      }]));
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      target = spawn(electronPath, [source], { cwd: project, env, windowsHide: true, stdio: 'ignore' });
    }
  });
  const d = app.driver;
  const view = () => d.evaluate(`window.localApps.list().then(apps=>apps.find(app=>app.id===${JSON.stringify(id)}))`);
  const screenshot = async name => {
    await d.screenshot();
    await new Promise(resolve => setTimeout(resolve, 250));
    await writeFile(path.join(results, name), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  };
  await d.domClick('[data-pc-view="local-apps"]');
  await d.waitFor('.app-state.running', row => row.exists, { timeoutMs: 20000 });
  const original = JSON.parse(await readFile(path.join(project, 'state.json'), 'utf8')).pid;
  assert.equal((await view()).managed, false);
  assert.equal((await view()).debug.renderer, false);
  const openConfirmation = async () => {
    await d.domClick('.app-row-actions [data-action="connect"]');
    await d.waitFor('.app-connection-dialog [data-check]', button => button.text === '重启并连接' && !button.disabled, { timeoutMs: 20000 });
  };
  await openConfirmation();
  await screenshot('restart-confirmation.png');
  await d.domClick('.app-connection-dialog [data-close]');
  assert.ok(alive(original));
  assert.doesNotMatch(await readFile(path.join(project, 'events.jsonl'), 'utf8'), /"close"|"quit"/);

  // Simulate an application's unsaved-document prompt cancelling the quit.
  await writeFile(path.join(project, 'hold-exit'), 'unsaved');
  await openConfirmation();
  await d.domClick('.app-connection-dialog [data-check]');
  await d.waitFor('.connection-result[data-error="true"]', result => result.text?.includes('尚未退出'), { timeoutMs: 35000 });
  assert.doesNotMatch((await d.query('.connection-result')).text, /Error invoking remote method/);
  assert.ok(alive(original));
  assert.equal(JSON.parse(await readFile(path.join(project, 'state.json'), 'utf8')).pid, original);
  await screenshot('exit-cancelled.png');
  await d.domClick('.app-connection-dialog [data-close]');
  await unlink(path.join(project, 'hold-exit'));

  await openConfirmation();
  await d.domClick('.app-connection-dialog [data-check]');
  await d.waitFor('.app-connection-dialog', result => !result.exists, { timeoutMs: 60000 });
  await d.waitFor('.app-availability.connected', result => result.text.includes('可操作'), { timeoutMs: 15000 });
  assert.equal(alive(original), false);
  const connected = await view();
  assert.equal(connected.runtime.status, 'running');
  assert.equal(connected.debug.renderer, true);
  assert.equal(connected.agent.connected, true);
  const relaunched = JSON.parse(await readFile(path.join(project, 'state.json'), 'utf8')).pid;
  assert.notEqual(relaunched, original);
  assert.ok(alive(relaunched));
  await screenshot('connected.png');
  const events = await readFile(path.join(project, 'events.jsonl'), 'utf8');
  assert.match(events, /"quit"/);
  // A ready application's public connection API must connect without a restart.
  assert.deepEqual(await d.evaluate(`window.localApps.connect(${JSON.stringify(id)})`), { status: 'connected' });
  assert.equal(await readFile(path.join(project, 'events.jsonl'), 'utf8'), events);
  assert.ok((await d.windows()).all.every(window => !window.visible && !window.focused));
  console.log('PASS connection UI: automatic check, explicit confirmation, cancellation, refused quit without force, real graceful restart, verified Agent connection, and direct reconnect.');
} catch (error) {
  if (app) {
    await writeFile(path.join(results, 'failure.png'), Buffer.from((await app.driver.screenshot()).pngBase64, 'base64')).catch(() => {});
    console.error(await app.driver.evaluate('document.querySelector(".app-connection-dialog")?.textContent').catch(() => ''));
    console.error(await readFile(path.join(project, 'events.jsonl'), 'utf8').catch(() => ''));
    console.error(await app.driver.evaluate(`window.localApps.list().then(apps=>apps.find(app=>app.id===${JSON.stringify(id)})?.runtime)`).catch(() => ''));
  }
  throw error;
} finally {
  if (app) {
    await app.driver.evaluate(`window.localApps.stop(${JSON.stringify(id)})`).catch(() => {});
    await app.stop({ removeFixture: false });
  }
  if (target && target.exitCode === null) target.kill();
  await daemon?.stop();
  if (app) {
    assert.ok(path.resolve(app.fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(app.fixtureRoot, { recursive: true, force: true, maxRetries: 0 }).catch(() => {});
  }
}
