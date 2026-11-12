const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {parseRemoteCliArgs,runRemoteCli}=require('../dist/main/remote-control-cli.js');
const {runProfilePilotCli}=require('../dist/main/profilepilot-cli.js');
const {RemoteSessionStore}=require('../dist/main/remote-control-client.js');
const session='a'.repeat(32);
const {remoteActionFeedback,saveRemoteFeedbackImages}=require('../dist/main/remote-control-cli.js');

test('remote fallback waits then observes the same target and lease without replaying input',async()=>{
  for(const operation of ['browser.action','browser.navigate','window.action']){
    const calls=[],command={kind:'execute',json:true,session,operation,params:{browserId:'browser-1',windowId:'window-2'}};
    const started=Date.now();
    const result=await remoteActionFeedback(command,{requestId:'input-receipt',result:{executed:true}},async message=>{calls.push(message);return {result:{exitCode:0,data:{version:'new',elements:[{name:'Saved'}]}}};});
    assert.ok(Date.now()-started>=450);assert.equal(result.actionOutcome,'completed');assert.equal(result.observationStatus,'available');
    assert.equal(result.observation.version,'new');assert.equal(result.requestId,'input-receipt');assert.equal(calls.length,1);
    assert.equal(calls[0].params.session,session);assert.notEqual(calls[0].params.requestId,'input-receipt');
    assert.equal(calls[0].params.operation,operation.startsWith('browser.')?'browser.observe':'window.observe');
    assert.deepEqual(calls[0].params.params,operation.startsWith('browser.')?{browserId:'browser-1'}:{windowId:'window-2'});
  }
});

test('remote preserves upstream feedback without duplicating trees or extra reads',async()=>{
  const command={kind:'execute',json:true,session,operation:'browser.action',params:{browserId:'b'}};
  for(const status of ['available','unavailable']){
    const result=await remoteActionFeedback(command,{result:{exitCode:0,data:{actionOutcome:'completed',observationStatus:status,observation:status==='available'?{version:'fresh'}:undefined,nextStep:status==='available'?'use-observation':'observe-or-check-control'}}},async()=>assert.fail('redundant read'));
    assert.equal(result.observationStatus,status);assert.equal(result.result,undefined);
  }
  for(const result of [{result:{exitCode:75,data:{ok:false,code:'STOPPED'}}},{result:{ok:false,code:'UNKNOWN'}},{executed:false},{actionOutcome:'unknown'}])assert.equal(await remoteActionFeedback(command,result,async()=>assert.fail('must not observe uncertain input')),result);
  const plain={executed:true};assert.equal(await remoteActionFeedback({...command,observeAfter:false},plain,async()=>assert.fail('opted out')),plain);
});

