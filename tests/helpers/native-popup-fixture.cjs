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
  const document = { body: element(), querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  }, createElement: element };
  document.querySelector('#include-selection').checked = true;
  let tabs = initialTabs;
  let state = { profileId: 'native:Default', connected: true, ownership: 'user',
    currentTab: initialTabs.find(t => t.windowId === 2 && t.active) || initialTabs.find(t => t.active),
    access: { blockedOrigins: [], confirmActions: false }, ...overrides.state };
  const storage = { ...(overrides.storage || {}) };
  const handlers = {};
  const chrome = {
    runtime: { async sendMessage(message) {
      calls.push(structuredClone(message));
      if (handlers[message.method]) return handlers[message.method](message);
      if (message.method === 'getPageContext') return { result: message.tabId ? tabs.find(t => t.id === message.tabId) : state.currentTab };
      return { result: state };
    } },
    storage: { session: { get: async key => ({ [key]: storage[key] }), remove: async key => { delete storage[key]; } }, onChanged: event() },
    tabs: { query: async () => tabs, onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event() },
    windows: { getCurrent: async () => ({ id: 2 }) },
    sidePanel: { open: async options => { calls.push({ method: 'sidePanel.open', ...options }); } }
  };
  const context = vm.createContext({ chrome, document, URL, URLSearchParams, crypto: webcrypto, location: { hash: overrides.hash || '' },
    window: { addEventListener() {} }, setInterval(fn) { intervals.push(fn); },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); }
  });
  await vm.runInContext('(async () => {' + readFileSync('extensions/profilepilot/popup.js', 'utf8') + '\n})()', context);
  const flush = async () => {
    for (const fn of [...timers]) { timers.delete(fn); fn(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  const submit = selector => document.querySelector(selector).listeners.submit({ preventDefault() {} });
  return { chrome, calls, flush, handlers, submit, storage, element: selector => document.querySelector(selector), state,
    setState: patch => { state = { ...state, ...patch }; },
    poll: async () => { for (const fn of intervals) fn(); await flush(); },
    setTabs: value => { tabs = value; } };
}
module.exports = { popupFixture };
