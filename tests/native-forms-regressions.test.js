require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { FastBrowser } = require('../src/main/tasks/fast-browser.ts');
const { NativePage } = require('../src/main/tasks/native-page.ts');
const { NativeBrowser } = require('../src/main/tasks/native-browser.ts');
const { publicNativeObservation } = require('../src/main/native-control/service.ts');

function formFixture() {
  const nodes = [], events = [];
  class Input { get value() { return this._value || ''; } set value(value) { this._value = value; } }
  const doc = { title: 'Synthetic form', body: { innerText: 'Synthetic form' }, activeElement: null,
    querySelectorAll: selector => selector === 'div,span,img,svg,li' ? [] : nodes,
    getElementById: () => null, elementFromPoint: () => nodes[0] };
  const context = vm.createContext({ document: doc, location: { href: 'https://fixture.test/form' }, innerWidth: 800, innerHeight: 600,
    getComputedStyle: node => node.style, HTMLInputElement: Input, HTMLTextAreaElement: Input, HTMLSelectElement: Input,
    Event: class { constructor(type) { this.type = type; } } });
  context.window = context;
  function node(tag, label) {
    const el = Object.assign(new Input(), { tagName: tag, type: tag === 'INPUT' ? 'text' : 'select-multiple', isConnected: true,
      innerText: label, textContent: label, style: { cursor: 'auto', visibility: 'visible', display: 'block', opacity: '1' },
      getAttribute: name => name === 'aria-label' ? label : null, getRootNode: () => doc, querySelector: () => null, closest: () => null,
      getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, right: 100, top: 10, bottom: 40, width: 90, height: 30 }),
      scrollIntoView: () => {}, focus: () => { doc.activeElement = el; }, contains: other => other === el,
      dispatchEvent: event => events.push(event.type) });
    nodes.push(el); return el;
  }
  const select = node('SELECT', 'Topics');
  select.multiple = true;
  select.options = [{ value: 'ai', label: 'AI', selected: true }, { value: 'robotics', label: 'Robotics', selected: false }, { value: 'safety', label: 'Safety', selected: false }];
  Object.defineProperty(select, 'value', { get: () => select.options.find(option => option.selected)?.value || '' });
  const input = node('INPUT', 'Name'), other = node('INPUT', 'Other name');
  doc.activeElement = input;
  const evaluate = expression => {
    try { return { result: { value: vm.runInContext(expression, context) } }; }
    catch (error) { return { exceptionDetails: { text: error.message } }; }
  };
  const browser = new FastBrowser(async () => {}, async (_task, method, params) => {
    assert.equal(method, 'Runtime.evaluate'); return evaluate(params.expression);
  });
  return { browser, doc, context, nodes, select, input, other, evaluate, events };
}

test('multiple selected values survive public projection, option filtering and snapshot text', async () => {
  const f = formFixture(); f.select.options[2].selected = true;
  const observation = await f.browser.observe({});
  const projected = publicNativeObservation(observation).fast.candidates[0];
  assert.equal(projected.multiple, true);
  assert.deepEqual([...projected.selectedValues], ['ai', 'safety']);
  assert.deepEqual(Array.from(projected.options, option => option.selected), [true, false, true]);
  assert.match(observation.snapshot, /multiple=true selectedValues=\["ai","safety"\]/);
  projected.selectedValues.push('corrupted');
  assert.deepEqual([...observation.fast.candidates[0].selectedValues], ['ai', 'safety'], 'projection owns its arrays');
  const filtered = await f.browser.observe({}, { query: 'Safety' });
  assert.deepEqual([...filtered.fast.candidates[0].selectedValues], ['ai', 'safety']);
  assert.equal(filtered.fast.candidates[0].options.length, 1);
});

