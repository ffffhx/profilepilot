import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { loadCli } = require('./cli-test-build.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { resolveAppRuntime } = loadCli('src/main/local-apps/runtime.ts');
const { idleRuntime, parseEnvironment, buildMacDeveloperPath, launchCommand } = loadCli('src/main/local-apps/protocol.ts');
const { LocalAppsService } = loadCli('src/main/local-apps/service.ts');
const { executeLocalAppManagementCommand } = loadCli('src/main/local-apps/management.ts');
const { requestAppQuit } = loadCli('src/main/local-apps/quit.ts');

test('resolveAppRuntime grants managed stop/restart for supervised mode:"service" and blocks external processes', () => {
  const config = {
    id: randomUUID(),
    name: 'Backend API',
    mode: 'service',
    cwd: '/srv/api',
    command: 'npm start',
    environment: '',
    cdpPort: null,
    inspectPort: null,
    agentPort: null,
    servicePort: 8080,
    serviceProcess: '/srv/api/server.js',
    createdAt: new Date().toISOString()
  };

  // Supervised running service -> managed: true, stop: true, restart: true
  const managedRunning = resolveAppRuntime(
    config,
    { ...idleRuntime(), status: 'running', pid: 4001, startedAt: '2026-11-17T00:00:00.000Z' },
    { ...idleRuntime(), status: 'running', pid: 4002, serviceReady: true },
    []
  );
  assert.equal(managedRunning.managed, true);
  assert.equal(managedRunning.runtime.status, 'running');
  assert.equal(managedRunning.runtime.pid, 4001);
  assert.deepEqual(managedRunning.controls, { start: false, stop: true, restart: true });

  // Supervised starting service -> managed: true, stop: true, restart: false
  const managedStarting = resolveAppRuntime(
    config,
    { ...idleRuntime(), status: 'starting', pid: 4001 },
    idleRuntime(),
    []
  );
  assert.equal(managedStarting.managed, true);
  assert.deepEqual(managedStarting.controls, { start: false, stop: true, restart: false });

  // External running service -> managed: false, stop: false, restart: false
  const externalRunning = resolveAppRuntime(
    config,
    idleRuntime(),
    { ...idleRuntime(), status: 'running', pid: 5000, serviceReady: true },
    []
  );
  assert.equal(externalRunning.managed, false);
  assert.deepEqual(externalRunning.controls, { start: false, stop: false, restart: false });

  // Stopped service -> start: true
  const stopped = resolveAppRuntime(config, idleRuntime(), idleRuntime(), []);
  assert.equal(stopped.managed, false);
  assert.deepEqual(stopped.controls, { start: true, stop: false, restart: false });
});

test('parseEnvironment loads cwd/.env, supports export and quotes, and lets explicit overrides win', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dotenv-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(dir, '.env'),
    [
      '# Comment line',
      'API_URL="http://127.0.0.1:4000"',
      "export SECRET_KEY='s3cr3t=val'",
      'PLAIN_VAR=hello_world'
    ].join('\n'),
    'utf8'
  );

  const parsed = parseEnvironment('export API_URL="http://127.0.0.1:5000"\nEXTRA=\'yes\'', { cwd: dir });
  assert.equal(parsed.API_URL, 'http://127.0.0.1:5000');
  assert.equal(parsed.SECRET_KEY, 's3cr3t=val');
  assert.equal(parsed.PLAIN_VAR, 'hello_world');
  assert.equal(parsed.EXTRA, 'yes');
});

test('buildMacDeveloperPath and launchCommand enrich developer toolchains on darwin', t => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mac-home-'));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  const nvmNode22 = path.join(fakeHome, '.nvm', 'versions', 'node', 'v22.11.0', 'bin');
  const nvmNode20 = path.join(fakeHome, '.nvm', 'versions', 'node', 'v20.10.0', 'bin');
  fs.mkdirSync(nvmNode22, { recursive: true });
  fs.mkdirSync(nvmNode20, { recursive: true });

  const env = { HOME: fakeHome.replaceAll('\\', '/'), PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' };
  const macPath = buildMacDeveloperPath(env);
  const parts = macPath.split(':');
  assert.ok(parts.includes('/opt/homebrew/bin'));
  assert.ok(parts.includes('/usr/local/bin'));
  assert.ok(parts.indexOf(parts.find(p => p.includes('v22.11.0'))) < parts.indexOf(parts.find(p => p.includes('v20.10.0'))));

  const cmd = launchCommand(
    {
      id: randomUUID(), name: 'App', mode: 'launch', cwd: '/tmp',
      command: 'electron . --remote-debugging-port={cdpPort}', environment: '',
      cdpPort: 9333, inspectPort: null, createdAt: ''
    },
    'darwin',
    env
  );
  assert.equal(cmd.executable, '/bin/zsh');
  assert.deepEqual(cmd.args, ['-lc', 'electron . --remote-debugging-port=9333']);
  assert.ok(env.PATH.includes('/opt/homebrew/bin'));
});

