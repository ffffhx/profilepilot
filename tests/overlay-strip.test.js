const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { agentOverlayBootstrapScript } = require('../dist/main/overlay-script');

// Minimal DOM for exercising the real bootstrap's control protocol. Layout is
// deliberately supplied by tests; browser verification covers actual CSS sizing.
function fixture(initial = {}, { binding = true } = {}) {
  const timers = new Map();
  const signals = [];
  let timerId = 0;
  let shadow;
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.listeners = {};
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.textContent = '';
      this.className = '';
      this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        toggle: (name, enabled) => {
          const values = new Set(this.className.split(' ').filter(Boolean));
          (enabled ?? !values.has(name)) ? values.add(name) : values.delete(name);
          this.className = [...values].join(' ');
        },
        add: name => this.classList.toggle(name, true),
        remove: name => this.classList.toggle(name, false)
      };
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    attachShadow() { shadow = new Element('shadow'); shadow.parent = this; return shadow; }
    querySelector(selector) {
      for (const child of this.children) {
        if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(x => x !== fn); }
    dispatch(name, data = {}) {
      for (const fn of this.listeners[name] || []) fn({ currentTarget: this, preventDefault() {}, stopPropagation() {}, ...data });
    }
    click() { if (!this.disabled) this.dispatch('click'); }
    focus() { shadow.activeElement = this; }
    get isConnected() { return this === document.documentElement || Boolean(this.parent?.isConnected); }
    getBoundingClientRect() { return this.hidden ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } : this.rect; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  }
  const document = {
    documentElement: new Element('html'), body: new Element('body'), visibilityState: 'visible',
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    elementFromPoint: () => null
  };
  const storage = new Map();
  const window = new Element('window');
  Object.assign(window, {
    top: window, self: window,
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)' }),
    innerWidth: 1000, innerHeight: 700, outerWidth: 1000, outerHeight: 800, devicePixelRatio: 1
  });
  if (binding) window.__ppAgentOverlaySignal = payload => signals.push(JSON.parse(payload));
  vm.runInNewContext(agentOverlayBootstrapScript(), {
    window, document, sessionStorage: window.sessionStorage, navigator: { language: 'zh-CN' },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval: () => ++timerId, clearInterval() {}
  });
  const base = { locale: 'zh', session: 'strip-test', inputGuardState: 'active', ...initial };
  const update = data => window.__ppAgentOverlayUpdate({ ...base, ...data });
  update({});
  const find = selector => shadow.querySelector(selector);
  return {
    window, document, shadow, signals, timers, storage, update, find,
    click: selector => find(selector).click(),
    label: selector => find(selector).querySelector('.button-label').textContent,
    title: () => find('.title').textContent,
    expire: delay => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } }
  };
}

test('strip starts with status and takeover only', () => {
  const f = fixture();
  assert.equal(f.title(), 'Agent 操作中');
  assert.equal(f.find('.status').hidden, false);
  assert.equal(f.find('.stop').hidden, true);
  assert.equal(f.find('.more').hidden, false);
  assert.equal(f.find('.back').hidden, true);
  f.click('.stop');
  assert.deepEqual(f.signals, []);
  f.click('.takeover');
  assert.deepEqual(f.signals, [{ action: 'stop', session: 'strip-test', reason: 'user_takeover' }]);
  assert.ok(f.find('.panel').isConnected);
});

test('more replaces status in place and keyboard return cancels destructive confirmation', () => {
  const f = fixture();
  const panel = f.find('.panel');
  f.find('.more').focus();
  f.click('.more');
  assert.equal(f.find('.status').hidden, true);
  assert.equal(f.find('.takeover').hidden, true);
  assert.equal(f.find('.stop').hidden, false);
  assert.equal(f.shadow.activeElement, f.find('.back'));
  f.click('.stop');
  assert.equal(f.label('.stop'), '确认结束');
  assert.deepEqual(f.signals, []);
  f.window.dispatch('keydown', { key: 'Escape' });
  assert.equal(f.find('.panel'), panel);
  assert.equal(f.find('.status').hidden, false);
  assert.equal(f.shadow.activeElement, f.find('.more'));
  f.click('.more');
  assert.equal(f.label('.stop'), '结束任务');
  f.click('.stop');
  assert.deepEqual(f.signals, []);
});

test('stop requires two clicks within the confirmation window and tears down after dispatch', () => {
  const f = fixture();
  f.click('.more');
  f.click('.stop');
  f.expire(3000);
  assert.equal(f.label('.stop'), '结束任务');
  f.click('.stop');
  assert.deepEqual(f.signals, []);
  f.click('.stop');
  assert.deepEqual(f.signals, [{ action: 'stop', reason: 'user_stop' }]);
  assert.equal(f.window.__ppAgentOverlayUpdate, undefined);
  assert.equal(f.find('.panel').isConnected, false);
  assert.ok(Number(f.storage.get('__ppAgentOverlayTerminalStopUntil')) > Date.now());
});