test('changing a second selected option invalidates action guards and pagination even when select.value is unchanged', async () => {
  const f = formFixture(), before = await f.browser.observe({}, { limit: 1 });
  f.select.options[2].selected = true;
  const after = await f.browser.observe({});
  assert.equal(before.fast.candidates[0].value, after.fast.candidates[0].value);
  assert.notEqual(before.fast.guard, after.fast.guard);
  assert.notEqual(before.fingerprint, after.fingerprint);
  await assert.rejects(f.browser.execute({ observation: before }, { kind: 'select', ref: before.fast.candidates[0].ref, value: 'robotics' }), /页面内容已经变化/);
  await assert.rejects(f.browser.observe({}, { cursor: before.page.nextCursor }), /分页内容已变化/);
});

test('a form field outside the observed query still binds every selected option to a submit control', async () => {
  const f = formFixture();
  f.other.tagName = 'BUTTON'; f.other.type = 'submit';
  f.other.form = { action: 'https://fixture.test/save', elements: [f.select, f.other] };
  const before = await f.browser.observe({}, { query: 'Other name' });
  f.select.options[2].selected = true;
  const after = await f.browser.observe({}, { query: 'Other name' });
  assert.notEqual(before.fast.guard, after.fast.guard);
});

function nativeKeyboardFixture(target = 'root', options = {}) {
  const form = formFixture(), calls = [], delivered = []; let enabled = false, page;
  const cdp = async (_task, method, params = {}, session) => {
    calls.push({ method, params, session });
    if (method === 'Target.setAutoAttach' && target === 'oopif' && !session) page.event({ type: 'cdp', profileId: 'native:test', sessionId: 'keyboard', method: 'Target.attachedToTarget', params: { sessionId: 'child-session', targetInfo: { type: 'iframe' } } });
    if (method === 'Page.getFrameTree') return { frameTree: session
      ? { frame: { id: 'child', parentId: 'root', url: form.context.location.href, loaderId: 'child-load' } }
      : { frame: { id: 'root', url: form.context.location.href, loaderId: 'root-load' }, ...(target === 'same' ? { childFrames: [{ frame: { id: 'child', parentId: 'root', url: form.context.location.href, loaderId: 'child-load' } }] } : {}) } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.frameId === 'root' ? 1 : 2 };
    if (method === 'Runtime.evaluate') return form.evaluate(params.expression);
    if (method === 'Emulation.setFocusEmulationEnabled') {
      if (params.enabled) { enabled = true; options.onEnable?.(form); }
      else { enabled = false; if (options.cleanupError) throw options.cleanupError; }
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (options.inputError) throw options.inputError;
      if (enabled) delivered.push(params);
    }
    return {};
  };
  page = new NativePage(cdp);
  const task = { id: 'keyboard', profileId: 'native:test', sessionId: 'keyboard' };
  const observe = async () => {
    await page.observe(task);
    task.observation = await page.observe(task, target === 'root' ? {} : { frameId: 'child' });
    return task.observation.fast.candidates.find(candidate => candidate.label === 'Name').ref;
  };
  return { page, task, form, calls, delivered, observe };
}

test('background keyboard temporarily enables root renderer focus and routes Windows/Mac input to the observed root, iframe or OOPIF', async () => {
  for (const target of ['root', 'same', 'oopif']) for (const [value, modifiers] of [['Control+a', 2], ['Meta+a', 4], ['Enter', 0], ['Tab', 0]]) {
    const f = nativeKeyboardFixture(target), ref = await f.observe();
    await f.page.press(f.task, { kind: 'press', ref, value }, { key: value.includes('+') ? 'a' : value, modifiers, ...(value === 'Enter' ? { text: '\r' } : {}) });
    assert.deepEqual(f.delivered.map(event => event.type), ['keyDown', 'keyUp']);
    assert.equal(f.delivered[0].modifiers, modifiers); assert.equal(f.delivered[1].text, undefined);
    const focus = f.calls.filter(call => call.method === 'Emulation.setFocusEmulationEnabled');
    assert.deepEqual(focus.map(call => [call.session, call.params.enabled]), [[undefined, true], [undefined, false]]);
    assert.deepEqual(f.calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => call.session), target === 'oopif' ? ['child-session', 'child-session'] : [undefined, undefined]);
    assert.equal(f.form.doc.activeElement, f.form.input, 'the adapter never chooses a new DOM focus target');
    assert.equal(f.calls.some(call => /bringToFront|activateTarget|tabs.update/.test(call.method)), false);
  }
});

