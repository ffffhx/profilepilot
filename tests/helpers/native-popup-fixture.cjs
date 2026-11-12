const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');
async function popupFixture(initialTabs = [], overrides = {}) {
  const elements = new Map(), timers = new Map(), calls = [], intervals = [];
  const event = () => ({ addListener(fn) { this.emit = fn; } });
  const element = () => ({ value: '', checked: false, hidden: false, disabled: false, children: [], listeners: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    setAttribute(name, value) { this[name] = value; },
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
    runtime: { getManifest: () => ({ version: '0.2.18' }), async sendMessage(message) {
      calls.push(structuredClone(message));
      if (handlers[message.method]) return handlers[message.method](message);
      if (message.method === 'getPageContext') return { result: message.tabId ? tabs.find(t => t.id === message.tabId) : state.currentTab };
      return { result: state };
    } },
    storage: { local: { get: async key => key === null ? { ...storage } : { [key]: storage[key] },
      set: async values => Object.assign(storage, values), remove: async keys => { for (const key of [].concat(keys)) delete storage[key]; } },
      session: { get: async key => ({ [key]: storage[key] }), remove: async key => { delete storage[key]; } }, onChanged: event() },
    downloads: { download: async options => { calls.push({ method: 'downloads.download', ...options }); return 1; } },
    tabs: { query: async () => { calls.push({ method: 'tabs.query' }); return tabs; }, onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event() },
    windows: { getCurrent: async () => ({ id: 2 }) },
    sidePanel: { open: async options => { calls.push({ method: 'sidePanel.open', ...options }); } }
  };
  const window = { listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, close() { this.closed = true; } };
  const context = vm.createContext({ chrome, document, URL, URLSearchParams, crypto: webcrypto, location: { hash: overrides.hash || '' },
    window, setInterval(fn) { intervals.push(fn); },
    setTimeout(fn, ms) { timers.set(fn, ms); return fn; }, clearTimeout(fn) { timers.delete(fn); }
  });
  vm.runInContext(readFileSync('extensions/profilepilot/connection-diagnostics.js', 'utf8'), context);
  const ready = vm.runInContext('(async () => {' + readFileSync('extensions/profilepilot/popup.js', 'utf8') + '\n})()', context);
  if (overrides.deferInitial) await new Promise(resolve => setImmediate(resolve));
  else await ready;
  const flush = async (expireReads = false) => {
    await new Promise(resolve => setImmediate(resolve));
    for (const [fn, ms] of [...timers]) if (expireReads || ms < 4000) { timers.delete(fn); fn(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  const submit = selector => document.querySelector(selector).listeners.submit({ preventDefault() {} });
  return { chrome, calls, flush, handlers, submit, storage, ready, window, element: selector => document.querySelector(selector), state,
    setState: patch => { state = { ...state, ...patch }; },
    poll: async () => { for (const fn of intervals) fn(); await flush(); },
    setTabs: value => { tabs = value; } };
}
module.exports = { popupFixture };
