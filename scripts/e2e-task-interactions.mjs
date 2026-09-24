import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchProfilePilotE2e, repoRoot } from "./e2e/lib/electron-driver.mjs";

const app = await launchProfilePilotE2e({ name: "task interaction audit" });
const dir = path.join(repoRoot, "test-results", "browser-tasks", "interaction-audit");
await mkdir(dir, { recursive: true });
try {
  const d = app.driver;
  const settle = async () => {
    await d.waitFor('#task-app', s => s.attributes['aria-busy'] !== 'true');
    await new Promise(resolve => setTimeout(resolve, 350));
  };
  const screenshot = async name => {
    await settle();
    // A hidden Electron window can return its previous compositor frame on the
    // first capture. Wake painting, then capture the settled frame for review.
    await d.screenshot();
    await new Promise(resolve => setTimeout(resolve, 250));
    await writeFile(path.join(dir, name), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  };
  for (const name of ["工作账号", "招聘专用", "团队资料 — 一个很长的浏览器名称用于检查换行和菜单边界", "客户后台", "资料整理", "临时测试"]) {
    await d.evaluate(`window.profileManager.createProfile(${JSON.stringify(name)})`);
  }
  await d.domClick('[data-workspace-trigger]');
  await d.domClick('a[href="./tasks.html"]');
  await d.waitFor('#create-task .select-trigger');
  await d.domClick('#create-task .send-task');
  assert.match((await d.query('#prompt-error')).text, /填写/);
  assert.equal(await d.evaluate('document.activeElement.id'), 'prompt');
  await d.domInput('#prompt', '保留这份任务草稿');
  assert.equal((await d.query('#prompt-error')).exists, false);
  await d.domClick('#create-task .select-trigger');
  await d.waitFor('.select-popover:popover-open');
  assert.equal(await d.evaluate('document.activeElement.className'), 'select-search');
  // A detected native Chrome profile can appear alongside these six fixtures,
  // depending on the host platform. Check the fixtures instead of a fixed total.
  const optionText = await d.evaluate('[...document.querySelectorAll("[role=option]")].map(option => option.textContent)');
  for (const name of ["工作账号", "招聘专用", "团队资料 — 一个很长的浏览器名称用于检查换行和菜单边界", "客户后台", "资料整理", "临时测试"]) {
    assert.equal(optionText.filter(text => text.includes(name)).length, 1, `Missing or duplicate fixture: ${name}`);
  }
  await d.domInput('.select-search', '招聘');
  assert.equal((await d.query('[role=option]')).count, 1);
  // Snapshot updates must keep an open menu and its search/focus intact.
  await d.evaluate('window.tasks.snapshot().then(({settings}) => window.tasks.saveSettings({...settings, notifications:false}))');
  await d.waitFor('.select-search', s => s.value === '招聘');
  assert.equal(await d.evaluate('document.activeElement.className'), 'select-search');
  await d.dispatch('.select-search', 'compositionstart');
  await d.evaluate('window.__searchDuringComposition = document.querySelector(".select-search")');
  await d.evaluate('window.tasks.snapshot().then(({settings}) => window.tasks.saveSettings({...settings, notifications:true}))');
  assert.equal(await d.evaluate('window.__searchDuringComposition === document.querySelector(".select-search")'), true);
  await d.dispatch('.select-search', 'compositionend');
  await new Promise(resolve => setTimeout(resolve, 100));
  await d.dispatch('.select-search', 'keydown', { key: 'Enter' });
  const selected = await d.evaluate('document.querySelector("select[name=profileId]").value');
  assert.ok(selected);
  assert.match((await d.query('#create-task .select-trigger')).text, /招聘/);
  assert.equal((await d.query('.select-popover')).exists, false);
  assert.equal((await d.query('[aria-invalid=true]')).count, 0);

  // Occupied options remain visible with an explanation, but cannot be chosen.
  await d.evaluate(`(() => { const option=document.querySelector('select[name=profileId]').options[1]; option.disabled=true; option.dataset.description='占用中 · 用户接管'; window.__disabledValue=option.value; })()`);
  await d.domClick('#create-task .select-trigger');
  await d.domClick('[role=option][aria-disabled=true]');
  assert.equal(await d.evaluate('document.querySelector("select[name=profileId]").value'), selected);
  await screenshot('browser-menu.png');
  await d.domInput('.select-search', '不存在的浏览器');
  assert.match((await d.query('.select-empty')).text, /没有匹配/);
  await d.dispatch('.select-search', 'keydown', { key: 'Escape' });
  assert.equal((await d.query('.select-popover')).exists, false);
  assert.equal(await d.evaluate('document.activeElement.className'), 'select-trigger');
  await d.domClick('#create-task .select-trigger');
  await d.dispatch('.select-search', 'keydown', { key: 'ArrowDown' });
  assert.ok(await d.evaluate('document.querySelector(".select-search").getAttribute("aria-activedescendant")'));
  await d.dispatch('.select-search', 'keydown', { key: 'Tab' });
  assert.equal((await d.query('.select-popover')).exists, true, 'Tab can reach the connect-system-Chrome footer');
  await d.evaluate('document.querySelector(".select-popover .model-service-link").focus({preventScroll:true})');
  await d.dispatch('.select-popover .model-service-link', 'keydown', { key: 'Tab' });
  assert.equal((await d.query('.select-popover')).exists, false);
  await d.domClick('#create-task .select-trigger');
  await d.dispatch('#prompt', 'pointerdown');
  assert.equal((await d.query('.select-popover')).exists, false);
  for (const corner of ['top-left', 'bottom-right']) {
    await d.evaluate(`(() => {
      const trigger=document.querySelector('#create-task .select-trigger');
      Object.assign(trigger.style,{position:'fixed',width:'220px',top:${JSON.stringify(corner)}==='top-left'?'80px':(innerHeight-70)+'px',left:${JSON.stringify(corner)}==='top-left'?'12px':(innerWidth-230)+'px'});
    })()`);
    await d.domClick('#create-task .select-trigger');
    const bounds = await d.evaluate(`(() => { const r=document.querySelector('.select-popover').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}; })()`);
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, JSON.stringify(bounds));
    await d.dispatch('.select-search', 'keydown', {key:'Escape'});
  }
  await d.evaluate('document.querySelector("#create-task .select-trigger").removeAttribute("style")');

  await d.domClick('#create-task details summary');
  await d.domInput('[name=templateName]', '未保存的模板名称');
  await d.domClick('#agent-model-trigger');
  await d.waitFor('.model-service-link');
  await d.domClick('.model-service-link');
  assert.equal(await d.evaluate('document.activeElement.id'), 'model');
  await d.domInput('#model', 'draft-model');
  await d.domClick('[data-action=test-connection]');
  await d.waitFor('#task-toast', s => s.text.includes('模型配置尚未保存'));
  await settle();
  await d.domClick('[data-nav=materials]');
  await d.domInput('#material-name', '未保存的资料');
  await d.domInput('#material-content', '切换页面后需要保留');
  await d.domClick('[data-nav=schedules]');
  await d.domInput('#schedule-form [name=name]', '未保存的计划');
  await d.domClick('[data-nav=settings]');
  assert.equal(await d.evaluate('document.querySelector("#model").value'), 'draft-model');
  await d.domClick('[data-nav=schedules]');
  assert.equal(await d.evaluate('document.querySelector("#schedule-form [name=name]").value'), '未保存的计划');
  await d.domClick('[data-nav=tasks]');
  assert.equal(await d.evaluate('document.querySelector("#prompt").value'), '保留这份任务草稿');
  assert.equal(await d.evaluate('document.querySelector("[name=templateName]").value'), '未保存的模板名称');
  assert.equal(await d.evaluate('document.querySelector("#create-task details").open'), true);
  await d.domClick('[data-example]');
  assert.match(await d.evaluate('document.querySelector("#prompt").value'), /^保留这份任务草稿/);

  await d.domClick('[data-nav=materials]');
  assert.equal(await d.evaluate('document.querySelector("#material-content").value'), '切换页面后需要保留');
  await d.domClick('#material-form .primary');
  await d.waitFor('.material-body');
  assert.equal(await d.evaluate('document.querySelector("#material-name").value'), '');
  await d.domClick('[data-delete-material]');
  await d.waitFor('.task-confirm[open]');
  assert.match((await d.query('.task-confirm')).text, /删除这份资料/);
  await d.domClick('.task-confirm button[value=cancel]');
  assert.equal((await d.evaluate('window.tasks.snapshot()')).materials.length, 1);
  await d.domClick('[data-delete-material]');
  await screenshot('delete-confirmation.png');
  await d.domClick('[data-confirm-action]');
  await d.waitFor('#task-toast', s => s.text.includes('资料已删除'));
  assert.equal((await d.evaluate('window.tasks.snapshot()')).materials.length, 0);
  await settle();

  // Every page's visible controls must have labels and stay within its viewport.
  for (const page of ['tasks', 'materials', 'templates', 'schedules', 'history', 'settings']) {
    await d.domClick(`[data-nav="${page}"]`);
    await settle();
    const audit = await d.evaluate(`(() => {
      const fields=[...document.querySelectorAll('input,textarea,select')].filter(n=>n.offsetWidth>1 && !n.hidden);
      return {unlabelled:fields.filter(n=>!n.getAttribute('aria-label')&&!n.labels?.length).map(n=>n.id||n.name), overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.deepEqual(audit.unlabelled, [], `${page}: fields need labels`);
    assert.equal(audit.overflow, false, `${page}: horizontal overflow`);
    await screenshot(`${page}.png`);
  }
  console.log('PASS interaction audit: menu search/keyboard/occupied states, refresh preservation, validation, drafts, safe deletion, and six-page control audit');
} finally { await app.stop(); }
