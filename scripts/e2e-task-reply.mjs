import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { launchProfilePilotE2e } from './e2e/lib/electron-driver.mjs';
const require=createRequire(import.meta.url);
const { TaskStore }=require('../dist/main/tasks/store');
const ids={};
const app=await launchProfilePilotE2e({env:{CPM_START_VIEW:'tasks'},prepareFixture:async({dataDir})=>{
  const store=new TaskStore(path.join(dataDir,'browser-tasks'));
  for(const kind of ['handoff','question','confirmation','offline']){
    const t=store.create({prompt:`回复验收 ${kind}`,profileId:'native:fixture'},'测试');
    ids[kind]=t.id;t.status='waiting_user';
    if(kind==='offline')t.browserConnection='extension';
    t.pending={id:randomUUID(),kind:kind==='offline'?'handoff':kind,title:'请补充说明',details:'测试回复输入',createdAt:new Date().toISOString()};
  }
  store.save();
}});
try{
  const d=app.driver;
  const messages=id=>d.evaluate(`window.tasks.snapshot().then(s=>s.tasks.find(t=>t.id===${JSON.stringify(id)}).events.filter(e=>e.kind==='user').map(e=>e.text))`);
  const idle=()=>d.waitFor('#task-app',n=>n.attributes['aria-busy']!=='true');
  for(const [kind,mod] of [['handoff','ctrlKey'],['question','metaKey']]){
    console.log('Checking reply shortcut: '+kind);
    await d.domClick(`[data-task="${ids[kind]}"]`);
    let text=`${kind}：保留页面并继续`;
    await d.domInput('#answer',text);
    const before=(await messages(ids[kind])).length;
    await d.evaluate('document.querySelector("#answer").setSelectionRange(3, 6)');
    await d.dispatch('#answer','keydown',{key:'Enter',[mod]:true});
    text=text.slice(0,3)+'\n'+text.slice(6);
    assert.equal(await d.evaluate('document.querySelector("#answer").value'),text,'modifier Enter must replace the selection with a newline');
    assert.equal((await messages(ids[kind])).length,before,'modifier Enter must not send');
    assert.equal(await d.evaluate('document.querySelector("#answer").selectionStart'),4,'caret must follow the inserted newline');
    await d.dispatch('#answer','compositionstart');
    await d.dispatch('#answer','keydown',{key:'Enter'});
    assert.equal((await messages(ids[kind])).length,before,'IME confirmation must not send');
    await d.dispatch('#answer','compositionend');
    await d.dispatch('#answer','keydown',{key:'Enter',isComposing:true});
    await d.dispatch('#answer','keydown',{key:'Enter',keyCode:229});
    assert.equal((await messages(ids[kind])).length,before,'IME Enter variants must not send');
    await d.dispatch('#answer','keydown',{key:'Enter'});
    await idle();
    assert.equal((await messages(ids[kind])).filter(x=>x===text).length,1,JSON.stringify({kind,messages:await messages(ids[kind]),ui:await d.evaluate('({answer:document.querySelector("#answer")?.value,toast:document.querySelector("#task-toast")?.textContent,kind:document.querySelector("#reply-task")?.dataset.decisionKind,disabled:document.querySelector("#reply-task button[type=submit]")?.disabled})')}));
    assert.equal(await d.evaluate('window.tasks.snapshot().then(s=>s.tasks.length)'),4,'reply must preserve session');
  }
  console.log('Checking confirmation shortcut protection');
  await d.domClick(`[data-task="${ids.offline}"]`);
  await d.evaluate('document.querySelector("#reply-task").dataset.decisionKind="confirmation"');
  const count=(await messages(ids.offline)).length;
  await d.domInput('#answer','这只是补充说明');
  await d.dispatch('#answer','keydown',{key:'Enter'});
  await d.dispatch('#answer','keydown',{key:'Enter',ctrlKey:true});
  await d.dispatch('#answer','keydown',{key:'Enter',metaKey:true});
  assert.equal((await messages(ids.offline)).length,count,'shortcut must not authorize a confirmation');
  await d.evaluate('document.querySelector("#reply-task").dataset.decisionKind="handoff"');
  console.log('Checking offline error and draft preservation');
  await d.domInput('#answer','连接恢复后请继续');
  assert.match((await d.query('#reply-task button[value=approve]')).text,/发送并继续/);
  await d.domClick('#reply-task button[value=approve]');await idle();
  assert.ok((await d.query('#reply-task [role=alert]')).text.length>0,'connection error must remain visible');
  assert.equal(await d.evaluate('document.querySelector("#answer").value'),'连接恢复后请继续');
  assert.equal((await messages(ids.offline)).includes('连接恢复后请继续'),false,'failed resume must not duplicate the answer');
  console.log('PASS reply UI: Enter sends, Ctrl/Meta Enter inserts newline at selection, IME, explicit confirmations, same session, visible errors and preserved drafts');
}finally{await app.stop();}
