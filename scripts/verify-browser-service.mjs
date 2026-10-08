import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { BrowserServiceClient } = require('../dist/main/browser-service/client');
const { readBrowserServiceConnection, processAlive } = require('../dist/main/browser-service/connection');
const { NATIVE_REQUIRED_CAPABILITIES } = require('../dist/main/tasks/native-compatibility');
const { NATIVE_EXTENSION_ID } = require('../dist/main/tasks/native-bridge');
const root = mkdtempSync(path.join(os.tmpdir(), 'pp-service-process-'));
const cli = path.resolve('dist/main/profilepilot-cli.cjs');
const run = (...args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, 'browser', ...args, '--root', root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timed out: ' + args[0])); }, 35000);
  child.once('error', reject); child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(stdout).result) : reject(new Error(stderr)); });
});
async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}
function extension(config) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: config.port, path: '/profilepilot', headers: {
      Origin: `chrome-extension://${NATIVE_EXTENSION_ID}`, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
    } });
    req.on('error', reject); req.on('response', () => reject(new Error('Extension transport rejected')));
    req.on('upgrade', (_res, socket, head) => {
      let buffer = head, owner, ownership = 'user';
      const send = value => {
        const data = Buffer.from(JSON.stringify(value)), mask = randomBytes(4), header = Buffer.alloc(data.length < 126 ? 2 : 4);
        header[0] = 0x81; header[1] = 0x80 | (data.length < 126 ? data.length : 126);
        if (data.length >= 126) header.writeUInt16BE(data.length, 2);
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        socket.write(Buffer.concat([header, mask, data]));
      };
      const publish = () => send({ type: 'state', state: { ownership, sessionId: owner, taskTabs: true, extensionVersion: '0.2.3',
        capabilities: NATIVE_REQUIRED_CAPABILITIES, tabId: 7, controlGeneration: 'fixture:1' } });
      const timer = setInterval(() => send({ type: 'heartbeat' }), 5000);
      socket.on('error', reject); socket.on('close', () => clearInterval(timer));
      const receive = message => {
        if (message.type === 'welcome') { publish(); resolve({ close: () => socket.destroy() }); return; }
        if (!message.id) return;
        if (message.method === 'claim') { owner = message.params.sessionId; ownership = 'agent'; publish(); }
        if (message.method === 'control') { owner = undefined; ownership = 'user'; publish(); }
        send({ id: message.id, result: message.method === 'tabs' ? [{ id: '7', title: 'independent-service-fixture' }] : {} });
      };
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          let length = buffer[1] & 127, offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer.length < offset + length) return;
          const opcode = buffer[0] & 15, data = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length);
          if (opcode === 8) { socket.end(); return; }
          if (opcode === 1) receive(JSON.parse(data.toString('utf8')));
        }
      });
      send({ type: 'hello', ...config });
    }); req.end();
  });
}

let desktop, peer, connection;
try {
  const results = await Promise.all(Array.from({ length: 3 }, () => run('status')));
  assert.ok(results.every(result => result.profiles.length === 0));
  connection = readBrowserServiceConnection(root);
  assert.notEqual(connection.pid, process.pid);
  assert.ok(processAlive(connection.pid), 'service survives all launching CLI processes');
  const identity = await run('service', 'status'); assert.equal(identity.pid, connection.pid);
  console.log('Concurrent CLI startup: one independent service, launcher processes exited.');

  const pairing = await run('pair', '--profile', 'native:Default');
  const config = JSON.parse(Buffer.from(pairing.code.slice(4), 'base64url'));
  peer = await extension(config);
  await until(async () => (await run('status')).profiles[0]?.taskTabs, 'extension state not received');
  assert.equal(readFileSync(path.join(root, 'native-browser-credentials.bin')).includes(Buffer.from(config.token)), false);
  await run('claim', '--session', 'process-fixture', '--profile', 'native:Default', '--tab', '7');
  desktop = new BrowserServiceClient(root); await desktop.start();
  assert.equal(desktop.isDirectSession('native:Default', 'process-fixture'), true); desktop.close(); desktop = undefined;
  assert.equal((await run('tabs', '--session', 'process-fixture'))[0].id, '7');
  assert.equal((await run('status')).sessions[0].sessionId, 'process-fixture');
  await assert.rejects(run('service', 'stop'), /仍有浏览器会话/);
  console.log('App client exit: CLI session, extension connection and browser operations preserved.');

  await run('release', '--session', 'process-fixture');
  peer.close(); peer = undefined;
  await until(async () => !(await run('status')).profiles[0]?.connected, 'extension did not disconnect');
  desktop = new BrowserServiceClient(root); await desktop.start();
  await run('service', 'stop');
  await until(() => !processAlive(connection.pid), 'service did not exit');
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal((await run('service', 'status')).running, false, 'App polling must honor an explicit service stop');
  await run('status');
  const restarted = readBrowserServiceConnection(root); assert.notEqual(restarted.pid, connection.pid); connection = restarted;
  assert.equal(restarted.port, config.port, 'paired port remains unchanged');
  peer = await extension(config);
  await until(async () => (await run('status')).profiles[0]?.taskTabs, 'saved pairing did not reconnect');
  await until(() => desktop.states()[0]?.connected, 'App did not reconnect to the restarted service');
  desktop.close(); desktop = undefined;
  assert.equal((await run('status')).sessions.length, 0);
  console.log('Service restart: encrypted pairing and port preserved; no old actions replayed.');
  peer.close(); peer = undefined;
  await until(async () => !(await run('status')).profiles[0]?.connected, 'extension did not disconnect');
  await run('service', 'stop'); await until(() => !processAlive(connection.pid), 'service did not exit');
  console.log(JSON.stringify({ ok: true, platform: process.platform, checks: ['concurrent-cold-start', 'independent-process', 'app-client-exit', 'cli-session-preserved', 'encrypted-pairing-restart'] }));
} finally {
  desktop?.close(); peer?.close();
  connection ||= readBrowserServiceConnection(root);
  if (connection && processAlive(connection.pid)) {
    try { await run('service', 'stop'); } catch { process.kill(connection.pid); }
    await until(() => !processAlive(connection.pid), 'fixture service still running');
  }
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  rmSync(root, { recursive: true, force: true });
}
