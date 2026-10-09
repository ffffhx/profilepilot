import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

// Trusted Tab/Enter input remains limited to the existing isolated desktop lane.
// The normal background run checks native link semantics without showing a window.
const realKeyboard = process.env.CPM_DESKTOP_E2E === '1' && process.env.CPM_DESKTOP_E2E_ISOLATED === '1';
const app = await launchProfilePilotE2e({ name: 'workspace navigation', mode: realKeyboard ? 'desktop' : 'background' });
const workspaces = [
  ['browser', 'PC 控制', './index.html'],
  ['phones', '手机控制', './phones.html'],
  ['tools', '配套工具', './tools.html'],
  ['agent', 'Agent', './tasks.html']
];
const link = workspace => `.workspace-link[data-workspace="${workspace}"]`;

try {
  const d = app.driver;
  if ((await d.query('button[data-action="dismiss-onboarding"]')).exists) await d.domClick('button[data-action="dismiss-onboarding"]');
  const dir = path.join(repoRoot, 'test-results', 'workspace-switcher');
  await mkdir(dir, { recursive: true });
  const shot = async name => {
    await d.screenshot();
    await new Promise(resolve => setTimeout(resolve, 300));
    await writeFile(path.join(dir, name), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  };
  const assertNavigation = async current => {
    const links = await d.evaluate(`[...document.querySelectorAll('.workspace-link[data-workspace]')].map(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return {
        workspace: element.dataset.workspace,
        label: element.textContent.trim(),
        href: element.getAttribute('href'),
        tag: element.tagName,
        tabIndex: element.tabIndex,
        current: element.getAttribute('aria-current'),
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        inert: Boolean(element.closest('[inert]'))
      };
    })`, { target: 'shell' });
    assert.deepEqual(links.map(item => [item.workspace, item.label, item.href]), workspaces);
    assert.deepEqual(links.filter(item => item.current === 'page').map(item => item.workspace), [current]);
    for (const item of links) {
      assert.equal(item.tag, 'A', `${item.workspace} must keep native Enter activation`);
      assert.equal(item.tabIndex, 0, `${item.workspace} must remain in native Tab order`);
      assert.equal(item.visible, true, `${item.workspace} must be permanently visible`);
      assert.equal(item.inert, false, `${item.workspace} must accept keyboard focus`);
    }
  };
  const navigate = async (workspace, title) => {
    await d.domClick(link(workspace));
    const heading = workspace === 'phones' ? '手机' : title;
    await d.waitFor('h1', snapshot => snapshot.text === heading);
    await assertNavigation(workspace);
  };

  const profile = await d.evaluate(`window.profileManager.createProfile('切换工作区测试').then(s=>s.profiles.find(p=>p.name==='切换工作区测试'))`);
  await assertNavigation('browser');
  await shot('browser-switcher.png');
  for (const [workspace, title] of workspaces.filter(([workspace]) => ['local-apps', 'phones', 'tools'].includes(workspace))) {
    await navigate(workspace, title);
  }
  await navigate('agent', 'Agent');
  await d.waitFor('#create-task');
  await d.waitFor('select[name=profileId]', snapshot => snapshot.disabled === false);
  await d.domInput('#prompt', '切换工作区后保留这份草稿');
  await d.domInput('select[name=profileId]', profile.id);
  await d.domClick('#create-task details summary');
  await d.domInput('[name=templateName]', '保留模板名称');
  const origin = await d.evaluate('performance.timeOrigin');
  await shot('agent-switcher.png');
  await d.domClick(link('agent'));
  assert.equal(await d.evaluate('performance.timeOrigin'), origin, 'Clicking the current workspace must not reload');
  assert.equal(await d.evaluate('document.querySelector("#prompt").value'), '切换工作区后保留这份草稿');
  await d.evaluate('window.tasks.snapshot().then(({settings})=>window.tasks.saveSettings({...settings,notifications:false}))');
  await assertNavigation('agent');

  if (realKeyboard) {
    await d.focus(link('browser'));
    for (const [workspace] of workspaces.slice(1)) {
      await d.press('Tab');
      await d.waitFor('.workspace-link:focus', snapshot => snapshot.attributes['data-workspace'] === workspace);
    }
    await d.press('Enter');
    await d.waitFor('h1', snapshot => snapshot.text === 'Agent');
    await assertNavigation('agent');
    await d.focus(link('agent'));
    await d.press('Enter');
    await d.waitFor('#prompt', snapshot => snapshot.value === '切换工作区后保留这份草稿');
    await assertNavigation('agent');
  }

  await navigate('browser', 'PC 控制');
  await navigate('agent', 'Agent');
  await d.waitFor('#prompt', snapshot => snapshot.value === '切换工作区后保留这份草稿');
  await d.waitFor('select[name=profileId]', snapshot => snapshot.value === profile.id);
  assert.equal(await d.evaluate('document.querySelector("[name=templateName]").value'), '保留模板名称');
  assert.equal(await d.evaluate('document.querySelector("#create-task details").open'), true);
  await d.domClick('[data-action=toggle-sidebar]');
  await assertNavigation('agent');
  console.log(`PASS workspace navigation: four permanent links and destinations, current selection without reload, native keyboard semantics, snapshots, collapsed sidebar and draft restoration; trusted Tab/Enter ${realKeyboard ? 'passed' : 'not run (requires isolated desktop flags)'}`);
} finally {
  await app.stop();
}
