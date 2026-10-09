const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {createHash}=require('node:crypto');
const {loadCli}=require('./cli-test-build.cjs');
const {wirelessAddress,parseWirelessServices,discoverWireless,pairWireless,connectWireless}=loadCli('src/main/phones/wireless.ts');
const {Adb}=loadCli('src/main/phones/adb.ts');const {PhonesService}=loadCli('src/main/phones/service.ts');
const {groupPhoneDevices}=loadCli('src/shared/phone-devices.ts');
test('wireless endpoints require local IPv4 and a valid explicit port',()=>{
  for(const value of ['192.168.1.4:37123','10.0.1.4:65535','172.31.1.1:1','169.254.5.8:40000'])assert.equal(wirelessAddress(value),value);
  for(const value of ['8.8.8.8:53','localhost:4444','127.0.0.1:4444','192.168.1.1:0','192.168.1.1:65536','192.168.1.999:4567','192.168.1.2:4000;reboot','-s','192.168.1.1'])assert.throws(()=>wirelessAddress(value));
});
test('mDNS parser separates pairing from connection ports and excludes legacy devices',()=>{
  const records=parseWirelessServices('List of discovered mdns services\nfoo _adb-tls-pairing._tcp 192.168.1.2:40001\r\nfoo _adb-tls-connect._tcp. 192.168.1.2:40002\nold _adb._tcp 192.168.1.3:5555\nevil _adb-tls-connect._tcp 8.8.8.8:443\nrepeat _adb-tls-connect._tcp 192.168.1.2:40002');
  assert.deepEqual(records.map(r=>[r.kind,r.address]),[['pairing','192.168.1.2:40001'],['connect','192.168.1.2:40002']]);
});
test('pairing code travels on stdin only; success does not return its credential',async()=>{
  const calls=[];const result=await pairWireless({run:async(...args)=>{calls.push(args);return 'Enter pairing code: Successfully paired to 192.168.1.2:40001 [guid=abcd]'}},{address:'192.168.1.2:40001',code:'012345'});
  assert.deepEqual(calls[0],[['pair','192.168.1.2:40001'],20000,'012345\n']);assert.deepEqual(result,{address:'192.168.1.2:40001'});
});
test('validation precedes process execution and pairing errors never echo the code',async()=>{
  let calls=0;const adb={run:async()=>{calls++;throw Error('pair 012345 failed')}};
  await assert.rejects(pairWireless(adb,{address:'192.168.1.2:40001',code:'12345'}));assert.equal(calls,0);
  await assert.rejects(pairWireless(adb,{address:'192.168.1.2:40001',code:'012345'}),e=>!e.message.includes('012345')&&e.message.includes('配对未完成'));
  await assert.rejects(pairWireless({run:async()=>'Failed: incorrect code 012345'},{address:'192.168.1.2:40001',code:'012345'}),/未确认配对成功/);
});
test('zero-exit ADB connection failures are rejected; existing connections are accepted',async()=>{
  for(const output of ['connected to 192.168.1.2:40002','already connected to 192.168.1.2:40002'])assert.equal(await connectWireless({run:async()=>output},{address:'192.168.1.2:40002'}),'192.168.1.2:40002');
  for(const output of ['failed to connect to 192.168.1.2:40002','connected to 192.168.1.3:40002'])await assert.rejects(connectWireless({run:async()=>output},{address:'192.168.1.2:40002'}),/未建立无线连接/);
  assert.match((await discoverWireless({run:async()=>{throw Error('not supported')}})).error,/手动/);
});
test('real subprocess stdin works on Windows/POSIX and errors redact pairing output',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-wifi-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const script=path.join(root,'中文 stdin.cjs');fs.writeFileSync(script,"let v='';process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(2),input:v}));process.exitCode=process.argv.includes('fail')?1:0});");
  const adb=new Adb(process.execPath);const result=JSON.parse(await adb.run([script,'pair','192.168.1.2:4444'],3000,'012345\n'));
  assert.deepEqual(result.args,['pair','192.168.1.2:4444']);assert.equal(result.input,'012345\n');
  await assert.rejects(adb.run([script,'fail'],3000,'012345\n'),error=>!error.message.includes('012345'));
});
function fixture(t,{active=false,mdns=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-wifi-service-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const usb='PHONE123',wifi=mdns?'adb-PHONE123-abc._adb-tls-connect._tcp':'192.168.1.2:40002',token='b'.repeat(64);
  const apkPath=path.join(root,'app.apk');fs.writeFileSync(apkPath,'fixture');
  fs.writeFileSync(path.join(root,'devices.json'),JSON.stringify({[usb]:{token,installedHash:createHash('sha256').update('fixture').digest('hex')}}));
  const calls=[],state={protocol:1,instanceId:'same-phone',sessionId:active?'existing':null,generation:1,phase:active?'controlling':'idle',mode:'control',computer:'pc',controller:active?'OtherAgent':'',task:'',startedAt:null,lastAction:'',permissions:{overlay:true,notifications:true,accessibility:true}};
  let connected=false;
  const service=new PhonesService({root,apkPath,adb:{run:async(args)=>{
    calls.push(args);if(args[0]==='devices')return `${usb} device model:Phone\n${connected?wifi+' device model:Phone':''}`;
    if(args[0]==='connect'){connected=true;return 'connected to 192.168.1.2:40002'}
    if(args[0]==='mdns')return 'adb-PHONE123-abc _adb-tls-connect._tcp 192.168.1.2:40002';
    if(args.includes('tcp:0'))return '23456';if(args[2]==='shell'&&args[3].includes('ro.serialno'))return usb;
    if(args[2]==='shell'&&args[3].includes("'pm' 'path'"))return 'package:/fixture.apk';return '';
  }},request:async(port,received,method)=>{assert.equal(received,token);assert.equal(method,'sync');return {ok:true,state:structuredClone(state)}}});
  return {root,service,calls,state,usb,wifi};
}
test('wireless connect verifies actual device readiness and does not start or pair the app',async t=>{
  const h=fixture(t);const result=await h.service.connectWireless({address:'192.168.1.2:40002'});assert.equal(result.id,h.wifi);assert.equal(result.state,null);
  assert.ok(!h.calls.some(a=>a.includes('install')||a.includes('pair')));
  // Refresh may read the setup switches of an already paired USB route. It must
  // never launch the app, change a setting or perform other shell operations.
  for(const call of h.calls.filter(a=>a.includes('shell')))
    assert.match(call[3], /^(?:'getprop' 'ro.serialno'|'pm' 'path' 'io.github.profilepilot.phone'|'settings' 'get' 'global' '(development_settings_enabled|adb_enabled|adb_wifi_enabled)')$/);
});

test('unpaired Wi-Fi route replaces the old selected USB route without installing or pairing the App',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-basic identity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const usb='KNOWN-PHONE',wifi='192.168.1.2:40123',other='192.168.1.3:40234';
  const saved={[usb]:{token:'a'.repeat(64),hardwareId:usb,model:'Same Model',transport:'usb'}};
  fs.writeFileSync(path.join(root,'devices.json'),JSON.stringify(saved));
  let online=true,serial=usb,now=1000;const calls=[];
  const service=new PhonesService({root,apkPath:'',now:()=>now,adb:{run:async args=>{
    calls.push(args);
    if(args[0]==='devices')return online?`${wifi} device model:Same_Model\n${other} device model:Same_Model`:'';
    if(args[3]==="'getprop' 'ro.serialno'")return args[1]===wifi?serial:'OTHER-PHONE';
    throw new Error(`Unexpected device command: ${args.join(' ')}`);
  }}});t.after(()=>service.close());
  let snapshot=await service.refresh(),groups=groupPhoneDevices(snapshot.devices,usb);
  assert.equal(groups.length,2,'same model does not merge unrelated devices');
  assert.equal(groups[0].device.id,wifi);assert.equal(groups[0].device.hardwareId,usb);
  assert.equal(groups[0].device.companion,'unknown');assert.equal(groups[0].device.state,null);
  assert.deepEqual(groups[0].routes.map(d=>d.id),[usb,wifi]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'devices.json'))),saved,'discovery creates no App credentials');
  assert.equal((await service.basicStart(wifi,'view','Test','identity regression')).basic.phase,'viewing');
  service.basicControl(wifi,'stop');
  await service.refresh();assert.equal(calls.filter(a=>a[3]==="'getprop' 'ro.serialno'").length,2,'identity is cached while connected');
  online=false;await service.refresh();online=true;serial='DIFFERENT-PHONE';
  snapshot=await service.refresh();groups=groupPhoneDevices(snapshot.devices,usb);
  assert.equal(groups.length,3,'reused Wi-Fi address must be identified again');
  assert.equal(groups.find(g=>g.device.id===wifi).device.hardwareId,serial);
  assert.equal(calls.some(a=>a.includes('install')||a.includes('forward')||a[3]?.includes("'am' 'start'")),false);
});

