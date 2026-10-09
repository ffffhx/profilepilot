import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

const app = await launchProfilePilotE2e({ name: 'workspace menus and dialogs' });
const d = app.driver;
const shell = expression => d.evaluate(expression, { target: 'shell' });
const output = path.join(repoRoot, 'test-results', 'workspace-overlays');
const tick = () => shell('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
const capture = async name => writeFile(path.join(output, `${name}.png`), Buffer.from((await d.screenshot()).pngBase64, 'base64'));

async function fits(selector) {
  await tick();
  const result = await shell(`(() => {
    const frame = document.querySelector('iframe[data-active="true"]');
    const doc = frame.contentDocument, win = frame.contentWindow;
    const modal = doc.querySelector(${JSON.stringify(selector)});
    const r = modal.getBoundingClientRect(), f = frame.getBoundingClientRect();
    const rail = document.querySelector('.workspace-rail').getBoundingClientRect();
    const header = document.querySelector('.workspace-identity').getBoundingClientRect();
    return { inViewport:r.left >= 0 && r.top >= 0 && r.right <= win.innerWidth + 1 && r.bottom <= win.innerHeight + 1,
      clearOfChrome:f.left >= rail.right - 1 && f.top >= header.bottom - 1,
      noHorizontalOverflow:modal.scrollWidth <= modal.clientWidth + 1,
      centered:Math.abs((r.left + r.right) / 2 - win.innerWidth / 2) < 2,
      rect:{left:r.left,top:r.top,width:r.width,height:r.height}, viewport:{width:win.innerWidth,height:win.innerHeight} };
  })()`);
  for (const property of ['inViewport','clearOfChrome','noHorizontalOverflow','centered']) assert.equal(result[property], true, `${selector} ${property}: ${JSON.stringify(result)}`);
}

try {
  await mkdir(output, { recursive:true });
  assert.equal(await shell(`!!document.querySelector('#workspace-profile')`), false, 'the redundant header selector is removed');
  for (const [width, height] of [[1594,950], [1000,720], [700,600]]) {
    await d.request('resize', { width, height });
    await d.domClick('.workspace-link[data-workspace="browser"]');
    await tick();
    const alignment = await d.evaluate(`(() => {
      const heading = document.querySelector('.profile-actions-heading > span'), h = heading.getBoundingClientRect();
      const labelCenter = h.left + (h.width - parseFloat(getComputedStyle(heading).paddingRight)) / 2;
      return [...document.querySelectorAll('.profile-primary-action > button')].map(button => { const r = button.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - labelCenter); });
    })()`);
    assert.ok(alignment.length && alignment.every(delta => delta < 1), `action heading/button alignment: ${alignment}`);
    await d.domClick('[data-action="toggle-profile-menu"]');
    await tick();
    const menu = await d.evaluate(`(() => {
      const menu = document.querySelector('.action-menu'), r = menu.getBoundingClientRect();
      return { fits:r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        rows:[...menu.querySelectorAll('button')].map(button => { const b = button.getBoundingClientRect(), s = getComputedStyle(button); return { x:b.left, width:b.width, height:b.height, border:s.borderWidth, left:s.paddingLeft, right:s.paddingRight, align:s.alignItems, justify:s.justifyContent }; }) };
    })()`);
    assert.equal(menu.fits, true, JSON.stringify(menu));
    for (const row of menu.rows) {
      assert.equal(row.border, '0px');
      assert.equal(row.left, row.right);
      assert.equal(row.align, 'center');
      assert.equal(row.justify, 'flex-start');
      assert.ok(Math.abs(row.x - menu.rows[0].x) < 1 && Math.abs(row.width - menu.rows[0].width) < 1 && Math.abs(row.height - menu.rows[0].height) < 1, JSON.stringify(menu.rows));
    }
    await capture(`menu-${width}`);
    assert.equal(await d.evaluate(`!!document.querySelector('[data-action="open-profile-details"],[data-action="open-folder"],[data-action="pin-mini-profile"],[data-action="unpin-mini-profile"]')`), false);
    await d.domClick('[data-action="toggle-profile-menu"]');
    console.log(`PASS browser menu at ${width} x ${height}`);
  }
  await d.request('resize', { width:1400, height:950 });
  // Native dialogs and custom overlays must all use the same content viewport.
  for (const [workspace, trigger, selector, close] of [
    ['browser', '[data-action="open-agent-browser-setup"]', '.clone-pool-modal', '.clone-pool-modal [data-action="close-modal"]'],
    ['local-apps', '.app-topbar [data-action="add"]', 'dialog[open]', null],
    ['phones', '.phone-empty-actions [data-action="wifi"]', 'dialog[open]', null],
    ['tools', '[data-action="open-global-instructions"]', '.global-instructions-modal', '.global-instructions-modal [data-action="close-modal"]']
  ]) {
    await d.domClick(`.workspace-link[data-workspace="${workspace}"]`);
    await d.waitFor(trigger, state => state.exists && !state.disabled, { timeoutMs:30000 });
    await d.domClick(trigger);
    await d.waitFor(selector);
    await fits(selector);
    await capture(`${workspace}-dialog`);
    if (close) await d.domClick(close); else await d.evaluate(`document.querySelector('dialog[open]').close(); true`);
    console.log(`PASS ${workspace} dialog`);
  }
  await d.domClick('.workspace-link[data-workspace="agent"]');
  await d.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'k', ctrlKey:true, metaKey:true, bubbles:true })); true`);
  await d.waitFor('dialog[open]');
  await fits('dialog[open]');
  await capture('agent-dialog');
  await d.evaluate(`document.querySelector('dialog[open]').close(); true`);
  assert.deepEqual(app.output().stderr.match(/Uncaught (?:Exception|Error|TypeError)/g) || [], []);
  console.log('PASS menus and overlays across all five workspaces');
} catch (error) {
  await capture('failure').catch(() => {});
  throw error;
} finally { await app.stop(); }
