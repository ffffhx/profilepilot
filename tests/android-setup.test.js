const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {loadCli} = require('./cli-test-build.cjs');
const {AndroidSetup} = loadCli('src/main/phones/android-setup.ts');
const {parseAndroidCatalog,androidHost} = loadCli('src/main/phones/android-repository.ts');
const {downloadAndroidArchive} = loadCli('src/main/phones/android-install-io.ts');
const {executePhoneCommand} = loadCli('src/main/phones/management.ts');
const {baseXml,imageXml,createAndroidFixture,waitAndroidJob,write} = require('./fixtures/android-setup.cjs');
function fixture(t, options) {
  // Installation is simulated; host disk capacity must not decide its result.
  const {freeSpaceBytes=64*1024**3,...setupOptions}=options||{};
  t.mock.method(fs,'statfsSync',()=>({bsize:4096,bavail:Math.floor(freeSpaceBytes/4096)}));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-android-setup-'));
  const h=createAndroidFixture(AndroidSetup,root,setupOptions);
  t.after(async()=>{await h.runtime.close();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});return {...h,root};
}
async function install(h) {const s=await h.runtime.catalog();await h.runtime.start({kind:'environment',licenseToken:s.licenseToken});const done=await waitAndroidJob(h.runtime);assert.equal(done.job.status,'succeeded',done.job.error);return done;}
async function image(h) {const s=await install(h);await h.runtime.start({kind:'image',imageId:s.images[0].id,licenseToken:s.licenseToken});const done=await waitAndroidJob(h.runtime);assert.equal(done.job.status,'succeeded',done.job.error);return done;}

