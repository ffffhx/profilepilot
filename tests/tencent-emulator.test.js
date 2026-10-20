const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadCli } = require('./cli-test-build.cjs');
const { TencentEmulator } = loadCli('src/main/phones/tencent-emulator.ts');
const directory='D:\\Games\\腾讯手游助手\\UI', executable=directory+'\\AndroidEmulator.exe';
const snapshot=()=>({
  processes:[{pid:1234,name:'AndroidEmulator.exe',executablePath:executable,commandLine:executable}],
  tcp:[{pid:1234,state:'Listen',localPort:5555,localAddress:'0.0.0.0'}]
});

test('Tencent reuse verifies the installed executable, local listener and window before returning a route',async t=>{
  const scripts=[],fitted=[];
  t.mock.method(fs,'existsSync',file=>file===executable);
  const runtime=new TencentEmulator('win32',async script=>{
    scripts.push(script);
    return directory;
  },async pid=>fitted.push(pid),async()=>snapshot());
  assert.equal(await runtime.connect(),'127.0.0.1:5555');
  assert.deepEqual(fitted,[1234]);
  assert.equal(scripts.length,1,'running engine is never relaunched');
});

test('Tencent window correction failure cannot be reported as a connected preview',async t=>{
  t.mock.method(fs,'existsSync',()=>true);
  const runtime=new TencentEmulator('win32',async()=>directory,async()=>{throw Error('window outside work area');},async()=>snapshot());
  await assert.rejects(runtime.connect(),/outside work area/);
});

test('Tencent discovery does not run Windows commands on macOS or accept relative install paths',async t=>{
  let calls=0;
  assert.equal(await new TencentEmulator('darwin',async()=>{calls++;return '';}).executable(),undefined);
  assert.equal(calls,0);
  t.mock.method(fs,'existsSync',()=>true);
  assert.equal(await new TencentEmulator('win32',async()=>'relative\\UI').executable(),undefined);
});

test('another executable using the same process name and port cannot be selected or replaced',async t=>{
  t.mock.method(fs,'existsSync',()=>true);
  let fitted=false;const system=snapshot();system.processes[0].executablePath='C:\\Other\\AndroidEmulator.exe';
  const runtime=new TencentEmulator('win32',async()=>directory,async()=>{fitted=true;},async()=>system);
  await assert.rejects(runtime.connect(),/其他进程/);assert.equal(fitted,false);
});

test('fresh launch requests Windows consent and verifies the resulting engine window',async t=>{
  t.mock.method(fs,'existsSync',()=>true);
  let reads=0;const scripts=[],fitted=[];
  const runtime=new TencentEmulator('win32',async script=>{scripts.push(script);return script.includes('InstallPath')?directory:'';},
    async pid=>fitted.push(pid),async()=>reads++?snapshot():{processes:[],tcp:[]});
  assert.equal(await runtime.connect(),'127.0.0.1:5555');
  assert.match(scripts[1],/-Verb RunAs -WindowStyle Hidden/);
  assert.ok(scripts[1].includes(executable));assert.deepEqual(fitted,[1234]);
});
