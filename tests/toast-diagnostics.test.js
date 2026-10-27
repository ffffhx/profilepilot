const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTsModule } = require('./helpers/load-ts-module');

const store = {};
const { renderToastBody } = loadTsModule('src/renderer/render/busy-view.ts', {
  stubs: { 'src/renderer/state': { store } }
});

test('long command failures have a concise summary and complete escaped diagnostics', () => {
  const message = 'Command failed: powershell.exe ' + 'A'.repeat(5000) + '\n<failure>\nUnauthorizedAccessException';
  const html = renderToastBody(message, 'error');
  assert.match(html, /命令执行失败，请展开诊断信息查看原因/);
  assert.ok(html.includes('A'.repeat(5000)));
  assert.match(html, /&lt;failure&gt;/);
  assert.doesNotMatch(html, /<failure>/);
  assert.match(html, /<details/);
  assert.match(html, /data-toast-copy/);
  assert.match(html, /data-toast-dismiss/);
});

test('Windows stage diagnostics survive the Electron error prefix', () => {
  const { formatErrorMessage } = loadTsModule('src/renderer/util.ts', { stubs: { 'src/renderer/state': { store } } });
  const message = formatErrorMessage(new Error("Error invoking remote method 'set-shell-integration': ProfileManagerError: 无法保存 Windows 用户 PATH。\n\n错误代码：WINDOWS_USER_PATH_WRITE_FAILED\n退出码：1"));
  const html = renderToastBody(message, 'error');
  assert.match(html, /<span>无法保存 Windows 用户 PATH。<\/span>/);
  assert.match(html, /WINDOWS_USER_PATH_WRITE_FAILED/);
  assert.doesNotMatch(html, /Error invoking/);
});

test('normal notifications keep their existing display', () => {
  assert.equal(renderToastBody('CLI 已就绪'), 'CLI 已就绪');
  assert.doesNotMatch(renderToastBody('失败', 'error'), /<details/);
});

test('error notifications persist while normal notifications still expire', t => {
  const originalWindow = global.window;
  const scheduled = [];
  global.window = { clearTimeout() {}, setTimeout(callback) { scheduled.push(callback); return scheduled.length; } };
  t.after(() => { global.window = originalWindow; });
  const { setToast } = loadTsModule('src/renderer/busy.ts', { stubs: {
    'src/renderer/state': { store }, './view-events': { invalidateView() {} }, './state-actions': { loadState() {} }
  } });
  setToast('failure', 'error');
  assert.equal(scheduled.length, 0);
  assert.equal(store.toast, 'failure');
  setToast('success');
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.equal(store.toast, null);
});