test('LocalAppsService.logs preserves UTF-8 multi-byte boundaries across 128KiB truncation and supports tailLines + grep', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-service-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const projectDir = path.join(dir, 'service-proj');
  fs.mkdirSync(projectDir, { recursive: true });
  const customLog = path.join(projectDir, 'service.log');

  const service = new LocalAppsService(path.join(dir, 'store'));
  const id = await service.save({
    name: 'UTF8 Service',
    mode: 'service',
    cwd: projectDir,
    command: 'node server.js',
    environment: '',
    cdpPort: null,
    inspectPort: null,
    servicePort: 18420,
    serviceProcess: path.join(projectDir, 'server.js'),
    logPath: customLog
  });

  // Construct > 128 KiB log with 3-byte UTF-8 CJK ('中') and 4-byte emoji ('🚀') straddling the (size - 131072) offset
  const prefix = 'A'.repeat(5001) + '中文日志测试🚀'.repeat(11000) + '\n';
  const tail = [
    '\x1b[32m[INFO]\x1b[0m boot sequence 1',
    '\x1b[31m[ERROR]\x1b[0m database connection retry 1',
    '[INFO] health check ok',
    '\x1b[31m[ERROR]\x1b[0m database connection retry 2'
  ].join('\n') + '\n';
  fs.writeFileSync(customLog, prefix + tail, 'utf8');
  assert.ok(fs.statSync(customLog).size > 128 * 1024);

  const fullTail = service.logs(id);
  assert.equal(fullTail.includes('\uFFFD'), false, 'must never emit broken UTF-8 replacement char');
  assert.equal(fullTail.includes('\x1b['), false, 'must strip ANSI escape codes');
  assert.ok(fullTail.endsWith('[ERROR] database connection retry 2\n'));

  const lastTwo = service.logs(id, { tailLines: 2 });
  assert.equal(lastTwo, '[INFO] health check ok\n[ERROR] database connection retry 2\n');

  const errorsOnly = service.logs(id, { grep: '[ERROR]', tailLines: 1 });
  assert.equal(errorsOnly, '[ERROR] database connection retry 2\n');
});

test('dual-stack assertPortFree detects listeners on both 127.0.0.1 and ::1', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dualstack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = new LocalAppsService(dir);

  const ipv4Server = net.createServer();
  await new Promise(resolve => ipv4Server.listen(0, '127.0.0.1', resolve));
  t.after(() => ipv4Server.close());
  const v4Port = ipv4Server.address().port;
  await assert.rejects(service.assertPortFree(v4Port), /已被占用/);

  const ipv6Server = net.createServer();
  const v6Supported = await new Promise(resolve => {
    ipv6Server.once('error', () => resolve(false));
    ipv6Server.listen({ port: 0, host: '::1', ipv6Only: true }, () => resolve(true));
  });
  if (v6Supported) {
    t.after(() => ipv6Server.close());
    const v6Port = ipv6Server.address().port;
    await assert.rejects(service.assertPortFree(v6Port), /已被占用/);
  }
});

test('executeLocalAppManagementCommand dispatches start, stop, restart, and logs for service-mode apps', async () => {
  const id = randomUUID();
  const events = [];
  let status = 'stopped';
  const makeView = () => ({
    id,
    name: 'My Service',
    mode: 'service',
    cwd: '/srv',
    command: 'node app.js',
    environment: '',
    cdpPort: null,
    inspectPort: null,
    agentPort: null,
    servicePort: 4500,
    serviceProcess: '/srv/app.js',
    createdAt: '2026-11-17T00:00:00.000Z',
    managed: status === 'running',
    controls: { start: status !== 'running', stop: status === 'running', restart: status === 'running' },
    runtime: { ...idleRuntime(), status, pid: status === 'running' ? 8888 : null },
    debug: { renderer: false, main: false, targets: [] }
  });

  const mockService = {
    snapshot: () => [makeView()],
    list: async () => [makeView()],
    get: () => makeView(),
    save: async () => id,
    connect: async () => ({ status: 'connected' }),
    syncAgents: async () => {},
    start: async targetId => { events.push(['start', targetId]); status = 'running'; },
    restart: async targetId => { events.push(['restart', targetId]); status = 'running'; },
    stop: async targetId => { events.push(['stop', targetId]); status = 'stopped'; },
    logs: (targetId, opts) => { events.push(['logs', targetId, opts]); return 'line1\nline2\n'; }
  };

  const started = await executeLocalAppManagementCommand({ action: 'local-app', method: 'start', selector: 'My Service' }, mockService);
  assert.equal(started.status, 'start');
  assert.equal(started.app.runtime.status, 'running');
  assert.equal(started.app.managed, true);

  const restarted = await executeLocalAppManagementCommand({ action: 'local-app', method: 'restart', selector: `local-app:${id}` }, mockService);
  assert.equal(restarted.status, 'restart');

  const logRes = await executeLocalAppManagementCommand({ action: 'local-app', method: 'logs', selector: id, tailLines: 10, grep: 'line' }, mockService);
  assert.equal(logRes.logs, 'line1\nline2\n');

  const stopped = await executeLocalAppManagementCommand({ action: 'local-app', method: 'stop', selector: id }, mockService);
  assert.equal(stopped.status, 'stop');
  assert.equal(stopped.app.runtime.status, 'stopped');

  assert.deepEqual(events, [
    ['start', id],
    ['restart', id],
    ['logs', id, { tailLines: 10, grep: 'line' }],
    ['stop', id]
  ]);
});

test('requestAppQuit invokes app.terminate() on macOS and refuses invalid or self PIDs', async () => {
  const quitSrc = fs.readFileSync(path.join(root, 'src/main/local-apps/quit.ts'), 'utf8');
  assert.match(quitSrc, /app\.terminate\(\)/, 'macOS JXA must invoke app.terminate() rather than reading property');
  assert.equal(await requestAppQuit(0), false);
  assert.equal(await requestAppQuit(-5), false);
  assert.equal(await requestAppQuit(process.pid), false);
});
