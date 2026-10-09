const test = require('node:test');
const assert = require('node:assert/strict');
const {loadTsModule} = require('./helpers/load-ts-module');
const {taskChatRows,ChatRowCache} = loadTsModule('src/renderer/task-chat-model.ts');
const task = patch => ({id:'task',prompt:'最初要求',status:'running',events:[],receipts:[],usage:{actions:0},...patch});
test('one message identity survives deltas, completion and an overlapping stale delta', () => {
  const draft = task(), stream={id:'response:1',text:'一段 **回复',updatedAt:''};
  const live = taskChatRows(draft,stream).at(-1);
  draft.events.push({id:'saved',kind:'assistant',text:'一段 **回复**',streamId:stream.id});
  draft.status='completed';draft.result={kind:'answer',summary:'一段 **回复**',evidence:['来源'],remaining:[]};
  const rows=taskChatRows(draft,stream);
  assert.equal(rows.length,2);assert.equal(rows[1].id,live.id);assert.equal(rows[1].streaming,undefined);
  assert.equal(rows[1].final,true);assert.match(rows[1].supplement,/来源/);
});
test('historical rows are reused while the active reply alone changes',()=>{
  const cache=new ChatRowCache(),draft=task({events:[{id:'a',kind:'assistant',text:'已完成的历史'}]});
  const first=cache.update(taskChatRows(draft,{id:'b',text:'新',updatedAt:''}));
  const second=cache.update(taskChatRows(structuredClone(draft),{id:'b',text:'新的回复',updatedAt:''}));
  assert.equal(first[0],second[0]);assert.equal(first[1],second[1]);assert.notEqual(first[2],second[2]);
});
test('tool groups, repeated user turns and separate text blocks are retained in order',()=>{
  const rows=taskChatRows(task({events:[{id:'prompt-event',kind:'user',text:'最初要求'},{id:'tool',kind:'action',text:'操作'},{id:'error',kind:'error',text:'失败'},{id:'a',kind:'assistant',text:'第一块',streamId:'r'},{id:'b',kind:'assistant',text:'第二块',streamId:'r:2'},{id:'u1',kind:'user',text:'继续'},{id:'u2',kind:'user',text:'继续'}]}));
  assert.equal(rows[1].events.length,2);assert.equal(rows[2].text,'第一块');assert.equal(rows[3].text,'第二块');
  assert.equal(rows.filter(r=>r.text==='继续').length,2);assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);
});
test('interrupted replies retain content and a distinct completion status',()=>{
  const rows=taskChatRows(task({status:'cancelled',events:[{id:'partial',kind:'assistant',text:'保留这段输出',streamId:'stopped'}]}));
  assert.equal(rows[1].text,'保留这段输出');assert.match(rows.at(-1).text,/已停止/);
});
