const {test}=require('node:test');
const assert=require('node:assert/strict');
const {executeProfilePilotManagementCommand}=require('../dist/main/profilepilot-management-server.js');
const {parseProfilePilotCliArgs}=require('../dist/main/profilepilot-cli.js');

test('CLI lifecycle commands report status and dispatch one graceful quit or restart',async()=>{
  const calls=[];
  const options={profileManager:{},appLifecycle:{status:()=>({channel:'development',sourceRoot:'fixture'}),request:method=>calls.push(method)}};
  for(const method of ['status','quit','restart']){
    const parsed=parseProfilePilotCliArgs(['app',method,'--json']);
    const result=await executeProfilePilotManagementCommand(parsed.command,options);
    assert.equal(result.pid,process.pid);
    assert.equal(result.channel,'development');
    assert.equal(result.accepted,method==='status'?undefined:true);
  }
  assert.deepEqual(calls,['quit','restart']);
  assert.throws(()=>parseProfilePilotCliArgs(['app','kill']));
  await assert.rejects(executeProfilePilotManagementCommand({action:'app',method:'quit'},{profileManager:{}}),/退出.*重启/);
  await assert.rejects(executeProfilePilotManagementCommand({action:'app',method:'kill'},options),/不支持/);
});