test('official catalog chooses Windows/Intel and Apple Silicon images and rejects missing licenses',()=>{
  const win=parseAndroidCatalog(baseXml,imageXml,'win32','x64'),mac=parseAndroidCatalog(baseXml,imageXml,'darwin','arm64');
  assert.equal(win.images[0].abi,'x86_64');assert.equal(mac.images[0].abi,'arm64-v8a');
  assert.match(win.tools.url,/windows/);assert.match(mac.tools.url,/macosx/);assert.equal(mac.licenses[0].text,'Android test license & conditions.');
  assert.throws(()=>parseAndroidCatalog(baseXml.replace(/<license.*?<\/license>/,''),imageXml.replace(/<license.*?<\/license>/,''),'win32','x64'),/许可/);
  assert.throws(()=>parseAndroidCatalog('<!DOCTYPE evil>'+baseXml,imageXml,'win32','x64'),/格式/);
  assert.throws(()=>androidHost('win32','arm64'),/暂不支持/);
});
test('no installation occurs on inspection or without current license consent',async t=>{
  const h=fixture(t);await h.runtime.snapshot();assert.equal(fs.existsSync(h.sdkRoot),false);
  await h.runtime.catalog();assert.equal(h.calls.length,0);
  await assert.rejects(h.runtime.start({kind:'environment',licenseToken:''}),/许可/);
  assert.equal(fs.existsSync(h.sdkRoot),false);
});
test('fresh install, image download and AVD creation are verified and do not overwrite an existing device',async t=>{
  const h=fixture(t),s=await image(h);assert.ok(s.ready);assert.ok(s.images[0].installed);
  const action={kind:'create',imageId:s.images[0].id,name:'My_Phone',memoryMb:4096,storageGb:8};
  await h.runtime.start(action);const done=await waitAndroidJob(h.runtime);assert.equal(done.job.status,'succeeded',done.job.error);
  const config=fs.readFileSync(path.join(h.avdHome,'My_Phone.avd/config.ini'),'utf8');assert.match(config,/hw.ramSize=4096/);assert.match(config,/disk.dataPartition.size=8G/);
  await assert.rejects(h.runtime.start(action),/同名/);assert.equal(fs.readFileSync(path.join(h.avdHome,'My_Phone.avd/config.ini'),'utf8'),config);
  assert.ok(h.calls.every(c=>!c.args.includes('--force')));assert.ok(h.calls.every(c=>c.env.ANDROID_SDK_ROOT===h.sdkRoot));
  assert.ok(h.calls.every(c=>c.args[0].startsWith('-Dcom.android.sdkmanager.toolsdir=')));
  assert.equal(fs.readdirSync(path.join(h.sdkRoot,'.profilepilot')).some(n=>n.startsWith('install-')),false);
});
test('macOS Java bundle and space-containing paths use argument arrays with native architecture',async t=>{
  const h=fixture(t,{platform:'darwin',arch:'arm64'}),s=await image(h);
  assert.equal(s.images[0].abi,'arm64-v8a');assert.ok(h.calls[0].file.endsWith(path.join('Contents','Home','bin','java')));
  assert.ok(h.calls[0].args.includes('--sdk_root='+h.sdkRoot));
});
test('insufficient AVD disk space rejects creation before invoking tools',async t=>{
  const h=fixture(t,{freeSpaceBytes:6*1024**3}),s=await image(h),before=h.calls.length;
  await assert.rejects(h.runtime.start({kind:'create',imageId:s.images[0].id,name:'LowSpace',memoryMb:4096,storageGb:8}),/磁盘空间不足.*10 GB/);
  assert.equal(h.calls.length,before);
  assert.equal(fs.existsSync(path.join(h.avdHome,'LowSpace.ini')),false);
});
test('incompatible images and invalid paths are rejected before invoking tools',async t=>{
  const h=fixture(t),s=await image(h),before=h.calls.length;
  for(const name of ['../escape','a;calc','-force','a.b'])await assert.rejects(h.runtime.start({kind:'create',name,imageId:s.images[0].id,memoryMb:2048,storageGb:8}));
  await assert.rejects(h.runtime.start({kind:'image',imageId:s.images[0].id.replace('x86_64','arm64-v8a'),licenseToken:s.licenseToken}),/适合/);
  await assert.rejects(executePhoneCommand({method:'android-setup-start',params:{kind:'environment',licenseToken:s.licenseToken,arbitraryPath:'bad'}},{androidSetup:h.runtime}));
  assert.equal(h.calls.length,before);
});
test('concurrent installation requests serialize; cancellation settles before retry',async t=>{
  const h=fixture(t),s=await install(h);h.behavior.hang=true;
  const action={kind:'image',imageId:s.images[0].id,licenseToken:s.licenseToken};
  const results=await Promise.allSettled([h.runtime.start(action),h.runtime.start(action)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await assert.rejects(h.runtime.cancel('stale-job'),/变化/);
  const current=await h.runtime.snapshot();await h.runtime.cancel(current.job.id);assert.equal((await waitAndroidJob(h.runtime)).job.status,'cancelled');
  h.behavior.hang=false;await h.runtime.start(action);assert.equal((await waitAndroidJob(h.runtime)).job.status,'succeeded');
});
test('network failure and partial image installation can be retried without losing environment',async t=>{
  const h=fixture(t);h.behavior.failCatalog=true;assert.match((await h.runtime.catalog()).catalogError,/网络/);h.behavior.failCatalog=false;
  const s=await install(h);h.behavior.failImage=true;const action={kind:'image',imageId:s.images[0].id,licenseToken:s.licenseToken};
  await h.runtime.start(action);const failed=await waitAndroidJob(h.runtime);assert.equal(failed.job.status,'failed');assert.ok(failed.ready);assert.equal(failed.images[0].installed,false);
  await h.runtime.start(action);assert.equal((await waitAndroidJob(h.runtime)).job.status,'succeeded');
});
test('downloader enforces official checksum and exact byte count before extraction',async t=>{
  const h=fixture(t),data=Buffer.from('download fixture'),archive={url:'https://example.test/file.zip',bytes:data.length,algorithm:'sha256',checksum:createHash('sha256').update(data).digest('hex')};
  const signal=new AbortController().signal;const progress=[];
  await downloadAndroidArchive(archive,path.join(h.root,'good.zip'),async()=>new Response(data),signal,p=>progress.push(p));assert.equal(progress.at(-1),100);
  await assert.rejects(downloadAndroidArchive({...archive,checksum:'f'.repeat(64)},path.join(h.root,'bad.zip'),async()=>new Response(data),signal,()=>{}),/校验/);
  await assert.rejects(downloadAndroidArchive(archive,path.join(h.root,'short.zip'),async()=>new Response(data.subarray(1)),signal,()=>{}),/校验/);
});