test('taken, pending user action and errors remain in the strip with original resume semantics', () => {
  const f = fixture();
  f.update({ ownership: 'agentDelegatedToUser' });
  assert.equal(f.title(), '你已接管');
  assert.equal(f.label('.takeover'), '交还');
  f.click('.takeover');
  assert.deepEqual(f.signals, [{ action: 'resume', session: 'strip-test' }]);
  f.update({ ownership: 'agentDelegatedToUser', pendingUserAction: '完成网页中的验证' });
  assert.equal(f.title(), '等待你操作');
  assert.equal(f.find('.status').title, '完成网页中的验证');
  f.click('.more');
  f.click('.stop');
  f.update({ ownership: 'agentDelegatedToUser', stopError: '原 Agent 没有等待接收控制权' });
  assert.equal(f.title(), '交还失败');
  assert.equal(f.find('.status').title, '原 Agent 没有等待接收控制权');
  assert.equal(f.find('.stop').hidden, true);
  assert.equal(f.label('.stop'), '结束任务');
});

test('pending handoff and missing binding block actions; offline still permits ending', () => {
  const f = fixture();
  f.update({ handoffPending: true });
  assert.equal(f.title(), '正在交接');
  f.click('.takeover');
  f.click('.more');
  f.click('.stop');
  f.click('.stop');
  assert.deepEqual(f.signals, []);
  f.update({ ownership: 'agentDelegatedToUser', agentOffline: true });
  assert.equal(f.title(), 'Agent 已离线');
  assert.equal(f.find('.takeover').hidden, true);
  f.click('.more');
  f.click('.stop');
  f.click('.stop');
  assert.equal(f.signals[0].reason, 'user_stop');
  const unbound = fixture({}, { binding: false });
  assert.equal(unbound.find('.takeover').disabled, true);
  assert.equal(unbound.find('.stop').disabled, true);
});

test('ordinary updates keep menu open; outside click returns without stealing page focus', () => {
  const f = fixture();
  f.click('.more');
  f.update({ currentAction: 'reading', sessionTitle: 'hidden metadata' });
  assert.equal(f.find('.stop').hidden, false);
  f.window.dispatch('pointerdown', { composedPath: () => [] });
  assert.equal(f.find('.status').hidden, false);
  assert.equal(f.shadow.activeElement, undefined);
  assert.equal(f.find('.details'), null);
  assert.equal(f.find('.target-follow'), null);
});

test('a new user request leaves the menu and cancels an armed stop', () => {
  const f = fixture({ ownership: 'agentDelegatedToUser' });
  f.click('.more');
  f.click('.stop');
  f.update({ pendingUserAction: '请完成验证' });
  assert.equal(f.find('.status').hidden, false);
  assert.equal(f.title(), '等待你操作');
  assert.equal(f.label('.stop'), '结束任务');
});

for (const [displayScale, zoom] of [[1, 1], [1.25, 1], [2, 1], [1.25, 1.25], [2, 1.5]]) {
  test(`native guard menu at display scale ${displayScale} and browser zoom ${zoom}`, () => {
    const f = fixture();
    f.window.devicePixelRatio = displayScale * zoom;
    f.find('.more').rect = { left: 940, top: 648, right: 972, bottom: 680, width: 32, height: 32 };
    f.find('.back').rect = { left: 880, top: 648, right: 972, bottom: 680, width: 92, height: 32 };
    const point = { x: 956 * zoom, y: 100 + 664 * zoom };
    const payload = { window: { x: 0, y: 0, width: 1000 * zoom, height: 100 + 700 * zoom }, down: point, up: point, displayScale };
    const probe = f.window.__ppAgentOverlayGuardProbe(payload);
    assert.equal(probe.action, 'more');
    assert.equal(f.window.__ppAgentOverlayGuardActivate(payload, probe.signature), true);
    assert.equal(f.find('.stop').hidden, false);
    assert.equal(f.window.__ppAgentOverlayGuardActivate(payload, probe.signature), false, 'stale layout cannot replay an action');
    const back = f.window.__ppAgentOverlayGuardProbe(payload);
    assert.equal(back.action, 'back');
    assert.equal(f.window.__ppAgentOverlayGuardActivate(payload, back.signature), true);
    assert.equal(f.find('.status').hidden, false);
    assert.equal(f.window.__ppAgentOverlayGuardProbe({ ...payload, up: { x: 800 * zoom, y: point.y } }), null);
    assert.deepEqual(f.signals, []);
  });
}