test('focus changes caused by preparation abort input and still restore emulation', async () => {
  const f = nativeKeyboardFixture('root', { onEnable: form => { form.doc.activeElement = form.other; } }), ref = await f.observe();
  await assert.rejects(f.page.press(f.task, { kind: 'press', ref, value: 'Enter' }, { key: 'Enter' }), /变化|焦点/);
  assert.equal(f.delivered.length, 0);
  assert.equal(f.calls.at(-1).params.enabled, false);
});

test('all referenced keys reject a different focused control before emulation or input', async () => {
  const f = nativeKeyboardFixture(), ref = await f.observe();
  const other = f.task.observation.fast.candidates.find(candidate => candidate.label === 'Other name').ref;
  assert.notEqual(ref, other);
  await assert.rejects(f.page.press(f.task, { kind: 'press', ref: other, value: 'Control+a' }, { key: 'a', modifiers: 2 }), /焦点/);
  assert.equal(f.calls.some(call => call.method === 'Emulation.setFocusEmulationEnabled' || call.method.startsWith('Input.')), false);
});

test('input errors keep their identity, restore focus and never replay keyDown', async () => {
  const stopped = Object.assign(Error('User takeover'), { code: 'NATIVE_USER_IN_CONTROL' });
  const f = nativeKeyboardFixture('oopif', { inputError: stopped, cleanupError: Error('cleanup also denied') }), ref = await f.observe();
  await assert.rejects(f.page.press(f.task, { kind: 'press', ref, value: 'Enter' }, { key: 'Enter' }), error => error === stopped);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchKeyEvent').length, 1);
  assert.equal(f.calls.at(-1).params.enabled, false);
});

test('a control error during focus restoration is not hidden after otherwise successful input', async () => {
  const stopped = Object.assign(Error('User takeover'), { code: 'NATIVE_USER_IN_CONTROL' });
  const f = nativeKeyboardFixture('root', { cleanupError: stopped }), ref = await f.observe();
  await assert.rejects(f.page.press(f.task, { kind: 'press', ref, value: 'Enter' }, { key: 'Enter' }), error => error === stopped);
  assert.equal(f.delivered.length, 2);
});

test('unchecking a checked radio is rejected before pointer preparation while normal check/uncheck remain supported', async () => {
  const calls = [], state = { profileId: 'native:test', connected: true, taskTabs: true, ownership: 'agent', ownerSessionId: 'forms' };
  const browser = new NativeBrowser({ states: () => [state], onEvent: () => () => {}, request: async (_profile, method) => { calls.push(method); return {}; } }, 'unused');
  browser.fast.assertFresh = async () => {};
  browser.fast.execute = async (_task, action) => { calls.push(action.kind); return 'clicked'; };
  const candidate = { ref: 'e1', role: 'radio', checked: true };
  const task = { id: 'forms', sessionId: 'forms', profileId: 'native:test', observation: { fast: { candidates: [candidate] } } };
  await assert.rejects(browser.execute(task, { kind: 'uncheck', ref: 'e1', effect: 'edit', summary: 'Fixture' }), /单选项不能单独取消/);
  assert.deepEqual(calls, []);
  candidate.checked = false;
  assert.match(await browser.execute(task, { kind: 'uncheck', ref: 'e1', effect: 'edit', summary: 'Fixture' }), /所需状态/);
  assert.deepEqual(calls, []);
  assert.equal(await browser.execute(task, { kind: 'check', ref: 'e1', effect: 'edit', summary: 'Fixture' }), 'clicked');
  candidate.role = 'checkbox'; candidate.checked = true;
  assert.equal(await browser.execute(task, { kind: 'uncheck', ref: 'e1', effect: 'edit', summary: 'Fixture' }), 'clicked');
  assert.deepEqual(calls, ['preparePointer', 'click', 'preparePointer', 'click']);
});
