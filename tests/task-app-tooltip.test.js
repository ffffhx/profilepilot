const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsModule } = require('./helpers/load-ts-module');
const { installTaskTooltips } = loadTsModule('src/renderer/task-interaction-dom.ts');

class Events {
  listeners = new Map();
  addEventListener(name, fn, capture) { const list = this.listeners.get(name) || []; list.push({ fn, capture }); this.listeners.set(name, list); }
  emit(name, event = {}) { for (const { fn } of this.listeners.get(name) || []) fn(event); }
}
class Element extends Events {
  attrs = new Map(); children = []; style = {}; isConnected = true; title = ''; offsetWidth = 120; offsetHeight = 24;
  getAttribute(name) { return this.attrs.get(name) || null; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  removeAttribute(name) { this.attrs.delete(name); }
  append(child) { this.children.push(child); child.parent = this; child.isConnected = true; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  closest() { return this.title ? this : this.parent?.closest() || null; }
  getBoundingClientRect() { return { left: 20, top: 50, bottom: 80 }; }
}
function fixture() {
  const root = new Element(), target = new Element(), body = new Element();
  target.title = '完整任务名称'; target.setAttribute('aria-describedby', 'existing-help'); root.append(target);
  global.document = Object.assign(new Events(), { body, createElement: () => new Element() });
  global.window = Object.assign(new Events(), { innerWidth: 1000, innerHeight: 800 });
  let mutate;
  global.MutationObserver = class { constructor(callback) { mutate = callback; } observe() {} };
  const close = installTaskTooltips(root);
  const show = () => { root.emit('focusin', { target }); assert.equal(body.children.length, 1); assert.equal(target.getAttribute('aria-describedby'), 'existing-help task-focus-tooltip'); };
  const closed = () => { assert.equal(body.children.length, 0); assert.equal(target.getAttribute('aria-describedby'), 'existing-help'); };
  return { root, target, body, close, show, closed, mutate: () => mutate() };
}
test('#19 nested sidebar/workspace scroll clears tooltip through capture listener', () => {
  const f = fixture(); f.show(); assert.equal(f.root.listeners.get('scroll')[0].capture, true); f.root.emit('scroll'); f.closed();
});
test('#19 resize, pointerdown and visibility change dismiss tooltip and restore prior description', () => {
  const f = fixture();
  for (const [source, event] of [[window, 'resize'], [document, 'pointerdown'], [document, 'visibilitychange']]) { f.show(); source.emit(event); f.closed(); }
});
test('#19 detached or retitled targets clear tooltip after DOM updates', () => {
  let f = fixture(); f.show(); f.target.remove(); f.mutate(); f.closed();
  f = fixture(); f.show(); f.target.title = 'different task'; f.mutate(); f.closed();
});
test('#19 navigation cleanup and Escape dismiss without dropping existing aria-describedby', () => {
  const f = fixture(); f.show(); f.close(); f.closed(); f.show(); document.emit('keydown', { key: 'Escape' }); f.closed();
});
test('#19 pointer moves inside trigger retain tooltip; leaving trigger dismisses it', () => {
  const f = fixture(), child = new Element(); f.target.append(child); f.show();
  f.root.emit('pointerout', { relatedTarget: child }); assert.equal(f.body.children.length, 1);
  f.root.emit('pointerout', { relatedTarget: null }); f.closed();
});
