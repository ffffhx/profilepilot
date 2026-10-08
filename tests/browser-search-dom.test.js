require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { NativePage } = require('../src/main/tasks/native-page.ts');
const { effectiveEffect } = require('../src/main/tasks/browser.ts');

// Real search-dom-live.json structure: search-input in input-box/header,
// a sibling button with use[href="#search"], and a separate comment editor.
function fixture(tag = 'INPUT') {
  const events = [], input = [];
  let doc;
  class Element {
    constructor(tag, attrs = {}, text = '') {
      this.tagName = tag.toUpperCase(); this.attrs = attrs; this.text = text; this.children = []; this.isConnected = true;
      this.style = { cursor: 'auto', visibility: 'visible', display: 'block', opacity: '1' };
    }
    get id() { return this.attrs.id || ''; }
    get className() { return this.attrs.class || ''; }
    get name() { return this.attrs.name || ''; }
    get type() { return this.attrs.type || (this.tagName === 'INPUT' ? 'text' : this.tagName === 'BUTTON' ? 'submit' : this.tagName === 'TEXTAREA' ? 'textarea' : ''); }
    get value() { return this._value || ''; }
    set value(v) { this._value = v; }
    get innerText() { return [this.text, ...this.children.map(c => c.innerText)].filter(Boolean).join(' '); }
    get textContent() { return this.innerText; }
    get isContentEditable() { return this.attrs.contenteditable === 'true'; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    append(...children) { for (const c of children) { c.parentElement = this; this.children.push(c); } return this; }
    contains(el) { return el === this || this.children.some(c => c.contains(el)); }
    matches(selector) {
      if (selector === ':disabled') return Boolean(this.disabled);
      return selector.split(',').some(part => {
        part = part.trim();
        const tag = part.match(/^[a-z]+/i)?.[0];
        if (tag && tag.toUpperCase() !== this.tagName) return false;
        const attributes = [...part.matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g)];
        return attributes.every(([, key, op, value]) => op === '*=' ? (this.getAttribute(key) || '').includes(value) : op === '=' ? this.getAttribute(key) === value : this.getAttribute(key) !== null);
      });
    }
    querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    getRootNode() { return doc; }
    getBoundingClientRect() { return { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40 }; }
    scrollIntoView() {}
    focus() { doc.activeElement = this; }
    dispatchEvent(event) { events.push(event.type); }
  }
  const el = (tag, attrs, text) => new Element(tag, attrs, text);
  const field = el(tag, { id: 'search-input', class: 'search-input', placeholder: '搜索小红书' });
  const icon = el('use', { href: '#search' });
  const trigger = el('BUTTON', { class: 'reds-button-new min-width-search-icon' }).append(el('svg').append(icon));
  const box = el('DIV', { class: 'input-box' }).append(field);
  const header = el('HEADER', { class: 'mask-paper' }).append(box, trigger);
  const comment = el('P', { id: 'content-textarea', class: 'content-input', contenteditable: 'true' });
  const comments = el('DIV', { class: 'engage-bar' }).append(el('DIV', { class: 'content-edit' }).append(comment), el('BUTTON', { class: 'btn submit' }, '发送'));
  const body = el('BODY').append(header, comments);
  doc = { title: 'Search', body, activeElement: null, querySelectorAll: selector => body.querySelectorAll(selector),
    getElementById: id => body.querySelectorAll('*').find(n => n.id === id), elementFromPoint: () => field };
  const context = vm.createContext({ document: doc, location: { href: 'https://fixture.test/search_result' }, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: n => n.style, HTMLInputElement: Element, HTMLTextAreaElement: Element, HTMLSelectElement: Element,
    Event: class { constructor(type) { this.type = type; } } });
  context.window = context;
  const browser = new NativePage(async (_task, method, params = {}) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: context.location.href, loaderId: 'loader' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.evaluate') {
      if (params.expression.startsWith('new Promise')) return { result: { value: true } };
      try { return { result: { value: vm.runInContext(params.expression, context) } }; }
      catch (error) { return { exceptionDetails: { text: error.message } }; }
    }
    if (method.startsWith('Input.')) input.push({ method, params });
    return {};
  });
  const task = { id: 'search', profileId: 'native:test', sessionId: 'session' };
  return { browser, task, field, trigger, icon, box, header, comment, comments, body, doc, el, events, input };
}
const act = (kind, ref, value) => ({ kind, ref, value, effect: 'read', summary: 'search' });
const observe = async f => f.task.observation = await f.browser.observe(f.task);
const candidate = (o, tag) => o.fast.candidates.find(c => c.dom.tag === tag && c.kind === 'fill');

