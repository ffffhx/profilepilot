import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'native/phone-video/PhoneVideo.java');
const output=path.join(root,'public/phone-video');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceHash=()=>hash(readFileSync(source,'utf8').replaceAll('\r\n','\n'));
if(process.argv.includes('--check')) {
  const manifest=JSON.parse(readFileSync(path.join(output,'manifest.json'),'utf8'));
  if(manifest.sourceSha256!==sourceHash()||manifest.dexSha256!==hash(readFileSync(path.join(output,'preview.dex'))))throw Error('Phone video component is stale. Run npm run build:phone-video.');
} else {
  const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||(process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'Android','Sdk'):process.platform==='darwin'?path.join(os.homedir(),'Library/Android/sdk'):path.join(os.homedir(),'Android/Sdk'));
  const newest=folder=>readdirSync(path.join(sdk,folder)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))[0];
  const library=path.join(sdk,'platforms',newest('platforms'),'android.jar');
  const classes=path.join(root,'artifacts/phone-video-build/classes'),dex=path.join(root,'artifacts/phone-video-build/dex');
  for(const dir of [output,classes,dex])mkdirSync(dir,{recursive:true});
  function run(name,args){const executable=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',name+(process.platform==='win32'?'.exe':'')):name;const r=spawnSync(executable,args,{windowsHide:true,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)throw Error(`Phone video compilation failed (${r.status})`);}
  run('javac',['-encoding','UTF-8','-source','17','-target','17','-classpath',library,'-d',classes,source]);
  run('java',['-cp',path.join(sdk,'build-tools',newest('build-tools'),'lib/d8.jar'),'com.android.tools.r8.D8','--min-api','30','--lib',library,'--output',dex,...readdirSync(classes,{recursive:true}).filter(f=>f.endsWith('.class')).map(f=>path.join(classes,f))]);
  copyFileSync(path.join(dex,'classes.dex'),path.join(output,'preview.dex'));
  writeFileSync(path.join(output,'manifest.json'),JSON.stringify({version:1,sourceSha256:sourceHash(),dexSha256:hash(readFileSync(path.join(output,'preview.dex')))},null,2)+'\n');
}
console.log('Phone video component verified');
