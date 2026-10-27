const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {parseRemoteCliArgs,runRemoteCli}=require('../dist/main/remote-control-cli.js');
const {runProfilePilotCli}=require('../dist/main/profilepilot-cli.js');
const {RemoteSessionStore}=require('../dist/main/remote-control-client.js');
const session='a'.repeat(32);
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
