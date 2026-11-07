const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connectWireless, pairWireless, discoverWireless } = require('../dist/main/phones/wireless');
const { Adb } = require('../dist/main/phones/adb');
const { PhonesService } = require('../dist/main/phones/service');
const { initializeDiagnosticLogging, readDiagnosticLogs, diagnosticLogPath } = require('../dist/main/diagnostic-log');
const { startProfilePilotManagementServer } = require('../dist/main/profilepilot-management-server');
const { requestProfilePilotManagement } = require('../dist/main/profilepilot-cli');
const address = '192.168.1.8:41000';

for (const [output, reason] of [
  ['failed to authenticate', 'AUTH_REQUIRED'],
  ['No connection could be made because the target machine actively refused it. (10061)', 'CONNECTION_REFUSED'],
  ['Connection refused', 'CONNECTION_REFUSED'],
  ['Operation timed out', 'NETWORK_TIMEOUT'],
  ['Connection timed out (10060)', 'NETWORK_TIMEOUT'],
  ['No route to host: EHOSTUNREACH', 'NETWORK_TIMEOUT'],
  ['unknown command: connect', 'ADB_UNSUPPORTED'],
  ['failed to connect', 'UNKNOWN']
]) test(`Windows/macOS wireless failure preserves evidence: ${reason}: ${output}`, async () => {
  await assert.rejects(connectWireless({run: async () => output}, {address}), error => {
    assert.equal(error.code, 'PHONE_WIFI_' + reason);
    assert.equal(error.details.wireless.stage, 'connection');
    assert.equal(error.details.wireless.evidence.stdout, output);
    assert.equal(error.details.wireless.address, address);
    assert.match(error.message, new RegExp(error.details.wireless.diagnosticId));
    if (reason === 'UNKNOWN') assert.match(error.message, /原因尚未确认/);
    return true;
  });
});

test('wireless process failure preserves nonzero exit and sanitized stderr without argv or stdin', async () => {
  const adb = new Adb('unused', (_exe, args, _options, callback) => {
    assert.deepEqual(args, ['pair', address]);
    queueMicrotask(() => callback(Object.assign(new Error('argv must not escape'), { code: 1 }),
      'code012345 guid=private-guid', 'incorrect code 012345 token=private-token'));
    return {stdin: {on() {}, end(input) { assert.equal(input, '012345\n'); }}};
  });
  await assert.rejects(pairWireless(adb, {address, code:'012345'}), error => {
    assert.equal(error.code, 'PHONE_WIFI_PAIRING_REJECTED');
    assert.equal(error.details.wireless.evidence.exitCode, 1);
    assert.match(error.details.wireless.evidence.stderr, /incorrect code/);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /012345|private-guid|private-token|argv must not escape/);
    return true;
  });
});

test('missing ADB and killed deadline keep their distinct recovery rather than blaming pairing', async () => {
  await assert.rejects(connectWireless({run: async () => { throw Object.assign(new Error('spawn'), {code:'ENOENT'}); }}, {address}), e => e.code === 'PHONE_WIFI_ADB_MISSING');
  await assert.rejects(pairWireless({run: async () => { throw Object.assign(new Error('hidden'), {wirelessEvidence:{timedOut:true, signal:'SIGTERM'}}); }}, {address,code:'012345'}), e => {
    assert.equal(e.code, 'PHONE_WIFI_COMMAND_TIMEOUT'); assert.match(e.message, /结果尚未确认/); return true;
  });
});

test('failed discovery returns a diagnostic reference while leaving manual connection available', async () => {
  const result = await discoverWireless({run: async () => {throw Error('mDNS service unavailable');}});
  assert.deepEqual(result.services, []);
  assert.match(result.error, /手动/);
  assert.equal(result.diagnostic.stage, 'discovery');
  assert.equal(result.diagnostic.reason, 'DISCOVERY_FAILED');
});

test('accepted ADB connection without a ready device is not reported as authentication failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wr-'));
  const service = new PhonesService({root,apkPath:'',adb:{run:async args => args[0] === 'connect' ? `connected to ${address}` : ''}});
  t.after(async () => { await service.close(); fs.rmSync(root,{recursive:true,force:true}); });
  await assert.rejects(service.connectWireless({address}), e => {
    assert.equal(e.code,'PHONE_WIFI_DEVICE_NOT_READY'); assert.equal(e.details.wireless.stage,'readiness'); return true;
  });
});

test('CLI response and durable logs share a failure ID and never expose a pairing code', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wd-'));
  const env = {PROFILEPILOT_MANAGEMENT_ROOT: root, PROFILEPILOT_LOG_ROOT: path.join(root,'logs')};
  initializeDiagnosticLogging({env, captureConsole:false});
  const service = new PhonesService({root:path.join(root,'phones'),apkPath:'',adb:{run:async () => 'incorrect code 012345 guid=private-guid token=private-token'}});
  const server = await startProfilePilotManagementServer({profileManager:{},homeDir:root,env,getPhoneService:()=>service});
  t.after(async () => {await server.close(); await service.close(); fs.rmSync(root,{recursive:true,force:true});});
  const response = await requestProfilePilotManagement({action:'phone',method:'wireless-pair',params:{address,code:'012345'}},root,env);
  assert.equal(response.ok,false);
  assert.equal(response.error.code,'PHONE_WIFI_PAIRING_REJECTED');
  const diagnostic = response.error.details.wireless;
  const entries = readDiagnosticLogs({env});
  const wireless = entries.find(e=>e.event==='wireless.failed');
  const command = entries.find(e=>e.event==='command.failed');
  assert.equal(wireless.details.diagnosticId,diagnostic.diagnosticId);
  assert.equal(command.details.wireless.diagnosticId,diagnostic.diagnosticId);
  assert.equal(command.details.method,'wireless-pair');
  assert.equal(command.details.requestId,response.id);
  assert.doesNotMatch(JSON.stringify(response)+fs.readFileSync(diagnosticLogPath(root,env),'utf8'),/012345|private-guid|private-token/);
});
