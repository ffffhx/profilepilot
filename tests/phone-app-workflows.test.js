const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {loadCli}=require('./cli-test-build.cjs');
const {phoneAppCli}=loadCli('src/main/phones/app-cli.ts');
const {streamAdb}=loadCli('src/main/phones/adb-cli-stream.ts');
function harness(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-app-flow-')),h={root,calls:[],paths:'package:/data/app/base.apk\npackage:/data/app/split.apk',failPull:0,pulls:0};
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const jobs=new Map();
  h.request=async c=>{
    h.calls.push(c);
    if(c.method==='wrapper-start')return {ok:true,data:{lease:randomUUID(),device:{state:{generation:1}}}};
    if(c.method==='adb-start'){
      const args=c.params.args;let output='',code=0;
      if(args.includes('resolve-activity'))output='io.example.app/.MainActivity';
      if(args[0]==='shell'&&args[1]==='pm')output=h.paths;
      if(args[0]==='pull'){h.pulls++;if(h.pulls===h.failPull){code=1;output='failed';}else fs.writeFileSync(args[2],Buffer.from([0,255,10,h.pulls]));}
      const jobId=randomUUID();jobs.set(jobId,{status:'completed',code,nextOffset:1,drained:true,chunks:[{channel:'stdout',data:Buffer.from(output).toString('base64')}]});
      return {ok:true,data:{jobId}};
    }
    if(c.method==='adb-status')return {ok:true,data:jobs.get(c.params.jobId)};
    return {ok:true,data:{}};
  };
  h.run=async input=>{const file=path.join(root,'params.json');fs.writeFileSync(file,JSON.stringify(input));let output='';
    const code=await phoneAppCli(new Map([['--device','PHONE'],['--params-file',file]]),h.request,{stdout:{write:s=>output+=s},stderr:{write(){}}});
    return {code,result:JSON.parse(output)};};return h;
}
test('app launch resolves the selected package and quotes the exact component under one control lease',async t=>{
  const h=harness(t);assert.equal((await h.run({operation:'launch',packageName:'io.example.app'})).code,0);
  assert.equal(h.calls[0].params.mode,'control');
  assert.deepEqual(h.calls.filter(c=>c.method==='adb-start').map(c=>c.params.args),[
    ['shell','cmd','package','resolve-activity','--brief','io.example.app'],['shell',"'am' 'start' '-W' '-n' 'io.example.app/.MainActivity'"]]);
  assert.equal(h.calls.at(-1).method,'wrapper-stop');
});
test('export acquires all split APKs with exact hashes and partial failures preserve completed files',async t=>{
  const h=harness(t),directory=path.join(h.root,'export');h.failPull=2;
  const {code,result}=await h.run({operation:'export',packageName:'io.example.app',outputDir:directory});
  assert.equal(code,1);assert.equal(result.coverage,'partial');assert.equal(result.artifacts.length,1);assert.equal(h.calls[0].params.mode,'view');
  const bytes=fs.readFileSync(result.artifacts[0].path);assert.equal(result.artifacts[0].sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(h.calls.at(-1).method,'wrapper-stop');
});
test('export refuses colliding names and preexisting output directories before transfer',async t=>{
  const h=harness(t);h.paths='package:/data/app/base.apk\npackage:/other/base.apk';
  assert.equal((await h.run({operation:'export',packageName:'io.example.app',outputDir:path.join(h.root,'new')})).code,1);assert.equal(h.pulls,0);
  h.paths='package:/data/app/base.apk';assert.equal((await h.run({operation:'export',packageName:'io.example.app',outputDir:h.root})).code,1);assert.equal(h.pulls,0);
});
test('invalid stdin file fails before a command starts and never emits an unhandled stream error',async t=>{
  const h=harness(t);await assert.rejects(streamAdb(['exec-in','cat'],'lease',1,h.request,{stdout:{write(){}},stderr:{write(){}}},{input:path.join(h.root,'missing')}),/ENOENT/);
  assert.equal(h.calls.length,0);await new Promise(r=>setTimeout(r,30));
});
