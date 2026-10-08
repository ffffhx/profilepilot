require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { FastBrowser } = require('../src/main/tasks/fast-browser.ts');
const { publicNativeObservation } = require('../src/main/native-control/service.ts');

function fixture() {
  const events = [], probes = [], nodes = [], accepted = new Map();
  class Input {
    get value() { return this._value || ''; }
    set value(value) {
      if (this.detached) {
        this._value = accepted.has(`${this.type}:${value}`) ? accepted.get(`${this.type}:${value}`) : value;
      } else { events.push(['set', this.label, value]); this._value = value; }
    }
  }
  const query = list => selector => selector === '*' ? list : selector === '[contenteditable]' ? list.filter(node => Object.hasOwn(node.attrs, 'contenteditable'))
    : selector === 'div,span,img,svg,li' ? [] : list.filter(node => ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(node.tagName) || node.attrs.role || node.attrs.tabindex);
  const doc = { title: 'Form boundary fixture', body: { innerText: 'Form fields' }, activeElement: null,
    querySelectorAll: query(nodes), getElementById: () => null, elementFromPoint: () => doc.hit || nodes[0],
    createElement(tag) { assert.equal(tag, 'input'); const input = new Input(); input.detached = true; probes.push(input); return input; } };
  function node(tag, label, attrs = {}, root = doc) {
    const value = Object.assign(new Input(), { label, tagName: tag, type: attrs.type || (tag === 'INPUT' ? 'text' : ''), attrs,
      isConnected: true, innerText: label, textContent: label, style: { cursor: 'auto', display: 'block', visibility: 'visible', opacity: '1' },
      getAttribute: name => name === 'aria-label' ? label : attrs[name] ?? null, getRootNode: () => root,
      matches: selector => selector === ':disabled' && Boolean(value.effectiveDisabled),
      closest: () => null, querySelector: () => null, contains: other => other === value,
      getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, top: 10, right: 90, bottom: 40, width: 80, height: 30 }),
      scrollIntoView: () => events.push(['scroll', label]), focus: () => { events.push(['focus', label]); doc.activeElement = value; },
      dispatchEvent: event => events.push([event.type, label]) });
    (root === doc ? nodes : root.nodes).push(value); return value;
  }
  const context = vm.createContext({ document: doc, location: { href: 'https://fixture.test/form' }, innerWidth: 800, innerHeight: 600,
    getComputedStyle: node => node.style, HTMLInputElement: Input, HTMLTextAreaElement: Input, HTMLSelectElement: Input,
    Event: class { constructor(type) { this.type = type; } } });
  context.window = context;
  const browser = new FastBrowser(async () => {}, async (_task, method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    try { return { result: { value: vm.runInContext(params.expression, context) } }; }
    catch (error) { return { exceptionDetails: { text: error.message } }; }
  });
  const shadow = host => {
    const root = { nodes: [], getElementById: () => null }; root.querySelectorAll = query(root.nodes); host.shadowRoot = root; return root;
  };
  const action = async (target, kind, value) => {
    doc.hit = target;
    const observation = await browser.observe({});
    const candidate = observation.fast.candidates.find(candidate => candidate.label === target.label);
    await browser.execute({ observation }, { kind, ref: candidate?.ref, value });
    return observation;
  };
  return { browser, node, shadow, nodes, doc, events, probes, accepted, action };
}

test('effective disabled controls are omitted while the native first-legend exception remains writable', async () => {
  const f = fixture(), locked = f.node('INPUT', 'Inherited disabled'), legend = f.node('INPUT', 'First legend');
  locked.disabled = false; locked.effectiveDisabled = true;
  legend.disabled = false; legend.effectiveDisabled = false;
  const observed = await f.browser.observe({});
  assert.deepEqual(Array.from(observed.fast.candidates, c => c.label), ['First legend']);
  await f.action(legend, 'fill', 'Allowed');
  assert.equal(legend.value, 'Allowed'); assert.equal(locked.value, '');
});

test('a newly inherited disabled state invalidates an existing ref before any input', async () => {
  const f = fixture(), field = f.node('INPUT', 'Field');
  const observed = await f.browser.observe({}); field.effectiveDisabled = true;
  await assert.rejects(f.browser.execute({ observation: observed }, { kind: 'fill', ref: observed.fast.candidates[0].ref, value: 'Forbidden' }), /变化|失效|禁用/);
  assert.deepEqual(f.events, []);
});

test('disabled optgroup choices are omitted and selecting them is rejected before focus or value mutation', async () => {
  const f = fixture(), select = f.node('SELECT', 'Plans');
  select.options = [
    { value: 'normal', label: 'Normal', selected: true, disabled: false, matches: () => false },
    { value: 'locked', label: 'Inherited disabled', selected: false, disabled: false, matches: selector => selector === ':disabled' }
  ];
  const observed = await f.browser.observe({});
  assert.deepEqual(Array.from(observed.fast.candidates[0].options, o => o.value), ['normal']);
  await assert.rejects(f.action(select, 'select', 'locked'), /不存在或已禁用/);
  assert.deepEqual(f.events, []);
});

test('an option disabled outside a filtered read and a field disabled outside a query both invalidate form guards', async () => {
  const f = fixture(), select = f.node('SELECT', 'Plans'), input = f.node('INPUT', 'Details'), submit = f.node('BUTTON', 'Save');
  let disabled = false;
  select.options = [{ value: 'first', label: 'First', selected: true, matches: () => false }, { value: 'second', label: 'Second', matches: () => disabled }];
  const prior = await f.browser.observe({}, { query: 'First' }); disabled = true;
  const next = await f.browser.observe({}, { query: 'First' });
  assert.notEqual(prior.fast.guard, next.fast.guard);
  submit.form = { action: 'https://fixture.test/save', elements: [select, input, submit] };
  const before = await f.browser.observe({}, { query: 'Save' }); input.effectiveDisabled = true;
  const after = await f.browser.observe({}, { query: 'Save' });
  assert.notEqual(before.fast.guard, after.fast.guard);
});

