const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');
async function popupFixture(initialTabs = [], overrides = {}) {
  const elements = new Map(), timers = new Set(), calls = [], intervals = [];
  const event = () => ({ addListener(fn) { this.emit = fn; } });
  const element = () => ({ value: '', checked: false, hidden: false, disabled: false, children: [], listeners: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    classList: { add() {} }, focus() { this.focused = true; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    replaceChildren(...children) { this.children = children; }
  });
  const html = readFileSync('extensions/profilepilot/' + (overrides.sidePanel ? 'sidepanel.html' : 'popup.html'), 'utf8');
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set('#' + match[1], { ...element(), hidden: /\bhidden\b/.test(match[0]) });
  }
  elements.set('label[for="code"]', element());
  const document = { body: element(), querySelector: selector => elements.get(selector) || null, createElement: element };
  let tabs = initialTabs;
  let state = { profileId: 'native:Default', connected: true, ownership: 'user',
    currentTab: initialTabs.find(t => t.windowId === 2 && t.active) || initialTabs.find(t => t.active),
    access: { blockedOrigins: [], confirmActions: false }, ...overrides.state };
  const storage = { ...(overrides.storage || {}) };
  const handlers = { ...overrides.handlers };
  const chrome = {
    runtime: { async sendMessage(message) {
      calls.push(structuredClone(message));
      if (handlers[message.method]) return handlers[message.method](message);
      if (message.method === 'getPageContext') return { result: message.tabId ? tabs.find(t => t.id === message.tabId) : state.currentTab };
      return { result: state };
    } },
    storage: { session: { get: async key => ({ [key]: storage[key] }), remove: async key => { delete storage[key]; } }, onChanged: event() },
    tabs: { query: async () => { calls.push({ method: 'tabs.query' }); return tabs; }, onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event() },
    windows: { getCurrent: async () => ({ id: 2 }) },
    sidePanel: { open: async options => { calls.push({ method: 'sidePanel.open', ...options }); } }
  };
  const window = { listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, close() { this.closed = true; } };
  const context = vm.createContext({ chrome, document, URL, URLSearchParams, crypto: webcrypto, location: { hash: overrides.hash || '' },
    window, setInterval(fn) { intervals.push(fn); },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); }
  });
  const ready = vm.runInContext('(async () => {' + readFileSync('extensions/profilepilot/popup.js', 'utf8') + '\n})()', context);
  if (overrides.deferInitial) await new Promise(resolve => setImmediate(resolve));
  else await ready;
  const flush = async () => {
    for (const fn of [...timers]) { timers.delete(fn); fn(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  const submit = selector => document.querySelector(selector).listeners.submit({ preventDefault() {} });
  return { chrome, calls, flush, handlers, submit, storage, ready, window, element: selector => document.querySelector(selector), state,
    setState: patch => { state = { ...state, ...patch }; },
    poll: async () => { for (const fn of intervals) fn(); await flush(); },
    setTabs: value => { tabs = value; } };
}
module.exports = { popupFixture };
