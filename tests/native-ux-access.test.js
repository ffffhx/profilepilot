const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { transformSync } = require('esbuild');
function sourceModule(file) {
  const filename = path.resolve(file), compiled = new Module(filename, module);
  compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code, filename);
  return compiled.exports;
}
const { nativeBrowserAccess, normalizeNativeAccess } = sourceModule('src/main/tasks/native-access.ts');
const { nativeTaskInput, nativeTaskOptions } = sourceModule('src/renderer/native-task-options.ts');
const { nativeBrowserSettings } = sourceModule('src/renderer/native-browser-settings.ts');

test('native browser defaults grant all implemented effect classes, gateway and explicit modes remain unchanged', () => {
  for (const effect of ['read', 'edit', 'submit', 'send', 'purchase', 'delete']) {
    assert.equal(nativeBrowserAccess({ profileId: 'native:Default' }, { effect }, 'https://shop.test/cart').fullAccess, true);
    assert.equal(nativeBrowserAccess({ profileId: 'isolated:p' }, { effect }).fullAccess, false);
    for (const mode of ['manual', 'plan']) assert.equal(nativeBrowserAccess({ profileId: 'native:Default', mode }, { effect }).fullAccess, false);
  }
  assert.equal(nativeBrowserAccess({ profileId: 'native:p', mode: 'acceptEdits' }, { effect: 'send' }).fullAccess, true);
});
test('exact origins including ports enforce allow and deny with deny taking priority', () => {
  const nativeAccess = { allowedOrigins: ['https://example.test'], blockedOrigins: ['https://blocked.test'] };
  const task = { profileId: 'native:p', nativeAccess };
  assert.equal(nativeBrowserAccess(task, { effect: 'read' }, 'https://example.test/path?q=a').allowed, true);
  for (const url of ['https://example.test.evil/path', 'https://example.test:8443', 'https://blocked.test', 'http://example.test']) {
    assert.equal(nativeBrowserAccess(task, { effect: 'read' }, url).allowed, false);
  }
  task.nativeAccess.blockedOrigins.push('https://example.test');
  assert.match(nativeBrowserAccess(task, { effect: 'read' }, 'https://example.test').reason, /限制/);
});
test('optional confirmation allows reading and asks for edits and serious effects', () => {
  const task = { profileId: 'native:p', nativeAccess: { confirmActions: true } };
  assert.equal(nativeBrowserAccess(task, { effect: 'read' }).requiresConfirmation, false);
  for (const effect of ['edit', 'send', 'delete', 'purchase']) assert.equal(nativeBrowserAccess(task, { effect }).requiresConfirmation, true);
});
test('origin normalization rejects unsupported URLs, credentials, path-scoped and malformed settings', () => {
  assert.deepEqual(normalizeNativeAccess({ blockedOrigins: ['https://EXAMPLE.com/', 'https://example.com'] }), { blockedOrigins: ['https://example.com'], allowedOrigins: [], confirmActions: false });
  for (const origin of ['chrome://settings', 'file:///test', 'https://u:p@example.test', 'https://example.test/path', 'https://example.test?q=a', 'https://example.test#x']) {
    assert.throws(() => normalizeNativeAccess({ blockedOrigins: [origin] }));
  }
  assert.throws(() => normalizeNativeAccess({ confirmActions: 'false' }));
});
test('native composer defaults to current page and inherits Profile settings unless explicit restriction is checked', () => {
  const form = new FormData(); form.set('profileId', 'native:Default');
  assert.deepEqual(nativeTaskInput(form), { nativeTarget: { newTab: false } });
  form.set('nativeTarget', 'new'); form.set('nativeConfirmActions', 'on');
  assert.deepEqual(nativeTaskInput(form), { nativeTarget: { newTab: true }, nativeAccess: { confirmActions: true } });
  form.set('profileId', 'isolated:p'); assert.deepEqual(nativeTaskInput(form), {});
  assert.match(nativeTaskOptions(), /当前页（默认）/);
});
test('connection settings explain persistence, direct existing-page access, optional permissions and immediate stop', () => {
  const html = nativeBrowserSettings([{ id: 'native:Default', source: 'native', name: '<Profile>' }], [{ profileId: 'native:Default', connected: true, taskTabs: true }]);
  assert.match(html, /&lt;Profile&gt;/); assert.match(html, /持久安装/); assert.match(html, /可使用当前页/);
  assert.match(html, /立即停止/); assert.match(html, /网站与确认设置/);
  assert.doesNotMatch(html, /新任务会创建专用标签页|适用于本次 Chrome 会话|需由你接管处理/);
});
