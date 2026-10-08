import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { launchProfilePilotE2e } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const { readBrowserServiceConnection, serviceRequest, processAlive } = require('../dist/main/browser-service/connection');
const chromeRoot = await mkdtemp(path.join(os.tmpdir(), 'pp-service-ui-chrome-'));
await mkdir(path.join(chromeRoot, 'Default'));
await writeFile(path.join(chromeRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Service UI fixture' } } } }));
let app, connection;
try {
  app = await launchProfilePilotE2e({ env: { CPM_START_VIEW: 'tools', CPM_NATIVE_CHROME_USER_DATA_DIR: chromeRoot } });
  const paired = await app.driver.evaluate(`window.tasks.pairNativeBrowser('native:Default').then(value => value.code.startsWith('PP1.'))`);
  assert.equal(paired, true, 'real App IPC pairs through the independent service');
  connection = readBrowserServiceConnection(path.join(app.dataDir, 'browser-tasks'));
  assert.notEqual(connection.pid, app.child.pid);
  const identity = (await serviceRequest(connection, 'ping')).result;
  await app.stop({ removeFixture: false, keepBrowserService: true });
  assert.equal(processAlive(connection.pid), true);
  assert.equal((await serviceRequest(connection, 'ping')).result.pid, identity.pid);
  const pairing = (await serviceRequest(connection, 'pair', ['native:Default'])).result;
  assert.ok(pairing.code.startsWith('PP1.'));
  console.log('PASS real App -> IPC -> independent service pairing; App process exit preserves the same service.');
} finally {
  await app?.stop({ removeFixture: false, keepBrowserService: true });
  if (connection && processAlive(connection.pid)) {
    try { await serviceRequest(connection, 'stop'); } catch { process.kill(connection.pid); }
    for (let i = 0; i < 50 && processAlive(connection.pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(processAlive(connection.pid), false);
  }
  for (const folder of [app?.fixtureRoot, chromeRoot].filter(Boolean)) {
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