test('only actual editing hosts get refs, including empty/plaintext-only, nested re-enabled islands and open shadow roots', async () => {
  const f = fixture();
  const outer = f.node('DIV', 'Outer', { contenteditable: '' }); outer.isContentEditable = true;
  const inherited = f.node('SPAN', 'Inherited child', { role: 'textbox' }); inherited.isContentEditable = true; inherited.parentElement = outer;
  const redundant = f.node('DIV', 'Nested declaration', { contenteditable: 'true' }); redundant.isContentEditable = true; redundant.parentElement = outer;
  const off = f.node('DIV', 'Not editable', { contenteditable: 'false' }); off.isContentEditable = false;
  const island = f.node('DIV', 'Plain island', { contenteditable: 'plaintext-only' }); island.isContentEditable = true; island.parentElement = off;
  const host = f.node('SECTION', 'Shadow container'), root = f.shadow(host);
  const shadow = f.node('DIV', 'Shadow plaintext', { contenteditable: 'plaintext-only' }, root); shadow.isContentEditable = true;
  const observed = await f.browser.observe({});
  assert.deepEqual(Array.from(observed.fast.candidates, c => c.label).sort(), ['Outer', 'Plain island', 'Shadow plaintext'].sort());
  assert.ok(observed.fast.candidates.every(c => c.kind === 'fill'));
  await f.action(island, 'fill', 'Plain value'); assert.equal(island.textContent, 'Plain value');
});

test('typed invalid syntax fails on a detached native probe without scrolling, focusing, writing or dispatching live events', async () => {
  for (const [type, invalid, old] of [['date', '2026/10/04', '2026-10-03'], ['number', '1,5', '12'], ['time', 'not-time', '12:00']]) {
    const f = fixture(), input = f.node('INPUT', 'Typed value', { type }); input._value = old;
    f.accepted.set(`${type}:${invalid}`, '');
    await assert.rejects(f.action(input, 'fill', invalid), /格式.*原值未更改/);
    assert.equal(input.value, old); assert.deepEqual(f.events, []);
    assert.equal(f.probes.length, 1); assert.equal(f.probes[0].type, type); assert.equal(f.probes[0].detached, true);
  }
});

test('empty typed values and browser-approved numeric/datetime normalization are accepted without enforcing live min/max/step', async () => {
  for (const [type, requested, normalized] of [['date', '', ''], ['number', '01', '1'], ['number', '1e2', '100'], ['datetime-local', '2026-10-03 10:00', '2026-10-03T10:00']]) {
    const f = fixture(), input = f.node('INPUT', 'Typed value', { type }); input._value = 'old'; input.min = '500'; input.step = '50';
    f.accepted.set(`${type}:${requested}`, normalized);
    await f.action(input, 'fill', requested);
    assert.equal(input.value, normalized);
    assert.equal(f.probes[0].min, undefined); assert.equal(f.probes[0].step, undefined);
    assert.deepEqual(f.events.filter(e => ['input', 'change'].includes(e[0])).map(e => e[0]), ['input', 'change']);
  }
});

test('ordinary text is not passed through typed validation and inputType survives public and text observations', async () => {
  const f = fixture(), input = f.node('INPUT', 'Free text', { type: 'text' });
  await f.action(input, 'fill', '1,5 / arbitrary text'); assert.equal(input.value, '1,5 / arbitrary text'); assert.equal(f.probes.length, 0);
  const observed = await f.browser.observe({});
  assert.equal(publicNativeObservation(observed).fast.candidates[0].inputType, 'text');
  assert.match(observed.snapshot, /inputType="text"/);
});

test('focus handlers that disable a field or option stop the write without reverting page state', async () => {
  for (const kind of ['field', 'option', 'readonly']) {
    const f = fixture(), node = f.node(kind === 'option' ? 'SELECT' : 'INPUT', 'Changing target'); node._value = 'original';
    let disabled = false;
    if (kind === 'option') node.options = [{ value: 'new', label: 'New', matches: () => disabled }];
    node.focus = () => { f.events.push(['focus']); disabled = true; if (kind === 'field') node.effectiveDisabled = true; if (kind === 'readonly') node.readOnly = true; };
    await assert.rejects(f.action(node, kind === 'option' ? 'select' : 'fill', 'new'), /禁用|只读/);
    assert.equal(node.value, 'original'); assert.deepEqual(f.events, [['scroll', 'Changing target'], ['focus']]);
  }
});

test('focus handlers changing an input type or detaching it stop before any write or input event', async () => {
  for (const change of ['type', 'detach']) {
    const f = fixture(), input = f.node('INPUT', 'Changing typed input', { type: 'date' }); input._value = '2026-10-03';
    input.focus = () => {
      f.events.push(['focus']);
      if (change === 'type') { input.type = 'number'; input._value = '123'; }
      else input.isConnected = false;
    };
    await assert.rejects(f.action(input, 'fill', '2026-10-04'), /类型已经变化|已失效/);
    assert.equal(input.value, change === 'type' ? '123' : '2026-10-03');
    assert.deepEqual(f.events, [['scroll', 'Changing typed input'], ['focus']]);
  }
});