test('unavailable basic hardware identity is retried without blocking connection or grouping by model',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-basic-identity-retry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let now=1000,reads=0;
  const service=new PhonesService({root,apkPath:'',now:()=>now,adb:{run:async args=>{
    if(args[0]==='devices')return '192.168.1.2:40123 device model:Phone';
    if(args[3]==="'getprop' 'ro.serialno'"){reads++;if(reads===1)throw new Error('Temporary timeout');return 'PHONE';}
    throw new Error('Unexpected device command');
  }}});t.after(()=>service.close());
  let snapshot=await service.refresh();assert.equal(snapshot.devices[0].connection,'device');assert.equal(snapshot.devices[0].hardwareId,undefined);
  await service.refresh();assert.equal(reads,1);
  now+=30001;snapshot=await service.refresh();assert.equal(snapshot.devices[0].hardwareId,'PHONE');assert.equal(reads,2);
});
test('mDNS auto-connected device is matched only to its exact advertised endpoint',async t=>{
  const h=fixture(t,{mdns:true});assert.equal((await h.service.connectWireless({address:'192.168.1.2:40002'})).id,h.wifi);
});
test('USB to Wi-Fi reuses companion credential and does not reinstall unchanged APK',async t=>{
  const h=fixture(t);await h.service.connectWireless({address:'192.168.1.2:40002'});await h.service.prepare(h.wifi);
  const saved=JSON.parse(fs.readFileSync(path.join(h.root,'devices.json')));assert.equal(saved[h.wifi].token,saved[h.usb].token);assert.equal(saved[h.wifi].hardwareId,h.usb);
  assert.ok(!h.calls.some(a=>a.includes('install')));assert.equal(h.state.phase,'idle');
});
test('preparing Wi-Fi refuses an active session already owned through USB',async t=>{
  const h=fixture(t);await h.service.connectWireless({address:'192.168.1.2:40002'});h.state.phase='controlling';h.state.sessionId='existing';h.state.controller='OtherAgent';
  await assert.rejects(h.service.prepare(h.wifi),/先结束手机会话/);assert.ok(!h.calls.some(a=>a[3]?.includes("'am' 'start'")));assert.equal(h.state.controller,'OtherAgent');
});
