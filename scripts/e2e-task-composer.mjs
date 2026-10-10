import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

const app = await launchProfilePilotE2e({ name: 'bottom composer and templates', env: { PROFILEPILOT_SKILL_ROOTS: path.resolve(repoRoot, '../my-agent-skills/skills'), CPM_START_VIEW: 'tasks' } });
const d = app.driver;
const output = path.join(repoRoot, 'artifacts/task-composer');
const paint = () => d.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
const capture = async name => writeFile(path.join(output, `${name}.png`), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
const geometry = () => d.evaluate(`(() => {
  const workspace = document.querySelector('.workspace'), dock = document.querySelector('.compose-dock'), prompt = document.querySelector('#prompt');
  const w = workspace.getBoundingClientRect(), b = dock.getBoundingClientRect(), p = prompt.getBoundingClientRect();
  return {bottom:b.bottom, top:b.top, gap:w.bottom-b.bottom, left:b.left-w.left, right:w.right-b.right,
    promptVisible:p.top>=w.top && p.bottom<=w.bottom, overflow:document.documentElement.scrollWidth>innerWidth,
    scroll:document.querySelector('.compose-scroll').scrollTop, max:document.querySelector('.compose-scroll').scrollHeight-document.querySelector('.compose-scroll').clientHeight};
})()`);

try {
  await mkdir(output, { recursive:true });
  await d.waitFor('#create-task');
  assert.equal((await d.query('.examples, .example, .compose-actions .keyboard-hint')).count, 0);
  assert.equal((await d.query('[popovertarget="task-template-menu"]')).text, '任务模板');
  const profile = await d.evaluate(`window.profileManager.createProfile('模板界面验收').then(s=>s.profiles.find(p=>p.name==='模板界面验收'))`);
  await d.domInput('select[name="profileId"]', profile.id);
  await d.request('resize', { width:1400, height:950 });
  await paint();
  assert.ok(Math.abs((await geometry()).gap) < 2, 'composer sits at the bottom of the workspace');
  assert.ok(await d.evaluate('document.querySelector(".compose-actions .model-picker .select-value").getBoundingClientRect().width > 48'), 'model name remains readable in the single-row toolbar');
  await capture('home');
  await d.domClick('[popovertarget="task-template-menu"]');
  await d.waitFor('#task-template-menu:popover-open');
  const catalog = await d.evaluate('window.tasks.snapshot().then(s=>s.skills)');
  assert.equal((await d.query('#task-template-menu [data-use-skill]')).count, catalog.length);
  assert.equal((await d.query('#task-template-menu [data-use-skill="xianyu-monitor"]')).exists, true);
  assert.equal((await d.query('#task-template-menu input[name="minutes"]')).exists, false);
  await capture('templates');
  await d.domClick('#task-template-menu [data-use-skill="xianyu-monitor"]');
  await d.waitFor('[name="skillId"]', value => value.value === 'xianyu-monitor');
  assert.equal((await d.query('#task-template-menu:popover-open')).exists, false);
  assert.equal((await d.query('select[name="profileId"]')).value, profile.id, 'choosing a workflow retains the selected browser');
  await d.domClick('.compose-template-settings summary');
  await d.domInput('#prompt', Array.from({length:40}, (_, i)=>`任务要求 ${i+1}`).join('\n'));
  for (const [width,height] of [[1400,950],[1000,720],[800,600]]) {
    await d.request('resize', {width,height}); await paint();
    await d.evaluate('document.querySelector(".compose-scroll").scrollTop=0');
    const before = await geometry();
    await d.evaluate('document.querySelector(".compose-scroll").scrollTop=100000'); await paint();
    const after = await geometry();
    assert.ok(after.max>0 && after.scroll>0, `template content can scroll: ${JSON.stringify(after)}`);
    assert.ok(Math.abs(after.bottom-before.bottom)<1 && Math.abs(after.top-before.top)<1 && Math.abs(after.gap)<2, `composer stays fixed while scrolling: ${JSON.stringify(after)}`);
    assert.equal(after.promptVisible,true);
    assert.equal(after.overflow,false);
    await d.domClick('[popovertarget="task-template-menu"]'); await paint();
    const fits = await d.evaluate(`(() => { const r=document.querySelector('#task-template-menu').getBoundingClientRect(); return r.top>=0 && r.left>=0 && r.bottom<=innerHeight+1 && r.right<=innerWidth+1; })()`);
    assert.equal(fits,true, `template menu fits ${width}x${height}`);
    await capture(`template-scroll-${width}`);
    await d.evaluate('document.querySelector("#task-template-menu").hidePopover()');
  }
  await d.request('resize', {width:1400,height:950});
  await d.domClick('[data-action="remove-skill"]');
  await d.domInput('#prompt','整理当前网页内容，记录来源链接。');
  await d.domClick('[popovertarget="task-template-menu"]');
  await d.domClick('#task-template-menu [data-action="new-template"]');
  await d.waitFor('.compose-intro h2', value=>value.text==='新建任务模板');
  assert.equal((await d.query('#prompt')).value,'整理当前网页内容，记录来源链接。','new template starts from the current draft');
  await d.domInput('[name="templateName"]','我的网页整理');
  await d.domClick('.save-template-primary');
  await d.waitFor('#task-toast', value=>value.text.includes('模板已保存'));
  const saved = await d.evaluate(`window.tasks.snapshot().then(s=>s.templates.find(t=>t.name==='我的网页整理'))`);
  assert.equal(saved.task.prompt,'整理当前网页内容，记录来源链接。');
  assert.equal(saved.task.profileId,profile.id);
  assert.equal((await d.evaluate('window.tasks.snapshot()')).tasks.length,0,'saving a template never starts a task');
  await d.domClick('[popovertarget="task-template-menu"]');
  await d.waitFor(`#task-template-menu [data-use-template="${saved.id}"]`);
  await d.domClick(`#task-template-menu [data-use-template="${saved.id}"]`);
  assert.equal((await d.query('#prompt')).value,saved.task.prompt);
  await d.domClick('[popovertarget="task-template-menu"]');
  await d.domClick('[popovertarget="task-template-menu"]');
  await d.waitFor('#task-template-menu:popover-open', value=>!value.exists);
  await d.domClick('[data-nav="templates"]');
  await d.domClick('[data-nav="tasks"]');
  assert.equal((await d.query('#prompt')).value,saved.task.prompt,'workspace navigation preserves the composer draft');
  console.log('PASS bottom composer at three window sizes, long drafts, real template catalog, workflow selection and custom template save/reopen');
} finally { await app.stop(); }
