const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { AdbForwarding } = loadCli('src/main/phones/adb-forwarding.ts');

function harness() {
  const h={calls:[],maps:new Map([['tcp:18000','tcp:8765']]),fail:false};
  h.adb={run:async args=>{
    h.calls.push(args);if(h.fail)throw new Error('offline');
    if(args[3]==='--list')return [...h.maps].map(([a,b])=>`PHONE ${a} ${b}`).join('\n');
    if(args[3]==='--remove')h.maps.delete(args[4]);return '';
  },spawn:(args,options)=>{
    h.calls.push(args);const local=args[4]==='tcp:0'?'tcp:18001':args[4];
    const code=h.maps.has(local)?1:0;
    if(!code){h.maps.set(local,args[5]);if(args[4]==='tcp:0')options.stdout(Buffer.from('18001\n'));}
    return {done:Promise.resolve({code,signal:null}),end(){},write:async()=>{},abort(){}};
  }};
  h.forward=new AdbForwarding(h.adb);h.options={stdout(){},stderr(){}};return h;
}
test('port creation cannot rebind another socket and remove-all only removes task-owned mappings',async()=>{
  const h=harness();
  assert.equal((await h.forward.spawn('mine',1,'PHONE',['forward','tcp:18000','tcp:9999'],h.options).done).code,1);
  assert.equal((await h.forward.spawn('mine',1,'PHONE',['forward','tcp:0','tcp:9999'],h.options).done).code,0);
  assert.ok(h.calls.every(c=>c[2]!=='forward'||c[3]==='--no-rebind'));
  assert.throws(()=>h.forward.spawn('other',1,'PHONE',['forward','--remove','tcp:18001'],h.options),/本任务/);
  await h.forward.spawn('mine',1,'PHONE',['forward','--remove-all'],h.options).done;
  assert.deepEqual([...h.maps],[['tcp:18000','tcp:8765']]);
  assert.ok(!h.calls.some(c=>c.includes('--remove-all')));
});
test('failed cleanup retains ownership and a later retry removes only the unchanged owned mapping',async()=>{
  const h=harness();await h.forward.spawn('mine',1,'PHONE',['reverse','tcp:18002','tcp:9999'],h.options).done;
  h.fail=true;await assert.rejects(h.forward.cleanup('mine'),/保留所有权/);assert.equal(h.forward.owners().length,1);
  h.fail=false;await h.forward.cleanup('mine');assert.equal(h.forward.owners().length,0);assert.equal(h.maps.has('tcp:18002'),false);
});
test('external replacement is not deleted during cleanup',async()=>{
  const h=harness();await h.forward.spawn('mine',1,'PHONE',['forward','tcp:18002','tcp:9999'],h.options).done;
  h.maps.set('tcp:18002','tcp:other');await h.forward.cleanup('mine');assert.equal(h.maps.get('tcp:18002'),'tcp:other');
  assert.equal(h.forward.owners().length,0);
});

test('ownership journal survives desktop restart and recovers only orphaned mappings',async t=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pp-forward-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const journal=path.join(root,'forwards.json'),lease=require('node:crypto').randomUUID();
  const h=harness();h.forward=new AdbForwarding(h.adb,journal);
  await h.forward.spawn(lease,7,'PHONE',['forward','tcp:0','tcp:9999'],h.options).done;
  const restarted=new AdbForwarding(h.adb,journal);
  assert.deepEqual(restarted.owners(),[{lease,generation:7}]);
  await restarted.cleanup(lease);
  assert.deepEqual([...h.maps],[['tcp:18000','tcp:8765']]);
  assert.deepEqual(JSON.parse(await fs.readFile(journal,'utf8')),[]);
});