test('remote unavailable observations retain input completion, including target and image failures',async t=>{
  const command={kind:'execute',json:true,session,operation:'window.action',params:{windowId:'w'}};
  for(const read of [async()=>{throw Error('disconnected');},async()=>({result:{ok:false,code:'USER_IN_CONTROL'}}),async()=>({result:{ok:true}})]){
    const result=await remoteActionFeedback(command,{executed:true},read);
    assert.equal(result.actionOutcome,'completed');assert.equal(result.observationStatus,'unavailable');assert.equal(result.observation,undefined);
  }
  const missing=await remoteActionFeedback({...command,params:{}},{executed:true},async()=>assert.fail('must not guess target'));
  assert.equal(missing.observationStatus,'unavailable');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'remote-feedback-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const output=path.join(home,'exists.png');await fs.writeFile(output,'keep');
  const result=await saveRemoteFeedbackImages({actionOutcome:'completed',observationStatus:'available',observation:{image:{mimeType:'image/png',data:'c2VjcmV0'}}},{...command,output},home);
  assert.equal(result.actionOutcome,'completed');assert.equal(result.observationStatus,'unavailable');assert.doesNotMatch(JSON.stringify(result),/c2VjcmV0/);assert.equal(await fs.readFile(output,'utf8'),'keep');
});
test('remote parser preserves exact target IDs and requires deliberate profile deletion and action JSON',()=>{
  assert.equal(parseRemoteCliArgs(['browser','navigate','--session',session,'--browser','b','--tab','t12']).params.tabId,'t12');
  assert.equal(parseRemoteCliArgs(['profile','rename','--session',session,'--profile','isolated:test','--name','中文 & $() `']).params.name,'中文 & $() `');
  assert.throws(()=>parseRemoteCliArgs(['profile','delete','--session',session,'--profile','isolated:test']),/--yes/);
  assert.throws(()=>parseRemoteCliArgs(['window','action','--session',session]),/JSON/);
  assert.throws(()=>parseRemoteCliArgs(['browser','navigate','--session',session,'--browser','b','--tab','t1','--url','https://example.com']),/URL/);
  assert.throws(()=>parseRemoteCliArgs(['connect','id','--lease-seconds','0']),/租约/);
});
test('top-level remote help routes without requiring the ProfilePilot application',async()=>{
  let output='';const code=await runProfilePilotCli(['remote','--help'],{stdout:{write:s=>output+=s},stderr:{write:()=>{}}},{request:()=>{throw new Error('Must not start App');}});
  assert.equal(code,0);assert.match(output,/ppilot remote/);assert.match(output,/disconnect/);
});
test('real CLI transport stores lease credentials privately, writes image files, reports stops and refuses stale servers',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'ppilot-remote-'));const token='b'.repeat(64),leaseToken='c'.repeat(64),endpoint=path.join(home,'endpoint.json');
  const address=process.platform==='win32'?'\\\\.\\pipe\\ClipRelay-AI-'+crypto.randomBytes(16).toString('hex'):path.join(home,'test.sock');
  let supported=true,fail=false;const seen=[],sockets=new Set();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setEncoding('utf8');let buffer='';
    socket.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);seen.push(message);let result;
      if(message.token){assert.equal(message.token,token);result={protocol:1,...supported?{cliLeaseProtocol:1}:{}};}
      else if(message.method==='connect')result={session,leaseToken,deviceId:'paired:test',name:'fixture',expiresAt:Date.now()+300000,leaseSeconds:300};
      else if(message.method==='disconnect')result={closed:true};
      else if(fail)result={result:{exitCode:75,data:{ok:false,code:'AGENT_USER_IN_CONTROL'}}};
      else result={requestId:message.params.requestId,result:{image:{mimeType:'image/png',data:Buffer.from('fixture pixels').toString('base64')}}};
      socket.write(JSON.stringify({id:message.id,ok:true,result})+'\n');
    }});
  });await new Promise(resolve=>server.listen(address,resolve));await fs.writeFile(endpoint,JSON.stringify({protocol:1,address,token}));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(home,{recursive:true,force:true});});
  const run=async args=>{let output='';const code=await runRemoteCli([...args,'--json'],{stdout:{write:s=>output+=s},stderr:{write:()=>{}}},{homeDir:home,env:{...process.env,PROFILEPILOT_REMOTE_ENDPOINT:endpoint}});assert.ok(!output.includes(token));assert.ok(!output.includes(leaseToken));return {code,data:JSON.parse(output)};};
  const opened=await run(['connect','paired:test']);assert.equal(opened.code,0);assert.equal(opened.data.session,session);
  const store=new RemoteSessionStore(home);assert.equal((await store.read(session)).leaseToken,leaseToken);
  const image=await run(['window','screenshot','--session',session,'--window','w']);assert.equal(image.code,0);assert.equal(await fs.readFile(image.data.result.image.path,'utf8'),'fixture pixels');assert.equal(image.data.result.image.data,undefined);
  assert.ok(seen.some(m=>m.client==='cli'&&m.session===session&&m.leaseToken===leaseToken));
  fail=true;assert.equal((await run(['windows','--session',session])).code,75);
  assert.equal((await run(['disconnect','--session',session])).code,0);assert.deepEqual((await store.list()).sessions,[]);
  supported=false;assert.equal((await run(['devices'])).code,69);
});
