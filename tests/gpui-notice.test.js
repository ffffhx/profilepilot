const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

function fixture(t, platform = 'win32') {
  const trays = []; let opened = 0, stopped = 0, emptyIcon = false;
  const state = { backend: null, sessions: [{ name: 'test', state: 'active' }] };
  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; trays.push(this); }
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
  }
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/main/gpui/notice.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  vm.runInNewContext(code, { exports, process: { platform }, require: () => ({ Tray,
    BrowserWindow: class { constructor() { assert.fail('A GPUI session must never create a popup'); } },
    Menu: { buildFromTemplate: value => value }, nativeImage: { createFromPath: () => ({ isEmpty: () => emptyIcon, resize: value => value }) } }) });
  const notice = new exports.GpuiControlNotice({ icon: 'icon.png', status: () => state,
    async openPanel() { opened++; }, pauseAll() { state.sessions.forEach(item => item.state = 'paused'); notice.update(state); },
    async stopAll() { stopped++; state.sessions = []; notice.update(state); } });
  t.after(() => notice.close());
  return { notice, state, trays, get opened() { return opened; }, get stopped() { return stopped; }, emptyIcon() { emptyIcon = true; } };
}

for (const platform of ['win32', 'darwin']) test(`${platform}: preparation creates only a tray and never opens a window`, async t => {
  const f = fixture(t, platform); await f.notice.prepare(); await f.notice.prepare();
  assert.equal(f.opened, 0); assert.equal(f.trays.length, 1);
  assert.equal(f.trays[0].icon.width, platform === 'darwin' ? 18 : 20);
});
test('explicit tray open uses the existing page and never resumes paused control', async t => {
  const f = fixture(t); await f.notice.prepare(); f.trays[0].menu[2].click();
  f.trays[0].menu[0].click(); await Promise.resolve();
  assert.equal(f.opened, 1); assert.equal(f.state.sessions[0].state, 'paused');
  assert.equal(f.trays[0].menu[2].enabled, false);
});
test('stop and shutdown remove only their tray and cannot recreate it', async t => {
  const f = fixture(t); await f.notice.prepare(); f.trays[0].menu[3].click(); await Promise.resolve();
  assert.equal(f.stopped, 1); assert.equal(f.trays[0].destroyed, true);
  f.notice.close(); await assert.rejects(f.notice.prepare(), /关闭/);
});
test('missing icon fails without falling back to a popup', async t => {
  const f = fixture(t); f.emptyIcon(); await assert.rejects(f.notice.prepare(), /托盘/); assert.equal(f.opened, 0);
});
