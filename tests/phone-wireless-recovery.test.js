const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { wirelessCandidates, connectWireless } = loadCli('src/main/phones/wireless.ts');
const { readinessSchema } = loadCli('src/main/phones/readiness-schema.ts');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');
const readiness = () => ({ unlocked:true, computerConnected:false, usbConnected:false, wifiConnected:false,
  developerOptions:'enabled', usbDebugging:'enabled', wirelessDebugging:'enabled', accessibilityService:'running',
  network:{wifiIpv4:['192.168.1.9'],adbEndpoints:[{address:'192.168.1.9:41000',ageMs:1000}]}});
const route = () => ({id:'PHONE123',transport:'usb',hardwareId:'PHONE123',cloud:{paired:true,reportedAt:1000,report:{readiness:readiness()}}});
const ad = (address, name='adb-PHONE123-xyz') => ({name,kind:'connect',address});

test('fresh phone report replaces old IP and excludes unrelated nearby phones', () => {
  const value = wirelessCandidates([ad('192.168.1.8:42000'),ad('192.168.1.3:42000','adb-OTHER-xyz'),ad('192.168.1.9:41000')],[route()],2000);
  assert.deepEqual(value.services.map(item=>item.address),['192.168.1.9:41000']);
  assert.equal(value.services[0].source,'phone');
});
test('report age and endpoint age accumulate; old phone versions still match exact hardware', () => {
  const phone=route();phone.cloud.report.readiness.network.adbEndpoints[0].ageMs=44000;
  assert.equal(wirelessCandidates([], [phone],2000).services.length,0);
  assert.equal(wirelessCandidates([], [route()],46000).phoneIps.length,0);
  delete phone.cloud.report.readiness.network;
  const value=wirelessCandidates([ad('192.168.1.8:42000'),ad('192.168.1.3:42000','adb-PHONE1234-xyz')],[phone],2000);
  assert.deepEqual(value.services.map(item=>item.address),['192.168.1.8:42000']);
});
test('one physical phone with USB and historical Wi-Fi records yields one endpoint', () => {
  const phone = route();
  const value = wirelessCandidates([ad('192.168.1.9:41000')], [phone, {...phone,id:'192.168.1.8:40000',transport:'wifi'}, {...phone,id:'192.168.1.7:40000',transport:'wifi'}], 2000);
  assert.equal(value.services.length,1);
  assert.equal(value.services[0].address,'192.168.1.9:41000');
});
test('desktop and status relay validate private address ownership and keep old reports compatible', async () => {
  const {validateReport}=await import('../services/phone-status/server.mjs');
  const report={deviceId:'00000000-0000-0000-0000-000000000001',name:'phone',permissions:{overlay:true,accessibility:true,notifications:true},readiness:readiness()};
  assert.deepEqual(validateReport(report).readiness.network,report.readiness.network);
  assert.deepEqual(readinessSchema.parse(report.readiness).network,report.readiness.network);
  for(const network of [
    {wifiIpv4:['8.8.8.8'],adbEndpoints:[]},
    {wifiIpv4:['192.168.1.9'],adbEndpoints:[{address:'192.168.1.10:44000',ageMs:0}]},
    {wifiIpv4:['192.168.1.9'],adbEndpoints:[{address:'192.168.1.9:65536',ageMs:0}]},
    {wifiIpv4:['192.168.1.9'],adbEndpoints:[{address:'192.168.1.9:44000',ageMs:-1}]}
  ]) {
    const invalid={...report,readiness:{...report.readiness,network}};
    assert.throws(()=>validateReport(invalid));assert.equal(readinessSchema.safeParse(invalid.readiness).success,false);
  }
  delete report.readiness.network;
  assert.deepEqual(validateReport(report),report);assert.ok(readinessSchema.safeParse(report.readiness).success);
});
test('connection errors distinguish Windows refusal, timeout and pairing failures without raw output', async () => {
  for(const [output,expected] of [['failed: actively refused (10061)',/端口拒绝/],['failed: timed out (10060)',/超时/],['failed to authenticate',/认证/]])
    await assert.rejects(connectWireless({run:async()=>output},{address:'192.168.1.9:41000'}),expected);
});
test('CLI supports selected-device discovery and auto connection, rejects mixed targets', async () => {
  const calls=[],io={stdout:{write(){}},stderr:{write(){}}},request=async c=>{calls.push(c);return {ok:true,data:{}}};
  assert.equal(await runPhoneCli(['wireless-discover','--device','PHONE123'],request,io),0);
  assert.equal(await runPhoneCli(['wireless-connect','--device','PHONE123'],request,io),0);
  assert.equal(await runPhoneCli(['wireless-connect','--device','PHONE123','--address','192.168.1.9:41000'],request,io),1);
  assert.deepEqual(calls.map(c=>c.params),[{id:'PHONE123'},{id:'PHONE123'}]);
});

function serviceFixture(t,{different=false,paused=false,stale=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-wireless-recovery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'devices.json'),JSON.stringify({PHONE123:{token:'b'.repeat(64),hardwareId:'PHONE123',transport:'usb'}}));
  let scans=0,connected=false;const calls=[];
  const service=new PhonesService({root,apkPath:path.join(root,'unused.apk'),probeWireless:async address=>({reachable:!address.endsWith(':40000'),reason:'端口拒绝连接'}),adb:{run:async args=>{
    calls.push(args);
    if(args[0]==='mdns')return `adb-PHONE123-xyz _adb-tls-connect._tcp 192.168.1.9:${stale && ++scans===1?'40000':'41000'}`;
    if(args[0]==='connect'){connected=true;return 'connected to '+args[1];}
    if(args[0]==='devices')return connected?'192.168.1.9:41000 device model:Phone':'';
    if(args.includes('shell'))return different?'OTHER':'PHONE123';
    return '';
  }}});
  if(paused)service.devices.get('PHONE123').state={phase:'paused'};
  return {service,calls};
}
test('automatic connection refreshes stale discovery and verifies hardware without starting control',async t=>{
  const {service,calls}=serviceFixture(t,{stale:true});
  const result=await service.autoConnectWireless('PHONE123');assert.equal(result.id,'192.168.1.9:41000');
  assert.equal(calls.filter(a=>a[0]==='connect').length,1);assert.ok(!calls.some(a=>a.includes('install')||a.includes('pair')||a.includes('start')));
});
test('automatic connection refuses hardware mismatch and paused sessions',async t=>{
  const wrong=serviceFixture(t,{different:true});await assert.rejects(wrong.service.autoConnectWireless('PHONE123'),/其他设备/);
  const paused=serviceFixture(t,{paused:true});await assert.rejects(paused.service.autoConnectWireless('PHONE123'),/原会话/);assert.equal(paused.calls.length,0);
});
test('explicit reconnection after a dropped session restores transport only, never control',async t=>{
  const {service,calls}=serviceFixture(t);
  service.devices.get('PHONE123').state={phase:'disconnected'};
  const result=await service.autoConnectWireless('PHONE123');assert.equal(result.id,'192.168.1.9:41000');
  assert.ok(!calls.some(a=>a.includes('start')||a.includes('resume')||a.includes('install')));
});
