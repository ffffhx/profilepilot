import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { launchProfilePilotE2e } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const { TaskStore } = require('../dist/main/tasks/store');
const ids = [];
const app = await launchProfilePilotE2e({ env: { CPM_START_VIEW: 'tasks' }, prepareFixture: async ({ dataDir }) => {
  const store = new TaskStore(path.join(dataDir, 'browser-tasks'));
  for (const [index,status] of ['cancelled','completed','failed','partial'].entries()) {
    const task = store.create({prompt:`历史任务 ${index}：只查看已有记录，不重复提交。`,profileId:'isolated:fixture'},'测试浏览器');
    task.status=status; ids.push(task.id);
    task.events=Array.from({length:50},(_,i)=>({id:`step-${index}-${i}`,at:new Date().toISOString(),kind:'system',text:`第 ${i} 次观察，任务 ${index} 的记录。`}));
    if (index===1) {
      task.events.push({id:'previous-answer',at:new Date().toISOString(),kind:'assistant',text:'上次执行结果：'+JSON.stringify({summary:'之前的回复：已找到记录。',evidence:['历史页面'],remaining:[]})});
      task.events.push({id:'followup',at:new Date().toISOString(),kind:'user',text:'只补充今天的记录 <保持原样>'});
      task.result={summary:'已完成核查。',evidence:['核查依据 unique-result'],remaining:[]};
      task.evidencePages=[{version:'1',at:new Date().toISOString(),title:'证据页面',url:'https://example.test',snapshot:'页面内容 unique-evidence <安全显示>'}];
    }
  }
  store.save();
} });
try {
  const d=app.driver;
  const open=async id=>{await d.domClick(`.sidebar-recents [data-task="${id}"]`);await d.waitFor('#steer-task',n=>n.attributes['data-task-id']===id);};
  for(const id of ids) {
    await open(id);
    assert.equal(await d.evaluate('document.querySelector("#task-inspector").hidden'),true);
    assert.equal(await d.evaluate('document.querySelector(".task-process-group").open'),false);
    assert.equal((await d.query('#steering')).disabled,false);
    assert.equal((await d.query('#steer-task button[type=submit]')).disabled,true);
  }
  await open(ids[1]);
  await d.waitFor('.history-answer',n=>n.text.includes('已找到记录'));
  assert.match((await d.query('#event-followup')).text,/只补充今天的记录 <保持原样>/);
  await d.domInput('#steering','保留中文草稿');
  for(const modifier of ['ctrlKey','metaKey']) {
    await d.dispatch('#steering','keydown',{key:'Enter',[modifier]:true});
    assert.equal((await d.query('#steering')).value,'保留中文草稿','Windows/macOS modified Enter never sends');
  }
  await d.dispatch('#steering','compositionstart');
  await d.dispatch('#steering','keydown',{key:'Enter',keyCode:229,isComposing:true});
  await d.dispatch('#steering','compositionend');
  assert.equal((await d.query('#steering')).value,'保留中文草稿');
  await open(ids[0]); await open(ids[1]);
  assert.equal((await d.query('#steering')).value,'保留中文草稿');

  const list=await d.evaluate('window.tasks.list()');
  assert.equal(list.tasks.length,4); assert.ok(list.tasks.every(task=>!('events' in task)&&!('prompt' in task)&&!('observation' in task)));
  const first=await d.evaluate(`window.tasks.detail(${JSON.stringify(ids[1])})`);
  assert.equal(first.task.events.length,52);
  const patch=await d.evaluate(`window.tasks.detail(${JSON.stringify(ids[1])},${first.version})`);
  assert.equal(patch.task,undefined); assert.deepEqual(patch.arrays,{});
  assert.ok(JSON.stringify(patch).length<300,'unchanged selected history is not retransmitted');
  // This direct detail request intentionally changes the server cursor; the UI must recover on its next request.
  await d.evaluate(`window.tasks.updateTaskMetadata(${JSON.stringify(ids[1])},{title:'重命名后的历史任务'})`);
  await d.waitFor('.thread-heading h2',n=>n.text==='重命名后的历史任务');
  assert.equal((await d.query('#steering')).value,'保留中文草稿');

  const search=async(query,id,target)=>{
    await d.domClick('[data-nav=history]'); await d.waitFor('#history-search');
    await d.domInput('#history-search',query);
    await d.waitFor('.task-rows .task-row',n=>n.count===1&&n.attributes['data-task']===id);
    assert.match((await d.query('.task-rows mark')).text,new RegExp(query));
    await d.domClick('.task-rows .task-row');
    await d.waitFor('#steer-task',n=>n.attributes['data-task-id']===id);
    await d.waitFor(`${target} mark`,n=>n.text.includes(query));
  };
  await search('第 17 次观察，任务 0',ids[0],'#event-step-0-17');
  assert.equal(await d.evaluate('document.querySelector("#event-step-0-17").closest("details").open'),true);
  await search('unique-result',ids[1],'#task-result');
  await search('unique-evidence',ids[1],'#task-evidence');
  assert.match((await d.query('#task-evidence')).text,/<安全显示>/);
  assert.equal(await d.evaluate('window.tasks.snapshot().then(s=>s.tasks.find(t=>t.id==='+JSON.stringify(ids[1])+').events.length)'),52);
  console.log('PASS summary-only lists, incremental selected detail, cursor recovery, history/answer/evidence search targets, task switching, draft preservation and Windows/macOS/IME input');
} finally { await app.stop(); }