test('responsive desktop search uses the visible image control while the mobile SVG button is hidden', async t => {
  for (const tag of ['INPUT', 'TEXTAREA']) for (const variant of ['valid', 'hidden-image', 'send-image', 'icon-change', 'hidden-first']) await t.test(tag + '/' + variant, async () => {
    const f = fixture(tag);
    f.trigger.style.display = 'none';
    const image = f.el('IMG', { class: 'standard-search-icon', src: '/search.png' });
    const desktop = f.el('DIV', { class: 'search-icon' }).append(image);
    if (variant === 'hidden-first') f.header.append(desktop); else f.box.append(desktop);
    if (variant === 'hidden-image') image.style.display = 'none';
    if (variant === 'send-image') image.attrs.alt = '发送';
    f.field.attrs.placeholder = '推出十月最爱新番';
    const o = await observe(f), ref = candidate(o, tag).ref;
    if (['hidden-image', 'send-image'].includes(variant)) {
      assert.equal(candidate(o, tag).dom.search, false); return;
    }
    assert.equal(candidate(o, tag).dom.search, true);
    if (variant === 'icon-change') {
      image.attrs.src = '/send.png';
      await assert.rejects(f.browser.execute(f.task, act('fill', ref, 'AI资讯')), /变化|失效/);
      assert.equal(f.field.value, ''); return;
    }
    f.field.attrs.placeholder = '今天的热点';
    await f.browser.execute(f.task, act('fill', ref, 'AI资讯'));
    const filled = await observe(f);
    assert.equal(effectiveEffect(act('press', ref, 'Enter'), filled), 'read');
    await f.browser.press(f.task, act('press', ref, 'Enter'), { key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    assert.deepEqual(f.input.map(v => v.params.type), ['keyDown', 'keyUp']);
  });
});

test('structural INPUT and TEXTAREA searches survive hot placeholders during observe/fill/Enter on Windows and macOS', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    for (const system of ['win32', 'darwin']) for (const tag of ['INPUT', 'TEXTAREA']) await t.test(system + '/' + tag, async () => {
      Object.defineProperty(process, 'platform', { ...platform, value: system });
      const f = fixture(tag), before = await observe(f), ref = candidate(before, tag).ref;
      assert.equal(candidate(before, tag).dom.search, true);
      assert.ok(before.fast.candidates.some(c => c.dom.tag === 'BUTTON' && c.label === '搜索' && c.dom.search));
      f.field.attrs.placeholder = '推出十月最爱新番';
      assert.equal(effectiveEffect(act('fill', ref, 'AI资讯'), before), 'read');
      await f.browser.execute(f.task, act('fill', ref, 'AI资讯'));
      assert.equal(f.field.value, 'AI资讯');
      const filled = await observe(f);
      assert.equal(candidate(filled, tag).label, '推出十月最爱新番', 'the snapshot retains the actual placeholder');
      f.field.attrs.placeholder = '今天的热门话题';
      assert.equal(effectiveEffect(act('press', ref, 'Enter'), filled), 'read');
      await f.browser.press(f.task, act('press', ref, 'Enter'), { key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      assert.deepEqual(f.input.map(v => v.params.type), ['keyDown', 'keyUp']);
      assert.equal(effectiveEffect(act('press', ref, 'Control+Enter'), filled), 'submit');
      assert.equal(effectiveEffect(act('press', ref, 'Meta+Enter'), filled), 'submit');
      assert.equal(filled.fast.candidates.find(c => c.dom.tag === 'P').dom.effect, 'edit');
    });
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('a hot placeholder alone, write controls and mixed regions cannot grant read-only search', async t => {
  for (const variant of ['no-identifier', 'no-trigger', 'textarea-placeholder', 'comment', 'post', 'mixed', 'send-button', 'purchase-button', 'post-command', 'custom-command', 'post-form', 'post-override', 'external-post-form', 'disabled-trigger']) await t.test(variant, async () => {
    const f = fixture(variant === 'textarea-placeholder' ? 'TEXTAREA' : 'INPUT');
    f.field.attrs.placeholder = variant === 'textarea-placeholder' ? 'Search' : '推出十月最爱新番';
    if (variant === 'no-identifier' || variant === 'textarea-placeholder') { delete f.field.attrs.id; delete f.field.attrs.class; }
    if (variant === 'no-trigger') f.icon.attrs.href = '#close';
    if (variant === 'comment' || variant === 'post') f.box.attrs.class = variant === 'comment' ? 'comment-editor' : 'post-compose';
    if (variant === 'mixed') f.box.append(f.el('TEXTAREA', { name: 'comment' }));
    if (variant === 'send-button') f.trigger.text = '发送';
    if (variant === 'purchase-button') f.trigger.text = '购买';
    if (variant === 'post-command' || variant === 'custom-command') f.trigger.attrs['data-action'] = variant === 'post-command' ? 'post' : 'doSomething';
    if (variant === 'post-form') f.field.form = { method: 'post', action: 'https://fixture.test/search', elements: [f.field, f.trigger] };
    if (variant === 'post-override') f.trigger.attrs.formmethod = 'post';
    if (variant === 'external-post-form') f.trigger.form = { method: 'post', action: 'https://fixture.test/submit', elements: [f.trigger] };
    if (variant === 'disabled-trigger') f.trigger.disabled = true;
    f.doc.activeElement = f.field;
    const o = await observe(f), ref = candidate(o, f.field.tagName).ref;
    assert.equal(effectiveEffect(act('fill', ref, 'AI资讯'), o), 'edit');
    assert.notEqual(effectiveEffect(act('press', ref, 'Enter'), o), 'read');
  });
});

test('search placeholder tolerance still rejects field, trigger, form, identity and accessibility changes', async t => {
  for (const variant of ['field-id', 'field-class', 'field-role', 'field-replace', 'trigger-replace', 'trigger-icon', 'trigger-disabled', 'trigger-command', 'trigger-label', 'trigger-form', 'form-action', 'form-method', 'field-disabled', 'field-readonly', 'aria-label', 'region-replace']) await t.test(variant, async () => {
    const f = fixture(), o = await observe(f), ref = candidate(o, 'INPUT').ref;
    f.field.attrs.placeholder = '另一个热词';
    if (variant === 'field-id') f.field.attrs.id = 'other-search-input';
    if (variant === 'field-class') f.field.attrs.class = 'other-search-input';
    if (variant === 'field-role') f.field.attrs.role = 'searchbox';
    if (variant === 'field-replace') { f.field.isConnected = false; f.box.children = []; f.box.append(f.el('INPUT', { ...f.field.attrs })); }
    if (variant === 'trigger-replace') { f.trigger.isConnected = false; f.header.children = [f.box]; f.header.append(f.el('BUTTON', { ...f.trigger.attrs }, '搜索')); }
    if (variant === 'trigger-icon') f.icon.attrs.href = '#send';
    if (variant === 'trigger-disabled') f.trigger.disabled = true;
    if (variant === 'trigger-command') f.trigger.attrs['data-action'] = 'post';
    if (variant === 'trigger-label') f.trigger.text = 'Search';
    if (variant === 'trigger-form') f.trigger.form = { method: 'get', action: 'https://fixture.test/another-search', elements: [f.trigger] };
    if (variant === 'form-action' || variant === 'form-method') f.field.form = { method: variant === 'form-method' ? 'post' : 'get', action: 'https://fixture.test/other-search', elements: [f.field, f.trigger] };
    if (variant === 'field-disabled') f.field.disabled = true;
    if (variant === 'field-readonly') f.field.readOnly = true;
    if (variant === 'aria-label') f.field.attrs['aria-label'] = '搜索';
    if (variant === 'region-replace') { f.body.children = [f.el('HEADER', { class: 'mask-paper' }).append(f.box, f.trigger), f.comments]; }
    await assert.rejects(f.browser.execute(f.task, act('fill', ref, 'AI资讯')), /变化|失效/);
    assert.equal(f.field.value, ''); assert.deepEqual(f.events, []); assert.deepEqual(f.input, []);
  });
});
