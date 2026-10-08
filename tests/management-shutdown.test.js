const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter, once } = require('node:events');
const { loadTsModule } = require('./helpers/load-ts-module');

function loadServer(stubs = {}) {
  return loadTsModule('src/main/profilepilot-management-server.ts', { stubs: { './tasks/management': {}, ...stubs } });
}
function options(t) {
  // Short enough for macOS's Unix socket path limit; Windows uses a hashed pipe.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ms-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { profileManager: {}, homeDir: root, env: { PROFILEPILOT_MANAGEMENT_ROOT: root } };
}

test('management close disconnects an incomplete request immediately and is idempotent', async t => {
  const server = await loadServer().startProfilePilotManagementServer(options(t));
  const client = net.createConnection(server.socketPath); client.on('error', () => {});
  t.after(() => { client.destroy(); return server.close(); });
  await once(client, 'connect');
  const disconnected = once(client, 'close');
  client.write('{');
  await new Promise(resolve => setImmediate(resolve));
  const closing = server.close();
  assert.equal(server.close(), closing);
  // A socket's normal idle timeout is 125s. Closing must not wait for it.
  await Promise.race([closing, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('management close waited for idle timeout')), 1000);
    closing.finally(() => clearTimeout(timer));
  })]);
  await disconnected;
  assert.equal(client.destroyed, true);
  if (process.platform !== 'win32') assert.equal(fs.existsSync(server.socketPath), false);
});

test('management close also drops a client waiting on a pending authorized command', async t => {
  let release;
  const commandStarted = new Promise(resolve => release = resolve);
  let entered;
  const called = new Promise(resolve => entered = resolve);
  const opts = options(t);
  opts.profileManager.getState = async () => { entered(); return commandStarted; };
  const server = await loadServer().startProfilePilotManagementServer(opts);
  const client = net.createConnection(server.socketPath); client.on('error', () => {});
  t.after(async () => { client.destroy(); await server.close(); });
  await once(client, 'connect');
  client.write(JSON.stringify({ version: 1, id: 'pending', token: fs.readFileSync(path.join(opts.homeDir, 'secret'), 'utf8').trim(), command: { action: 'profile.list' } }) + '\n');
  await called;
  const disconnected = once(client, 'close');
  await server.close(); await disconnected;
  assert.equal(client.destroyed, true);
  release({ profiles: [] });
});

test('a lost server close callback times out and late connections cannot start commands', async t => {
  let onConnection;
  const fake = new EventEmitter();
  fake.listen = (_path, ready) => ready();
  fake.close = () => {};
  const server = await loadServer({ 'node:net': { createServer: callback => { onConnection = callback; return fake; } } }).startProfilePilotManagementServer(options(t));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closing = server.close();
  let destroyed = false;
  onConnection({ destroy: () => { destroyed = true; } });
  assert.equal(destroyed, true);
  t.mock.timers.tick(2000);
  await assert.rejects(closing, error => error.code === 'MANAGEMENT_CLOSE_TIMEOUT');
});
