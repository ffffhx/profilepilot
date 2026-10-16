const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { PhoneInspection, parsePackageDump } = loadCli('src/main/phones/inspection.ts');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { executePhoneCommand } = loadCli('src/main/phones/management.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');
const dump = 'Packages:\n  Package [io.example.app] (abcdef):\n    versionCode=1193999 minSdk=30 targetSdk=35\n    versionName=0.3.6+local.193-dev\n    lastUpdateTime=2026-10-16 10:00:00\n  Package [other] (ab):\n    versionCode=999\n    versionName=wrong\n';
test('package inspection selects the exact package block and keeps missing facts unknown', () => {
  assert.equal(parsePackageDump('io.example.app', dump).versionName, '0.3.6+local.193-dev');
  assert.equal(parsePackageDump('io.example.app', dump).versionCode, '1193999');
  assert.equal(parsePackageDump('io.missing', dump).versionCode, null);
  assert.equal(parsePackageDump('io.example.app', dump).firstInstallTime, null);
});
test('version and split APK paths are read without installing, starting or pairing the App', async () => {
  const calls = [], inspection = new PhoneInspection({ run: async args => {
    calls.push(args);
    return args[3].startsWith("'pm' 'path'") ? 'package:/data/app/abc==/base.apk\npackage:/data/app/abc==/split.apk' : dump;
  } });
  const result = await inspection.app('PHONE', 'io.example.app');
  assert.equal(result.status, 'installed'); assert.equal(result.versionName, '0.3.6+local.193-dev'); assert.equal(result.paths.length, 2);
  assert.deepEqual(calls.map(c => c[3]), ["'pm' 'path' 'io.example.app'", "'dumpsys' 'package' 'io.example.app'"]);
  await assert.rejects(inspection.app('PHONE', 'io.example;reboot'), /包名/); assert.equal(calls.length, 2);
});
test('query failures cannot be mistaken for an absent package; package paths containing equals are preserved', async () => {
  const inspection = new PhoneInspection({ run: async () => 'Error: package manager unavailable' });
  await assert.rejects(inspection.app('PHONE', 'io.example.app'), /无法确认/);
  const listing = new PhoneInspection({ run: async () => 'package:/data/app/abc==/base.apk=io.example.app\nunparsed warning' });
  const result = await listing.packages('PHONE', 'all', 'EXAMPLE');
  assert.equal(result.packages[0].apkPath, '/data/app/abc==/base.apk'); assert.equal(result.coverage, 'partial');
});
test('CLI inspection dispatches a read-only query; connect and update are separate service calls', async () => {
  const calls = [], request = async c => { calls.push(c); return { ok: true, data: {} }; };
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  assert.equal(await runPhoneCli(['inspect','--device','PHONE','--package','io.example.app'], request, io), 0);
  assert.equal(calls[0].method, 'package-info');
  const prepare = [], service = { prepare: async (...args) => prepare.push(args) };
  await executePhoneCommand({method:'connect',params:{id:'PHONE',update:false}}, service);
  await executePhoneCommand({method:'update',params:{id:'PHONE'}}, service);
  assert.deepEqual(prepare, [['PHONE',false],['PHONE',true]]);
});
test('connecting an installed companion never needs a bundled APK or installs anything', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-no-update-')), calls = [];
  fs.writeFileSync(path.join(root,'devices.json'), JSON.stringify({PHONE:{token:'a'.repeat(64),hardwareId:'PHONE'}}));
  const state = { protocol:1,instanceId:'p',sessionId:null,generation:0,phase:'idle',mode:'view',computer:'pc',controller:'',task:'',startedAt:null,lastAction:'',permissions:{overlay:true,accessibility:true,notifications:true} };
  const service = new PhonesService({root,apkPath:path.join(root,'does-not-exist.apk'),adb:{run:async args=>{
    calls.push(args);
    if(args[0]==='devices') return 'PHONE device model:Test';
    if(args.includes('tcp:0')) return '19999';
    if(args[3]==="'getprop' 'ro.serialno'") return 'PHONE';
    if(args[3]?.startsWith("'pm' 'path'")) return 'package:/data/app/base.apk';
    return '';
  }},request:async()=>({ok:true,state})});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  await service.refresh(); await service.prepare('PHONE',false);
  assert.equal(calls.some(a=>a.includes('install')),false);
  assert.equal(service.snapshot().devices[0].state.sessionId,null);
});
