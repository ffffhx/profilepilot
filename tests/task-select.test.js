const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsModule } = require('./helpers/load-ts-module');
const { MessageDrafts, draftKey } = loadTsModule('src/renderer/task-interaction-model.ts');
const { TaskSelects } = loadTsModule('src/renderer/task-select.ts');

function modeMenu() {
  const oldWindow = global.window, oldDocument = global.document, oldSelect = global.HTMLSelectElement;
  const drafts = new MessageDrafts(), key = draftKey('running', 'steer-task');
  const changes = [];
  class Select {
    constructor(value = 'queue') {
      this.id = 'send-mode'; this.name = 'sendMode'; this.value = value;
      this.options = ['queue', 'steer'].map(name => ({ value: name, textContent: name, disabled: false, selected: name === value, dataset: {} }));
      this.dataset = {}; this.isConnected = true; this.disabled = false;
    }
    dispatchEvent(event) {
      changes.push({ value: this.value, connected: this.isConnected, bubbles: event.bubbles });
      if (this.isConnected && event.bubbles) drafts.set(key, { mode: this.value });
      return true;
    }
    getAttribute(name) { return name === 'aria-label' ? '发送时机' : null; }
  }
  let live = new Select();
  let triggerTop = 500;
  const trigger = { isConnected: true, setAttribute() {}, removeAttribute() {}, focus() {}, getBoundingClientRect: () => ({ top: triggerTop, bottom: triggerTop + 30, left: 600, width: 150 }) };
  const list = { scrollTop: 17, setAttribute() {} }, input = { setAttribute() {} };
  const popup = Object.assign(new EventTarget(), { id: 'task-select-popover', isConnected: true, style: { left: '600px', top: '300px', width: '320px', bottom: 'auto' }, removed: 0,
    matches: () => true, querySelector: selector => selector === '.select-options' ? list : selector === '.select-search' ? input : selector === '[role=listbox]' ? list : null,
    remove() { this.removed++; this.isConnected = false; }, showPopover() {} });
  const root = Object.assign(new EventTarget(), { querySelectorAll: () => [], contains: node => node === live });
  global.HTMLSelectElement = Select;
  global.window = { addEventListener() {}, innerWidth: 966, innerHeight: 676 };
  global.document = { addEventListener() {}, getElementById: id => id === 'send-mode' ? live : id === 'send-mode-trigger' ? trigger : null };
  const menu = new TaskSelects(root);
  menu.current = live; menu.trigger = trigger; menu.popup = popup;
  menu.bindOptionEvents(popup);
  const option = { dataset: { value: 'steer' }, getAttribute: () => 'false' };
  const pointer = (pointerType = 'mouse', button = 0) => ({ pointerType, button, target: { closest: () => option } });
  const dispatch = (type, pointerType = 'mouse', button = 0) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, { target: { value: { closest: () => option } }, pointerType: { value: pointerType }, button: { value: button } });
    popup.dispatchEvent(event);
  };
  return {
    menu, drafts, key, changes, pointer, popup, root, dispatch,
    moveTrigger(top) { triggerTop = top; },
    redraw() { live.isConnected = false; live = new Select(drafts.get(key).mode); },
    replaceBeforeChoice() { live.isConnected = false; live = new Select(); },
    live: () => live,
    restore() { global.window = oldWindow; global.document = oldDocument; global.HTMLSelectElement = oldSelect; }
  };
}

test('stream between primary pointerdown and click keeps immediate delivery mode', () => {
  const fixture = modeMenu();
  try {
    fixture.menu.pointerChoose(fixture.pointer());
    assert.deepEqual(fixture.changes, [{ value: 'steer', connected: true, bubbles: true }]);
    assert.equal(fixture.drafts.get(fixture.key).mode, 'steer');
    // The next snapshot rebuilds the native select before pointerup/click.
    fixture.redraw();
    assert.equal(fixture.live().value, 'steer');
  } finally { fixture.restore(); }
});

test('stale select dispatches through its live replacement; touch waits for click', () => {
  const fixture = modeMenu();
  try {
    fixture.menu.pointerChoose(fixture.pointer('touch'));
    assert.equal(fixture.changes.length, 0);
    fixture.replaceBeforeChoice();
    fixture.menu.pointerChoose(fixture.pointer('pen'));
    assert.deepEqual(fixture.changes, [{ value: 'steer', connected: true, bubbles: true }]);
    assert.equal(fixture.live().value, 'steer');
    assert.equal(fixture.drafts.get(fixture.key).mode, 'steer');
  } finally { fixture.restore(); }
});

test('stream redraw retains the open option node and rebinds its live form select', () => {
  const fixture = modeMenu();
  try {
    const popup = fixture.popup, row = fixture.pointer().target.closest();
    const initialPosition = { ...popup.style };
    fixture.menu.optionSignature = fixture.menu.signature(fixture.live());
    for (let update = 0; update < 5; update++) {
      const captured = fixture.menu.capture();
      assert.equal(captured.id, 'send-mode');
      fixture.replaceBeforeChoice();
      fixture.moveTrigger(500 + update * 24);
      fixture.menu.mount(captured);
      fixture.root.dispatchEvent(new Event('scroll'));
      assert.deepEqual(popup.style, initialPosition, 'stream-driven trigger movement must not move open rows');
    }
    assert.equal(fixture.menu.popup, popup);
    assert.equal(popup.removed, 0);
    assert.equal(fixture.menu.current, fixture.live());
    assert.equal(fixture.pointer().target.closest(), row);
    fixture.dispatch('pointerdown');
    assert.deepEqual(fixture.changes, [{ value: 'steer', connected: true, bubbles: true }]);
    assert.equal(fixture.drafts.get(fixture.key).mode, 'steer');
  } finally { fixture.restore(); }
});

test('popover click still selects after touch pointerdown', () => {
  const fixture = modeMenu();
  try {
    fixture.dispatch('pointerdown', 'touch');
    assert.equal(fixture.changes.length, 0);
    fixture.dispatch('click');
    assert.deepEqual(fixture.changes, [{ value: 'steer', connected: true, bubbles: true }]);
  } finally { fixture.restore(); }
});
