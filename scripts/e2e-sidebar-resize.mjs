import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

const app = await launchProfilePilotE2e({ name: 'resizable sidebars' });
const d = app.driver;
const shell = expression => d.evaluate(expression, { target: 'shell' });
const paint = () => shell('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
const railWidth = () => shell(`document.querySelector('#workspace-rail').getBoundingClientRect().width`);
const taskWidth = () => d.evaluate(`document.querySelector('#task-sidebar').getBoundingClientRect().width`);
const key = (id, key) => d.evaluate(`document.querySelector('[data-sidebar-resize="${id}"]').dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',bubbles:true})); true`, { target: id === 'workspace' ? 'shell' : 'main' });

// DOM-only input keeps this test on the background driver. Synthetic pointers
// do not exist in Chromium's native pointer registry, so stub capture only;
// all event handling, layout, iframe resize and storage use the real app.
async function drag(id, delta, replaceHandle = false) {
  return d.evaluate(`(() => {
    const root = document.documentElement;
    const selector = '[data-sidebar-resize="${id}"]';
    const handle = document.querySelector(selector), bounds = handle.getBoundingClientRect();
    const originals = [root.setPointerCapture, root.hasPointerCapture, root.releasePointerCapture];
    let captured = false;
    root.setPointerCapture = () => { captured = true; };
    root.hasPointerCapture = () => captured;
    root.releasePointerCapture = () => { captured = false; };
    const x = bounds.x + bounds.width / 2;
    const send = (target, type, clientX) => target.dispatchEvent(new PointerEvent(type, { pointerId: 99, isPrimary: true, button: 0, clientX, bubbles: true }));
    try {
      send(handle, 'pointerdown', x);
      if (${replaceHandle}) handle.replaceWith(handle.cloneNode(true));
      send(root, 'pointermove', x + ${delta});
      send(root, 'pointerup', x + ${delta});
      return { captured, resizing: root.hasAttribute('data-sidebar-resizing') };
    } finally {
      [root.setPointerCapture, root.hasPointerCapture, root.releasePointerCapture] = originals;
    }
  })()`, { target: id === 'workspace' ? 'shell' : 'main' });
}

try {
  await d.request('resize', { width: 1400, height: 850 });
  await d.domClick('.workspace-link[data-workspace="agent"]');
  await d.waitFor('[data-sidebar-resize="tasks"]');
  await paint();
  await d.domInput('#prompt', '调整侧栏宽度时保留草稿');
  const initialRail = await railWidth(), initialTask = await taskWidth();
  assert.deepEqual(await drag('workspace', 80), { captured: false, resizing: false });
  await paint();
  assert.equal(await railWidth(), initialRail + 80);
  assert.equal(await taskWidth(), initialTask);
  assert.equal(await shell(`document.querySelector('#workspace-pages').getBoundingClientRect().left`), await railWidth());
  assert.deepEqual(await drag('tasks', 120, true), { captured: false, resizing: false });
  assert.equal(await taskWidth(), initialTask + 120, 'drag survives sidebar DOM replacement');
  const savedRail = await railWidth(), savedTask = await taskWidth();
  for (const id of ['workspace', 'tasks']) {
    assert.equal(await d.evaluate(`getComputedStyle(document.querySelector('[data-sidebar-resize="${id}"]')).getPropertyValue('-webkit-app-region')`, { target: id === 'workspace' ? 'shell' : 'main' }), 'no-drag');
  }
  await d.domClick('#task-sidebar-toggle');
  assert.equal(await taskWidth(), 0);
  await d.domClick('#task-sidebar-toggle');
  assert.equal(await taskWidth(), savedTask);
  await d.domClick('[data-toggle-workspace-rail]');
  assert.equal(await railWidth(), 64);
  await d.domClick('[data-toggle-workspace-rail]');
  assert.equal(await railWidth(), savedRail);
  await d.domClick('.workspace-link[data-workspace="browser"]');
  await d.domClick('.workspace-link[data-workspace="agent"]');
  await d.domClick('[data-nav="templates"]');
  await d.domClick('[data-nav="tasks"]');
  assert.equal(await taskWidth(), savedTask);
  assert.equal((await d.query('#prompt')).value, '调整侧栏宽度时保留草稿');
  await d.request('reload', { target: 'shell' });
  await new Promise(resolve => setTimeout(resolve, 500));
  await d.waitFor('html[data-workspace-loading="false"]', s => s.exists, { target: 'shell' });
  await d.domClick('.workspace-link[data-workspace="agent"]');
  await d.waitFor('[data-sidebar-resize="tasks"]');
  assert.equal(await railWidth(), savedRail, 'navigation width survives reload');
  assert.equal(await taskWidth(), savedTask, 'task width survives reload');
  await d.request('resize', { width: 800, height: 800 });
  await paint();
  assert.ok(await railWidth() <= 280);
  assert.ok(await taskWidth() <= 224);
  assert.equal(await d.evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  await d.request('resize', { width: 1400, height: 850 });
  await paint();
  assert.equal(await railWidth(), savedRail, 'temporary viewport clamp preserves preference');
  assert.equal(await taskWidth(), savedTask);
  for (const [id, width, min, max] of [['workspace', railWidth, 176, 360], ['tasks', taskWidth, 140, 440]]) {
    await drag(id, 2000);
    assert.equal(await width(), max);
    await drag(id, -2000);
    assert.equal(await width(), min);
    await key(id, 'ArrowRight');
    assert.equal(await width(), min + 8);
    await key(id, 'End');
    assert.equal(await width(), max);
    await key(id, 'Home');
    assert.equal(await width(), min);
    await d.evaluate(`(() => {
      const rect = document.querySelector('[data-sidebar-resize="${id}"]').getBoundingClientRect();
      document.documentElement.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2}));
      return true;
    })()`, { target: id === 'workspace' ? 'shell' : 'main' });
    await paint();
    assert.equal(await width(), id === 'workspace' ? initialRail : initialTask);
  }
  await drag('workspace', 50);
  await drag('tasks', 100);
  await paint();
  const directory = path.join(repoRoot, 'test-results', 'sidebar-resize');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'resized.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  assert.doesNotMatch(app.output().stderr, /Uncaught (?:Exception|Error|TypeError)/);
  console.log('PASS sidebar resizing: DOM pointer sequences, independent widths, render survival, collapse, navigation, drafts, reload, viewport limits, keyboard, reset, native no-drag regions');
} catch (error) {
  console.error(app.output().stderr.slice(-4000));
  throw error;
} finally { await app.stop(); }
