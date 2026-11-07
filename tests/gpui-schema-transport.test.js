const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { GpuiMcpClient } = loadCli('src/main/gpui/mcp.ts');

function fixture(t, repeated = false) {
  const script = `let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{buffer+=text;let at;while((at=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(!m.id)continue;let result;if(m.method==='initialize')result={capabilities:{tools:{}}};else if(m.method==='tools/list')result={tools:[{name:m.params.cursor?'set_text':'click_element',inputSchema:{type:'object',required:['id'],properties:{id:{type:'string'}},additionalProperties:false}}],...(${repeated}||!m.params.cursor?{nextCursor:'next'}:{})};else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{message:'Unexpected request '+m.method}})+'\\n');continue;}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`;
  const client = new GpuiMcpClient(process.execPath, { args: ['-e', script], timeoutMs: 2000 });
  t.after(() => client.close()); return client;
}

test('GPUI schema transport retrieves paginated tools without selecting or calling applications', async t => {
  const tools = await fixture(t).tools();
  assert.deepEqual(tools.map(tool => tool.name), ['click_element', 'set_text']);
  assert.deepEqual(tools[0].inputSchema.required, ['id']);
});

test('GPUI schema transport refuses a repeated cursor instead of looping', async t => {
  await assert.rejects(fixture(t, true).tools(), { code: 'GPUI_PROTOCOL_ERROR' });
});
