import assert from 'node:assert/strict';
import { launchProfilePilotE2e } from './e2e/lib/electron-driver.mjs';

const app = await launchProfilePilotE2e({ name: 'browser DOM identity' });
try {
  const d = app.driver;
  const profile = await d.evaluate(`window.profileManager.createProfile('DOM identity').then(s=>s.profiles.find(p=>p.name==='DOM identity'))`);
  const row = `[data-profile-row][data-id="${profile.id}"]`;
  await d.waitFor(row);
  await d.evaluate(`window.__stableRow = document.querySelector(${JSON.stringify(row)}); true`);
  await d.domClick(`[data-action="toggle-profile-menu"][data-id="${profile.id}"]`);
  await d.domClick(`[data-action="rename-profile"][data-id="${profile.id}"]`);
  await d.waitFor('#profile-rename');
  await d.domInput('#profile-rename', '尚未保存的名称');
  await d.evaluate(`window.__stableInput = document.querySelector('#profile-rename'); window.__stableInput.focus(); window.__stableInput.setSelectionRange(2,5); true`);
  for (let i = 0; i < 3; i++) {
    await d.evaluate(`window.profileManager.createProfile('Background ${i}')`);
    await d.waitFor('[data-profile-row]', state => state.count >= i + 2);
    const state = await d.evaluate(`({sameRow:document.querySelector(${JSON.stringify(row)})===window.__stableRow,
      sameInput:document.querySelector('#profile-rename')===window.__stableInput,
      focused:document.activeElement===window.__stableInput, value:window.__stableInput.value,
      start:window.__stableInput.selectionStart,end:window.__stableInput.selectionEnd})`);
    assert.deepEqual(state, { sameRow: true, sameInput: true, focused: true, value: '尚未保存的名称', start: 2, end: 5 });
  }
  await d.domClick('[data-rename-form] button[type="submit"]');
  await d.waitFor('.modal-backdrop', state => !state.exists);
  await d.waitFor(row, state => state.text.includes('尚未保存的名称'));
  console.log('PASS browser status updates reuse profile rows and preserve form node, draft, focus and selection; saving still works.');
} finally { await app.stop(); }
