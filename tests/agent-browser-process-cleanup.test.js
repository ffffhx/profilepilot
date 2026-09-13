const test=require('node:test');const assert=require('node:assert/strict');
const {isDriverProcess,temporaryBrowserChildren}=require('../dist/main/agent-browser-process-cleanup.js');
const {classifyGatewayConnectFailure}=require('../dist/main/agent-browser-wrapper.js');
const driver={pid:10,parentPid:1,command:'"C:\\tools\\agent-browser-win32-x64.exe"'};
const browser={pid:11,parentPid:10,command:'"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new --user-data-dir=C:\\Temp\\agent-browser-chrome-1234-abcd'};
test('temporary browser cleanup requires parent, headless flag and exact temporary directory',()=>{
 assert.equal(isDriverProcess(driver),true);
 assert.equal(isDriverProcess({...driver,command:'node script.js agent-browser'}),false);
 assert.deepEqual(temporaryBrowserChildren([driver,browser],10,'C:\\Temp'),[browser]);
 assert.deepEqual(temporaryBrowserChildren([browser],10,'C:\\Temp'),[browser]);
 for(const unsafe of [{...browser,parentPid:12},{...browser,command:browser.command+' --remote-debugging-pipe'},{...browser,command:browser.command.replace('--headless=new','')},{...browser,command:browser.command.replace('C:\\Temp','C:\\Users\\real-profile')}])assert.deepEqual(temporaryBrowserChildren([driver,unsafe],10,'C:\\Temp'),[]);
 assert.deepEqual(temporaryBrowserChildren([{...driver,command:'notepad.exe'},browser],10,'C:\\Temp'),[]);
});
test('macOS paths and quoted temporary directories are recognized',()=>{
 const p={pid:11,parentPid:10,command:'"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --user-data-dir="/tmp/with space/agent-browser-chrome-abcd"'};
 assert.deepEqual(temporaryBrowserChildren([p],10,'/tmp/with space'),[p]);
 assert.equal(isDriverProcess({pid:10,parentPid:1,command:'/usr/local/bin/agent-browser'}),true);
});
test('connect diagnostics distinguish IPC, authorization, refusal and startup without leaking output',()=>{
 assert.equal(classifyGatewayConnectFailure('Failed to read: os error 10060').code,'AGENT_DRIVER_IPC_TIMEOUT');
 const auth=classifyGatewayConnectFailure('401 Unauthorized ws://localhost/?ticket=SECRET');
 assert.equal(auth.code,'GATEWAY_AUTH_REJECTED');assert.ok(!JSON.stringify(auth).includes('SECRET'));
 assert.equal(classifyGatewayConnectFailure('Connection refused').code,'GATEWAY_CONNECTION_REFUSED');
 assert.equal(classifyGatewayConnectFailure('','ENOENT').code,'AGENT_DRIVER_START_FAILED');
 assert.equal(classifyGatewayConnectFailure('Thread failed to start. 0x800705AF').code,'AGENT_DRIVER_RESOURCE_EXHAUSTED');
 assert.equal(classifyGatewayConnectFailure('unrecognized').code,'GATEWAY_CONNECT_FAILED');
});
