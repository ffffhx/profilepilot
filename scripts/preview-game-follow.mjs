// Runs the actual desktop app in an independent process with isolated preview data.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildWindowsCimInvocation, quoteWindowsArgument } from './start-independent.mjs';
import { ElectronDriver, delay, repoRoot } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const root = path.join(repoRoot, 'artifacts/game-follow/preview');
mkdirSync(root, {recursive:true});
const recordPath = path.join(root, 'process.json');
const stampPath = path.join(root, 'launch.json');
const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0,12);
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\pp-follow-preview-${hash}` : `/tmp/pp-follow-${hash}.sock`;
const alive = pid => {try {return Number.isSafeInteger(pid) && pid>0 && (process.kill(pid,0),true);} catch{return false;}};
let record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath,'utf8')) : {};
const reused = alive(record.pid);
if (!alive(record.pid)) {
  const executable = require('electron');
  const args = [...(process.platform==='darwin'?['--use-mock-keychain']:[]),
    ...(process.platform==='win32'?['--disable-features=CalculateNativeWinOcclusion']:[]),
    repoRoot, `--user-data-dir=${path.join(root,'electron')}`];
  const env = {CPM_DATA_DIR:path.join(root,'app'),CPM_START_VIEW:'phones',CPM_ELECTRON_SMOKE_TEST:'1',
    CPM_E2E_DRIVER_SOCKET:socket,CPM_E2E_MODE:'desktop',CPM_E2E_DETERMINISTIC:'1'};
  if (process.platform==='win32') {
    const ps = s => "'" + String(s).replaceAll("'","''") + "'";
    const bootstrap = [
      "$ErrorActionPreference='Stop'",
      ...Object.entries(env).map(([name,value])=>`$env:${name}=${ps(value)}`),
      `$preview = Start-Process -FilePath ${ps(executable)} -ArgumentList ${ps(args.map(quoteWindowsArgument).join(' '))} -WorkingDirectory ${ps(repoRoot)} -PassThru`,
      `[IO.File]::WriteAllText(${ps(stampPath)}, (@{pid=$preview.Id} | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))`
    ].join('\n');
    const invocation = buildWindowsCimInvocation({bootstrapScript:bootstrap,powershellPath:path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe')});
    const result=spawnSync(invocation.executable,invocation.args,{cwd:repoRoot,windowsHide:true,encoding:'utf8',timeout:15000});
    if(result.status!==0 || JSON.parse(result.stdout).ReturnValue!==0) throw Error(result.stderr||result.stdout);
    for(let i=0;i<80;i++) {
      if(existsSync(stampPath)) {const next=JSON.parse(readFileSync(stampPath,'utf8'));if(alive(next.pid)){record=next;break;}}
      await delay(150);
    }
  } else {
    const child=spawn(executable,args,{cwd:repoRoot,env:{...process.env,...env},detached:true,stdio:'ignore'});
    child.unref();record={pid:child.pid};
  }
  if(!alive(record.pid)) throw Error('Preview did not stay running');
  writeFileSync(recordPath,JSON.stringify({...record,socket},null,2));
}
let driver;
try {
  for(let i=0;i<120;i++) {
    try {driver=new ElectronDriver(await new Promise((resolve,reject)=>{
      const client=net.createConnection(socket);client.once('connect',()=>resolve(client));client.once('error',error=>{client.destroy();reject(error);});
    }));break;} catch {await delay(150);}
  }
  if(!driver) throw Error('Preview driver did not become ready');
  if(reused) await driver.request('reload');
  await driver.activate();
  await driver.waitFor('[data-action="game-follow"]');
  await delay(600);
  if((await driver.query('[data-guide-close]')).exists) await driver.domClick('[data-guide-close]');
  const opened=await driver.query('.game-follow-dialog');
  if(!opened.exists) await driver.domClick('[data-action="game-follow"]');
  await driver.waitFor('[data-gf-runtime]',e=>e.text.includes('已就绪'));
  await driver.waitFor('[data-gf-demo]',e=>!e.disabled);
  if(!(await driver.query('[data-gf-stop]')).disabled) await driver.domClick('[data-gf-stop]');
  await driver.domClick('[data-gf-demo]');
  await driver.waitFor('[data-gf-source]',e=>e.text.includes('演示地图'));
  await driver.domClick('[data-gf-analyze]');
  await driver.waitFor('[data-gf-status]',e=>e.text.includes('连续确认'));
  await driver.domClick('[data-gf-analyze]');
  await driver.waitFor('[data-gf-status]',e=>e.text.includes('沿路线'));
  writeFileSync(path.join(root,'desktop.png'),Buffer.from((await driver.screenshot()).pngBase64,'base64'));
  await delay(1500);
  if(!alive(record.pid)) throw Error('Independent preview exited');
  console.log(JSON.stringify({pid:record.pid,socket,screenshot:path.join(root,'desktop.png'),independent:true},null,2));
} finally {driver?.close();}
