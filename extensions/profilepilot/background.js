// Uses Chrome's documented debugger transport. No ChatGPT runtime dependency.
let socket, config, currentTab, sessionId, ownership = 'user', attached = false, pausedByBrowser = false;
let heartbeat, preview = false, connecting, authenticated = false, connectionError = '', commandQueue = Promise.resolve();
let controlEpoch = 0;
// A restarted worker must never accept a token issued by its predecessor.
const controlInstance = crypto.randomUUID();
const controlGeneration = () => `${controlInstance}:${controlEpoch}`;
let installationType;
let installationMode;
const allowedTabs = new Set();
// Only tabs created for a task (or explicitly added during takeover) belong to
// that task. Session storage cannot survive Chrome restart and stale tab IDs.
const taskTabs = new Map();
// Creation marks last for this Chrome session, including after a task finishes.
const createdTabs = new Set(), logoTabs = new Set(), logoUpdates = new Map();
const appliedLogos = new Map();
const childSessions = new Set();
let access = { blockedOrigins: [], confirmActions: false }, uiSequence = 0;
const uiPending = new Map();
const downloadOwners = new Map(), downloadArms = new Map();
const PREVIEW_METHODS = new Set(['Page.enable', 'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck', 'Emulation.setFocusEmulationEnabled']);
const send = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
const usable = url => /^(https?:\/\/|about:blank$)/.test(url || '');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(operation, timeout, message) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function debuggerCommand(method, params = {}, previewOnly = false, cdpSessionId) {
  // A background tab may have no compositor frame. Visual reads are optional
  // and cannot cause uncertain input, so timing out must not revoke ownership.
  const visualOnly = previewOnly || method === 'Page.captureScreenshot';
  try {
    return await bounded(chrome.debugger.sendCommand({ tabId: currentTab, ...(cdpSessionId ? { sessionId: cdpSessionId } : {}) }, method, params), visualOnly ? 2500 : 10000,
      `${previewOnly ? '实时画面' : visualOnly ? '截图' : method === 'Runtime.evaluate' ? '页面读取或操作' : '浏览器操作'}无响应，已停止等待。`);
  } catch (error) {
    // Stop the debugger before allowing another task command to run. In-flight
    // input may have taken effect; never replay it automatically after a timeout.
    // A protocol error (unsupported method, stale context) is definitive. Only a
    // timeout has an uncertain outcome and must stop subsequent input.
    if (!visualOnly && String(error.message).includes('无响应')) { ownership = 'user'; controlEpoch++; pausedByBrowser = true; await detach(); void publish(); }
    throw error;
  }
}
function requireOwner(expected) {
  if (!sessionId || sessionId !== expected) throw new Error('浏览器会话不匹配。');
  if (ownership !== 'agent') throw new Error('用户正在操作浏览器，请交还后继续。');
}
async function state() {
  const tab = currentTab ? await chrome.tabs.get(currentTab).catch(() => undefined) : undefined;
  return { connected: authenticated && socket?.readyState === WebSocket.OPEN, taskTabs: true, controlGeneration: controlGeneration(), extensionVersion: chrome.runtime.getManifest?.().version || '0.2.0', installationType, installationMode, capabilities: ['tabs', 'cdp', 'cdpSessions', 'history', 'downloads', 'sidePanel'], profileId: config?.profileId, tabId: currentTab, sessionId, ownership, tabTitle: tab?.title, url: tab?.url, pausedByBrowser, connectionError, access };
}
function assertSite(url) {
  if (!usable(url)) throw new Error('此页面不允许自动化，请选择普通网页。');
  if (url !== 'about:blank' && access.blockedOrigins.includes(new URL(url).origin)) throw new Error('此网站已在可选站点设置中禁止。');
  if (url !== 'about:blank' && access.allowedOrigins?.length && !access.allowedOrigins.includes(new URL(url).origin)) throw new Error('此网站不在可选允许列表中。');
}
async function ordinaryTabs() {
  const tabs = chrome.tabs.query ? await chrome.tabs.query({}) : await Promise.all([...allowedTabs].map(id => chrome.tabs.get(id).catch(() => undefined)));
  return tabs.filter(t => t && !t.incognito && usable(t.url));
}
async function publish() {
  syncTabLogos();
  const value = await state(); send({ type: 'state', state: value });
  await chrome.action.setBadgeText({ text: !value.connected ? '' : ownership === 'agent' ? 'AI' : '你' });
  await chrome.action.setBadgeBackgroundColor({ color: ownership === 'agent' ? '#517843' : '#8e7546' });
}
// Serialized into Chrome's isolated content-script world; no page globals or
// debugger commands are needed, and changing the favicon never activates a tab.
function updatePageTabLogo(logoUrl) {
  const key = '__profilepilotTabLogo';
  if (globalThis[key]) { globalThis[key].update(logoUrl); return; }
  if (!logoUrl || !document.documentElement) return;
  let logo = logoUrl, ownIcon;
  const originals = new Map(), attributes = ['href', 'type', 'sizes'];
  const isIcon = node => node.tagName === 'LINK' && /(?:^|\s)icon(?:\s|$)/i.test(node.getAttribute('rel') || '');
  const write = (node, name, value) => value === null ? node.removeAttribute(name) : node.setAttribute(name, value);
  function reconcile() {
    observer.disconnect();
    const icons = [...document.querySelectorAll('link[rel]')].filter(node => node !== ownIcon && isIcon(node));
    for (const node of icons) {
      const saved = originals.get(node) || { values: {}, applied: {} };
      for (const name of attributes) {
        const value = node.getAttribute(name);
        // Retain the site's latest icon, including changes made during control.
        if (!(name in saved.values) || value !== saved.applied[name]) saved.values[name] = value;
      }
      originals.set(node, saved);
      if (logo) {
        saved.applied = { href: logo, type: 'image/png', sizes: '32x32' };
        for (const name of attributes) write(node, name, saved.applied[name]);
      }
    }
    if (!logo) {
      ownIcon?.remove();
      for (const [node, saved] of originals) if (node.isConnected) {
        for (const name of attributes) if (node.getAttribute(name) === saved.applied[name]) write(node, name, saved.values[name]);
      }
      // Removing the only <link> can leave Chrome displaying the last icon.
      if (!icons.length && document.head) {
        const fallback = document.createElement('link');
        fallback.rel = 'icon'; fallback.href = new URL('/favicon.ico', location.href).href;
        document.head.append(fallback);
      }
      delete globalThis[key];
      return;
    }
    for (const [node, saved] of originals) if (node.isConnected && !isIcon(node)) {
      for (const name of attributes) if (node.getAttribute(name) === saved.applied[name]) write(node, name, saved.values[name]);
      originals.delete(node);
    }
    if (document.head) {
      if (!ownIcon) { ownIcon = document.createElement('link'); ownIcon.rel = 'icon'; ownIcon.type = 'image/png'; ownIcon.sizes = '32x32'; }
      ownIcon.href = logo;
      // Last matching icon wins even on sites with several sizes/formats.
      document.head.append(ownIcon);
    }
    for (const node of originals.keys()) if (!node.isConnected) originals.delete(node);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['rel', 'href', 'type', 'sizes'] });
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target.closest?.('head') || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeName === 'HEAD'))) reconcile();
  });
  globalThis[key] = { update(value) { logo = value; reconcile(); } };
  reconcile();
}
function saveTabLogos() {
  return chrome.storage.session.set({ tabLogos: { profileId: config?.profileId, created: [...createdTabs], touched: [...logoTabs] } });
}
function syncTabLogos(forceTab) {
  if (!chrome.scripting?.executeScript || !chrome.runtime.getURL) return;
  if (sessionId && ownership === 'agent' && currentTab) logoTabs.add(currentTab);
  for (const id of createdTabs) logoTabs.add(id);
  void saveTabLogos().catch(() => {});
  for (const id of logoTabs) {
    const next = (logoUpdates.get(id) || Promise.resolve()).then(async () => {
      const tab = await chrome.tabs.get(id).catch(() => undefined);
      if (!tab || tab.incognito || !/^https?:\/\//.test(tab.url || '') || tab.discarded || tab.frozen || tab.status === 'unloaded') return;
      const marked = createdTabs.has(id) || Boolean(sessionId && ownership === 'agent' && currentTab === id);
      const stamp = `${marked}:${tab.url}`;
      if (id !== forceTab && appliedLogos.get(id) === stamp) return;
      await chrome.scripting.executeScript({ target: { tabId: id }, func: updatePageTabLogo, args: [marked ? chrome.runtime.getURL('icons/icon-32.png') : null] });
      appliedLogos.set(id, stamp);
    }).catch(() => {}); // Restricted pages or closing tabs must not stop a task.
    logoUpdates.set(id, next);
    void next.finally(() => { if (logoUpdates.get(id) === next) logoUpdates.delete(id); });
  }
}
async function attach(check = () => {}) {
  check();
  if (pausedByBrowser) throw new Error('浏览器调试已由你停止，请在 ProfilePilot 中点击继续任务。');
  if (!currentTab || !allowedTabs.has(currentTab)) throw new Error('请在扩展中选择一个允许操作的标签页。');
  let tab = await chrome.tabs.get(currentTab); check();
  assertSite(tab.url);
  // Memory Saver leaves a valid tab ID and URL, but no renderer to answer CDP.
  // Restore only the tab explicitly authorized by the user. Activating it also
  // unfreezes a tab; do not reload live pages or change the user's window focus.
  if (tab.discarded || tab.frozen || tab.status === 'unloaded') {
    throw new Error('标签页正在休眠；请显式打开该页恢复后继续，后台操作不会切换当前页面。');
  }
  if (attached) return;
  // If another extension owns the debugger, surface Chrome's error; never detach it.
  const target = { tabId: currentTab };
  let expired = false;
  const attaching = chrome.debugger.attach(target, '1.3').then(() => {
    if (expired) { void chrome.debugger.detach(target).catch(() => {}); return; }
    attached = true;
  });
  try { await bounded(attaching, 4000, '无法连接授权标签页，请检查 Chrome 的调试提示后继续。'); check(); }
  catch (error) { expired = true; if (attached) await detach(); throw error; }
}
async function attachForTask(check = () => {}) {
  const generation = controlGeneration();
  try { await attach(check); }
  catch (error) {
    // A newer stop already owns state; a stale attach failure must not change it.
    if (generation !== controlGeneration()) throw error;
    // A failed connection is not a user takeover. Keep it paused, and publish
    // the actual cause so the desktop doesn't ask the user to grant control again.
    ownership = 'user'; controlEpoch++; pausedByBrowser = true; await publish(); throw error;
  }
}
async function stopPreview() {
  if (!attached || !preview) { preview = false; return; }
  preview = false;
  await debuggerCommand('Page.stopScreencast', {}, true).catch(() => {});
  await debuggerCommand('Emulation.setFocusEmulationEnabled', { enabled: false }, true).catch(() => {});
}
async function clearFocusEmulation() {
  if (!attached) return;
  await bounded(chrome.debugger.sendCommand({ tabId: currentTab }, 'Emulation.setFocusEmulationEnabled', { enabled: false }), 1000, '清理页面焦点模拟超时。').catch(() => {});
}
async function detach() {
  // Detach itself stops screencasting. Waiting for a stuck Page command first
  // would prevent takeover/release from ever reaching Chrome.
  const tabId = currentTab; const wasAttached = attached; attached = false; preview = false;
  childSessions.clear();
  if (wasAttached) await bounded(chrome.debugger.detach({ tabId }), 1000, '停止浏览器调试超时。').catch(() => {});
}
async function select(tabId, check = () => {}) {
  const expectedSession = sessionId, expectedOwnership = ownership, epoch = controlEpoch;
  const callerCheck = check;
  check = () => {
    callerCheck();
    if (sessionId !== expectedSession || ownership !== expectedOwnership || controlEpoch !== epoch) throw new Error('浏览器控制状态已改变，标签切换已取消。');
  };
  check();
  const tab = await chrome.tabs.get(tabId); check();
  if (tab.incognito) throw new Error('请选择普通网页标签页。');
  assertSite(tab.url);
  if (tab.discarded || tab.frozen || tab.status === 'unloaded') throw new Error('目标标签页正在休眠，当前操作标签未切换；可在当前标签打开目标地址，或由用户恢复休眠标签页。');
  const previousTab = currentTab, previousAllowed = [...allowedTabs], previousPaused = pausedByBrowser;
  await detach(); check(); currentTab = tabId;
  if (!sessionId) allowedTabs.clear();
  allowedTabs.add(tabId);
  try {
    // Selecting a page while the user owns the browser is not a resume gesture.
    if (sessionId && ownership === 'agent') { await attach(check); check(); }
    await saveSelection(); check(); await publish(); check();
  }
  catch (error) {
    // A failed switch must not poison subsequent open/read requests with an
    // unusable target. A takeover invalidates check() and owns the new state.
    check();
    if (currentTab === tabId) {
      await detach(); check(); currentTab = previousTab;
      allowedTabs.clear(); for (const id of previousAllowed) allowedTabs.add(id);
      pausedByBrowser = previousPaused;
      try { await saveSelection(); check(); await publish(); check(); }
      catch (restoreError) {
        check();
        throw new Error(`${error.message || error}；恢复原标签记录失败：${restoreError.message || restoreError}`);
      }
    }
    throw error;
  }
}
function createdTabFailure(error, tabId) {
  const failure = new Error(`${error.message || error} 新标签页已创建（ID: ${tabId}），请先核查该标签，勿重复新建。`);
  failure.createdTabId = tabId;
  return failure;
}
async function createReadyTab(url, check) {
  check();
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    check();
    if (!Number.isSafeInteger(tab.id) || tab.incognito) throw new Error('无法创建普通任务标签页。');
    createdTabs.add(tab.id); syncTabLogos(tab.id);
    // Chrome can return pendingUrl without a committed URL, or about:blank
    // while the requested URL is pending. Wait only for this newly created tab.
    const deadline = Date.now() + 4000;
    while (true) {
      check();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('新标签页尚未完成加载。');
      const ready = await bounded(chrome.tabs.get(tab.id), remaining, '新标签页尚未完成加载。'); check();
      if (ready.incognito) throw new Error('请选择普通网页标签页。');
      if (ready.url && !ready.pendingUrl) { assertSite(ready.url); return ready; }
      await delay(Math.min(50, Math.max(1, deadline - Date.now()))); check();
    }
  } catch (error) {
    // Do not remove the new tab: a takeover may already be using it. The ID
    // makes the partial outcome recoverable without replaying tabs.create.
    throw createdTabFailure(error, tab.id);
  }
}
async function createAndSelectTab(url, check) {
  const tab = await createReadyTab(url, check);
  try { await select(tab.id, check); check(); return { tabId: tab.id }; }
  catch (error) { throw createdTabFailure(error, tab.id); }
}
async function saveSelection() {
  if (sessionId) taskTabs.set(sessionId, { tabId: currentTab, tabs: [...allowedTabs] });
  await chrome.storage.session.set({ selection: { profileId: config?.profileId, tabId: currentTab, sessionId }, taskTabs: { profileId: config?.profileId, tasks: [...taskTabs] } });
}
async function prepareTask(id, check, options = {}) {
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('无效的任务会话。');
  const saved = taskTabs.get(id);
  const idleSelection = !sessionId ? currentTab : undefined;
  if (!options.newTab && options.tabId === undefined && sessionId === id && currentTab && allowedTabs.has(currentTab)) {
    const tab = await chrome.tabs.get(currentTab).catch(() => undefined); check();
    if (tab && usable(tab.url) && !tab.incognito) return;
  }
  await detach(); check();
  currentTab = undefined; allowedTabs.clear();
  for (const tabId of saved?.tabs || []) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined); check();
    if (tab && usable(tab.url) && !tab.incognito) allowedTabs.add(tabId);
  }
  currentTab = options.newTab ? undefined : allowedTabs.has(saved?.tabId) ? saved.tabId : [...allowedTabs][0];
  if (options.tabId !== undefined) {
    const selected = await chrome.tabs.get(Number(options.tabId)); check();
    if (selected.incognito) throw new Error('请选择普通网页标签页。');
    assertSite(selected.url); currentTab = selected.id; allowedTabs.add(currentTab);
  } else if (!currentTab && !options.newTab) {
    const tabs = await ordinaryTabs(); check();
    const active = chrome.tabs.query ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] : undefined;
    check();
    // An implicit new-task selection must not inherit a stale idle tab that
    // Memory Saver discarded. Explicit tab selections still report the issue.
    const permitted = tab => { try { assertSite(tab.url); return !tab.discarded && !tab.frozen && tab.status !== 'unloaded'; } catch { return false; } };
    const tab = tabs.find(t => t.id === idleSelection && permitted(t)) || tabs.find(t => t.id === active?.id && permitted(t)) || tabs.find(permitted);
    if (tab) { currentTab = tab.id; allowedTabs.add(tab.id); }
  }
  if (!currentTab) {
    // No opener: existing user tabs never become ancestors of task-owned tabs.
    const tab = await createReadyTab('about:blank', check); check();
    currentTab = tab.id; allowedTabs.add(tab.id);
    taskTabs.set(id, { tabId: currentTab, tabs: [...allowedTabs] });
    await saveSelection(); check();
  }
  taskTabs.set(id, { tabId: currentTab, tabs: [...allowedTabs] });
}
async function handle(method, p, check = () => {}) {
  if (method === 'control' && p.action === 'resume') {
    const transportCheck = check;
    check = () => {
      transportCheck();
      if (typeof p.controlGeneration !== 'string') throw new Error('请更新 ProfilePilot 应用以使用停止代次保护后再恢复任务。');
      if (p.controlGeneration !== controlGeneration()) throw new Error('用户已停止或接管，排队恢复已取消。');
    };
  }
  check();
  if (method === 'extension.reload') {
    if (sessionId) throw new Error('当前 Profile 仍有任务（包括已接管任务），请结束后更新扩展。');
    if (installationMode === 'temporary') throw new Error('当前为临时安装，Chrome 可能在重载后禁用扩展。请先完成持久安装，并在扩展中明确确认后再更新。');
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: true, version: chrome.runtime.getManifest?.().version || '0.2.0' };
  }
  if (method === 'tabs' && !p.sessionId) return (await ordinaryTabs()).map(t => ({ id: String(t.id), title: t.title, url: t.url, active: t.active, current: t.id === currentTab, discarded: Boolean(t.discarded), frozen: Boolean(t.frozen), status: t.status }));
  if (method === 'history') {
    if (sessionId && (p.sessionId !== sessionId || ownership !== 'agent')) throw new Error('当前 Profile 已占用或用户正在操作浏览器。');
    const startTime = p.startTime === undefined ? 0 : Number(p.startTime), endTime = p.endTime === undefined ? Date.now() : Number(p.endTime);
    const maxResults = p.maxResults === undefined ? 100 : Number(p.maxResults);
    if (![startTime, endTime, maxResults].every(Number.isFinite) || startTime < 0 || endTime < startTime || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10000) throw new Error('历史搜索时间或数量无效。');
    return chrome.history.search({ text: String(p.query || ''), startTime, endTime, maxResults });
  }
  if (method === 'claim') {
    if (sessionId && sessionId !== p.sessionId) throw new Error('这个 Profile 已由另一个任务占用。');
    if (sessionId && ownership === 'user') throw new Error('用户正在操作浏览器，请交还后继续。');
    await prepareTask(p.sessionId, check, p); check();
    sessionId = p.sessionId; ownership = 'agent'; pausedByBrowser = false;
    await saveSelection(); check();
    await attachForTask(check);
    await publish(); return {};
  }
  if (method === 'control') {
    if (sessionId && sessionId !== p.sessionId) throw new Error('浏览器会话不匹配。');
    if (p.action === 'resume') { await prepareTask(p.sessionId, check); check(); sessionId = p.sessionId; pausedByBrowser = false; await saveSelection(); await attachForTask(check); check(); ownership = 'agent'; }
    else if (p.action === 'handoff') { ownership = 'user'; await clearFocusEmulation(); }
    else if (['complete', 'release'].includes(p.action)) { ownership = 'user'; await saveSelection(); sessionId = undefined; await detach(); allowedTabs.clear(); pausedByBrowser = false; await saveSelection(); }
    else throw new Error('未知控制操作。');
    await publish(); return {};
  }
  if (method === 'disconnect') { await disconnect(true); return {}; }
  if (method === 'focus') {
    if (!currentTab || (sessionId && sessionId !== p.sessionId)) throw new Error('浏览器会话不匹配。');
    const tab = await chrome.tabs.update(currentTab, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return {};
  }
  if (method === 'preview') {
    if (!sessionId || sessionId !== p.sessionId) throw new Error('浏览器会话不匹配。');
    if (!PREVIEW_METHODS.has(p.method)) throw new Error('预览不支持此操作。');
    if (p.method === 'Page.stopScreencast') { await stopPreview(); return {}; }
    await attach(check); check();
    if (p.method === 'Page.startScreencast') preview = true;
    return debuggerCommand(p.method, p.params || {}, true);
  }
  requireOwner(p.sessionId);
  if (method === 'preparePointer') {
    // Chrome may acknowledge pointer CDP commands on an inactive tab without
    // delivering them. Activate only the tab authorized for this task; never
    // focus its window or restore a window the user deliberately minimized.
    const tab = await chrome.tabs.get(currentTab); check(); requireOwner(p.sessionId);
    if (p.foreground === true && !tab.active) { await chrome.tabs.update(currentTab, { active: true }); check(); requireOwner(p.sessionId); }
    await attach(check); check(); requireOwner(p.sessionId);
    return {};
  }
  if (method === 'tabs') {
    const tabs = await ordinaryTabs();
    return tabs.filter(Boolean).map(t => ({ id: String(t.id), title: t.title, url: t.url, current: t.id === currentTab, discarded: Boolean(t.discarded), frozen: Boolean(t.frozen), status: t.status }));
  }
  if (method === 'switch') { await select(Number(p.tabId), check); return {}; }
  if (method === 'newTab') {
    const url = p.url || 'about:blank'; assertSite(url);
    return createAndSelectTab(url, () => { check(); requireOwner(p.sessionId); });
  }
  if (method === 'closeTab') {
    const id = Number(p.tabId); if (!allowedTabs.has(id)) throw new Error('该标签页未授权。');
    // Only an Agent-requested close may continue in another authorized tab.
    // A user closing the active tab still pauses through onRemoved below.
    if (id === currentTab) {
      const closing = await chrome.tabs.get(id); check(); requireOwner(p.sessionId);
      const candidates = [...allowedTabs].filter(other => other !== id);
      if (allowedTabs.has(closing.openerTabId)) candidates.sort((a, b) => Number(b === closing.openerTabId) - Number(a === closing.openerTabId));
      for (const candidate of candidates) {
        const tab = await chrome.tabs.get(candidate).catch(() => undefined); check(); requireOwner(p.sessionId);
        if (!tab || !usable(tab.url) || tab.incognito) continue;
        await select(candidate, check); check(); requireOwner(p.sessionId); break;
      }
    }
    check(); requireOwner(p.sessionId);
    await chrome.tabs.remove(id); return {};
  }
  if (method === 'open') {
    const url = new URL(p.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持 HTTP/HTTPS 页面。');
    assertSite(url.href);
    await attach(check); check(); requireOwner(p.sessionId); return debuggerCommand('Page.navigate', { url: url.href });
  }
  if (method === 'cdp') {
    if (typeof p.method !== 'string' || !/^[A-Za-z]+\.[A-Za-z0-9]+$/.test(p.method)) throw new Error('无效的 CDP 方法。');
    if (p.cdpSessionId && !childSessions.has(p.cdpSessionId)) throw new Error('子 frame 调试会话已失效，请重新观察。');
    if (p.method === 'Page.navigate') assertSite(p.params?.url);
    await attach(check); check(); requireOwner(p.sessionId); return debuggerCommand(p.method, p.params || {}, false, p.cdpSessionId);
  }
  if (method.startsWith('downloads.')) return handleDownload(method, p, check);
  throw new Error('未知扩展操作。');
}
function downloadItem(item) {
  return { id: item.id, filename: item.filename, state: item.state, error: item.error, url: item.url, finalUrl: item.finalUrl, bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, exists: item.exists, danger: item.danger };
}
async function handleDownload(method, p, check) {
  const owner = p.sessionId;
  if (method === 'downloads.start') {
    assertSite(p.url);
    if (!/^https?:\/\//.test(p.url)) throw new Error('下载地址必须是 HTTP/HTTPS。');
    const id = await chrome.downloads.download({ url: p.url, ...(p.filename ? { filename: String(p.filename) } : {}), conflictAction: 'uniquify', saveAs: false });
    // Record the returned ID even when takeover interrupted the response. Never
    // retry download(): it creates a second file.
    downloadOwners.set(id, owner);
    check(); requireOwner(owner);
    return { id };
  }
  if (method === 'downloads.arm') {
    if ([...downloadArms.values()].some(a => a.sessionId === owner && !a.id)) throw new Error('已有未完成的下载监听，请完成或 disarm 后再开始。');
    await attach(check); await debuggerCommand('Page.enable');
    const token = `${Date.now()}-${++uiSequence}`;
    downloadArms.set(token, { sessionId: owner, frameId: p.frameId, url: p.url, candidates: new Map(), began: undefined, error: undefined });
    return { token };
  }
  const arm = p.token ? downloadArms.get(p.token) : undefined;
  if (p.token && (!arm || arm.sessionId !== owner)) throw new Error('下载监听不属于此会话或已失效。');
  if (method === 'downloads.disarm') { downloadArms.delete(p.token); return {}; }
  if (method === 'downloads.cancel' && p.token && !arm.id) { downloadArms.delete(p.token); return {}; }
  if (method === 'downloads.wait' && arm && !arm.id) {
    const deadline = Date.now() + Math.min(300000, Math.max(1, Number(p.timeoutMs) || 30000));
    while (!arm.id) {
      check(); requireOwner(owner);
      if (!downloadArms.has(p.token)) throw new Error('下载监听已取消。');
      if (arm.error) throw new Error(arm.error);
      if (arm.began && arm.candidates.size === 1) {
        // Chrome exposes no shared GUID between these APIs. Only accept the
        // single observed creation matching the exact Page event; never scan a
        // directory or associate unrelated entries by their creation time.
        await delay(200); check(); requireOwner(owner);
        if (arm.candidates.size !== 1) throw new Error('多个下载具有同一地址，无法确认归属。');
        arm.id = [...arm.candidates.keys()][0]; downloadOwners.set(arm.id, owner); break;
      }
      if (Date.now() >= deadline) throw new Error(`未收到可明确关联的下载事件（页面事件=${Boolean(arm.began)}，候选=${arm.candidates.size}）；不要重复点击，请先核查页面。`);
      await delay(75);
    }
    p = { ...p, id: arm.id, timeoutMs: Math.max(1, deadline - Date.now()) };
  }
  const id = Number(p.id ?? arm?.id);
  if (method === 'downloads.search' && p.id === undefined && !p.token) {
    const items = await Promise.all([...downloadOwners].filter(([, session]) => session === owner).map(([id]) => chrome.downloads.search({ id })));
    return items.flat().map(downloadItem);
  }
  if (!Number.isSafeInteger(id) || downloadOwners.get(id) !== owner) throw new Error('下载编号不属于当前会话。');
  if (method === 'downloads.cancel') {
    await chrome.downloads.cancel(id);
    const [item] = await chrome.downloads.search({ id });
    if (!item) throw new Error('下载记录已被移除。');
    return downloadItem(item);
  }
  if (method === 'downloads.search') {
    const [item] = await chrome.downloads.search({ id });
    if (!item) throw new Error('下载记录已被移除。');
    return downloadItem(item);
  }
  if (method !== 'downloads.wait') throw new Error('未知下载操作。');
  const deadline = Date.now() + Math.min(300000, Math.max(1, Number(p.timeoutMs) || 30000));
  while (true) {
    check(); requireOwner(owner);
    const [item] = await chrome.downloads.search({ id }); check(); requireOwner(owner);
    if (!item) throw new Error('下载记录已被移除。');
    if (item.state !== 'in_progress') return downloadItem(item);
    if (Date.now() >= deadline) throw new Error(`等待下载 ${id} 超时，下载可能仍在进行；可继续等待同一编号，不能重新触发。`);
    await delay(100);
  }
}
function correlateDownloads() {
  for (const arm of downloadArms.values()) {
    if (!arm.began || arm.id) continue;
    for (const [id, item] of arm.candidates) if (![item.url, item.finalUrl].includes(arm.began.url)) arm.candidates.delete(id);
    if (arm.candidates.size > 1) arm.error = '多个下载具有同一地址，无法确认归属。';
  }
}
chrome.downloads?.onCreated.addListener(item => {
  let candidate = false;
  for (const arm of downloadArms.values()) {
    if (arm.sessionId !== sessionId || ownership !== 'agent' || arm.id || (arm.url && ![item.url, item.finalUrl].includes(arm.url))) continue;
    arm.candidates.set(item.id, item); candidate = true;
  }
  if (candidate) send({ type: 'cdp', sessionId, tabId: currentTab, method: 'downloads.candidateCreated', params: downloadItem(item) });
  correlateDownloads();
});
chrome.downloads?.onChanged.addListener(delta => {
  const owner = downloadOwners.get(delta.id);
  if (owner) send({ type: 'cdp', sessionId: owner, tabId: currentTab, method: 'downloads.onChanged', params: delta });
});
function desktopUi(method, params = {}) {
  if (!authenticated || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('请先连接 ProfilePilot 浏览器服务。'));
  const id = `ui-${++uiSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { uiPending.delete(id); reject(new Error('应用请求超时，请核查任务状态；不要重复提交。')); }, 20000);
    uiPending.set(id, { resolve, reject, timer }); send({ type: 'ui', id, method, params });
  });
}
async function pageContext(tabId) {
  const tab = tabId !== undefined ? await chrome.tabs.get(Number(tabId)) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab || tab.incognito || !usable(tab.url)) return undefined;
  let selection = '';
  try { selection = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.getSelection()?.toString() || '' }))[0]?.result || ''; } catch {}
  return { id: tab.id, tabId: tab.id, title: tab.title, url: tab.url, selection };
}
async function openSidePanel(tabId) {
  if (Number.isInteger(tabId)) return chrome.sidePanel.open({ tabId });
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('未找到当前 Chrome 窗口。');
  return chrome.sidePanel.open({ tabId: tab.id });
}
async function disconnect(forget = false) {
  ownership = 'user'; controlEpoch++; await detach();
  const old = socket; socket = undefined; authenticated = false; clearInterval(heartbeat); old?.close();
  if (forget) { config = undefined; sessionId = undefined; currentTab = undefined; allowedTabs.clear(); taskTabs.clear(); createdTabs.clear(); await chrome.storage.local.remove('connection'); await chrome.storage.session.remove(['selection', 'taskTabs']); }
  await publish();
}
async function connect() {
  if (connecting || !config || socket?.readyState === WebSocket.OPEN) return connecting;
  connecting = (async () => {
    authenticated = false; connectionError = '';
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/profilepilot`); socket = ws;
    ws.onopen = () => send({ type: 'hello', profileId: config.profileId, token: config.token });
    ws.onmessage = event => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'ui-result') {
        const pending = uiPending.get(message.id);
        if (pending) { uiPending.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
        return;
      }
      if (message.type === 'welcome') {
        authenticated = true;
        clearInterval(heartbeat); heartbeat = setInterval(() => send({ type: 'heartbeat' }), 20000);
        void publish(); return;
      }
      if (!Number.isInteger(message.id) || typeof message.method !== 'string') return;
      const expiresAt = Number.isFinite(message.expiresAt) ? message.expiresAt : Date.now() + 15000;
      if ((message.method === 'control' && ['handoff', 'complete', 'release'].includes(message.params?.action) && message.params?.sessionId === sessionId) || message.method === 'disconnect') { ownership = 'user'; controlEpoch++; }
      const epoch = controlEpoch;
      const check = () => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) throw new Error('扩展连接已改变，旧请求已取消。');
        if (epoch !== controlEpoch) throw new Error('用户已停止或接管，排队操作已取消。');
        if (Date.now() >= expiresAt) throw new Error('请求已超时，未执行排队的浏览器操作。');
      };
      // An explicit takeover invalidates queued input before awaiting earlier work.
      const execute = async () => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        try { const result = await handle(message.method, message.params || {}, check); send({ id: message.id, result }); }
        catch (error) { send({ id: message.id, error: String(error.message || error) }); }
      };
      // Waiting for a file must not hold the action queue and block takeover,
      // cancel or independent downloads.
      if (message.method === 'downloads.wait') void execute();
      else commandQueue = commandQueue.then(execute);
    };
    ws.onclose = event => {
      if (socket !== ws) return;
      authenticated = false;
      if (event.code === 4001) connectionError = '配对码已失效或连接已撤销，请断开配对后生成新码。';
      if (event.code === 4009) connectionError = '这个 Profile 已有扩展连接，请检查是否选错了 Chrome Profile。';
      socket = undefined; clearInterval(heartbeat); ownership = 'user'; controlEpoch++; void detach().then(publish);
      for (const pending of uiPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('浏览器服务连接中断，请检查任务是否已提交。')); }
      uiPending.clear();
    };
    ws.onerror = () => {};
    await new Promise(resolve => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', resolve, { once: true }); });
  })().finally(() => { connecting = undefined; });
  return connecting;
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== currentTab || !attached) return;
  if (method === 'Target.attachedToTarget' && params.sessionId) childSessions.add(params.sessionId);
  if (method === 'Target.detachedFromTarget' && params.sessionId) childSessions.delete(params.sessionId);
  if (method === 'Page.downloadWillBegin') {
    for (const arm of downloadArms.values()) if (arm.sessionId === sessionId && !arm.id && (!arm.frameId || arm.frameId === params.frameId) && (!arm.url || arm.url === params.url)) {
      if (arm.began && arm.began.guid !== params.guid) arm.error = '多次下载事件无法唯一关联，请使用明确下载地址。';
      arm.began = params;
    }
    correlateDownloads();
  }
  send({ type: 'cdp', sessionId, cdpSessionId: source.sessionId, tabId: source.tabId, method, params });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== currentTab || !attached) return;
  attached = false; preview = false; ownership = 'user'; controlEpoch++; pausedByBrowser = true; void publish();
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === currentTab && (change.url || change.title)) void publish();
  if (logoTabs.has(id) && (change.url || change.status === 'complete')) syncTabLogos(id);
});
chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  if (createdTabs.delete(removedId)) createdTabs.add(addedId);
  if (logoTabs.delete(removedId)) logoTabs.add(addedId);
  appliedLogos.delete(removedId);
  syncTabLogos(addedId);
  // Discarding/restoring can replace the tab's integer ID without changing the
  // browsing slot the user authorized. Track Chrome's explicit replacement.
  for (const saved of taskTabs.values()) {
    saved.tabs = saved.tabs.map(id => id === removedId ? addedId : id);
    if (saved.tabId === removedId) saved.tabId = addedId;
  }
  if (!allowedTabs.delete(removedId)) { void saveSelection(); return; }
  allowedTabs.add(addedId);
  if (currentTab !== removedId) return;
  currentTab = addedId; attached = false; preview = false;
  void saveSelection().then(publish);
});
chrome.tabs.onCreated.addListener(tab => { if (tab.openerTabId && allowedTabs.has(tab.openerTabId) && sessionId && ownership === 'agent' && !tab.incognito) { allowedTabs.add(tab.id); createdTabs.add(tab.id); syncTabLogos(tab.id); void saveSelection(); } });
chrome.tabs.onRemoved.addListener(id => {
  createdTabs.delete(id); logoTabs.delete(id); appliedLogos.delete(id);
  allowedTabs.delete(id);
  for (const saved of taskTabs.values()) { saved.tabs = saved.tabs.filter(other => other !== id); if (saved.tabId === id) saved.tabId = undefined; }
  if (id === currentTab) { attached = false; ownership = 'user'; controlEpoch++; pausedByBrowser = Boolean(sessionId); currentTab = undefined; }
  void saveSelection().then(publish);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.method === 'onboarding') {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || sender.tab.incognito || !/^http:\/\/127\.0\.0\.1:[0-9]+\/profilepilot-connect\/[a-f0-9]{48}$/.test(sender.url || '')) return;
    void (async () => {
      if (sessionId) throw new Error('当前 Profile 有任务尚未结束，请先结束任务后连接。');
      // Chrome omits Origin on extension GET requests with host permissions.
      // POST carries the extension Origin, which the desktop strictly checks.
      const response = await fetch(`${sender.url}/pair`, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error('连接请求已过期或已使用，请返回应用重新点击授权并连接。');
      const invitation = await response.json();
      const id = new URL(sender.url).pathname.split('/').pop();
      await chrome.storage.session.set({ [`onboarding:${id}`]: invitation });
      await chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL(`popup.html#setup=${id}`) });
      respond({ result: {} });
    })().catch(error => respond({ error: error.message }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || !['popup.html', 'sidepanel.html'].some(file => sender.url?.split('#')[0] === chrome.runtime.getURL(file))) return;
  // Stop at receipt, before a slow UI request or queued command can execute.
  if (message.method === 'takeover' || (message.method === 'taskControl' && ['stop', 'takeover'].includes(message.action))) { ownership = 'user'; controlEpoch++; void clearFocusEmulation(); void publish(); }
  void (async () => {
    if (message.method === 'state') return state();
    if (message.method === 'confirmPersistentInstallation') {
      if (message.confirmed !== true) throw new Error('请先确认已完成持久安装。');
      await chrome.storage.local.remove('profilepilotInstallation'); installationMode = undefined;
      await publish(); return state();
    }
    if (message.method === 'getPageContext') return pageContext(message.tabId);
    if (message.method === 'openSidePanel') { await openSidePanel(message.tabId); return {}; }
    if (message.method === 'getUiState') {
      let desktop = {};
      if (authenticated) { try { desktop = await desktopUi('getUiState', message.taskId ? { taskId: message.taskId } : {}); } catch (error) { desktop = { taskError: error.message }; } }
      return { ...await state(), ...desktop, currentTab: await pageContext(), access };
    }
    if (message.method === 'setAccess') {
      const normalize = values => {
        if (!Array.isArray(values) || values.length > 1000) throw new Error('站点设置无效。');
        return [...new Set(values.map(value => { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('站点设置需要 HTTP/HTTPS 地址。'); return url.origin; }))];
      };
      const next = { blockedOrigins: normalize(message.blockedOrigins || []), allowedOrigins: normalize(message.allowedOrigins || []), confirmActions: message.confirmActions === true };
      if (authenticated) await desktopUi('setAccess', next);
      access = next; await chrome.storage.local.set({ nativeAccess: access });
      if (currentTab) { try { assertSite((await chrome.tabs.get(currentTab)).url); } catch { ownership = 'user'; controlEpoch++; await detach(); } }
      await publish(); return { access };
    }
    if (['startTask', 'taskMessage', 'taskControl', 'taskReply'].includes(message.method)) {
      const { method, ...params } = message;
      if (method === 'startTask' && params.tabId === undefined && !params.newTab) params.tabId = (await pageContext())?.id;
      return desktopUi(method, params);
    }
    if (message.method === 'connect') {
      if (sessionId) throw new Error('请先结束现有任务，再重新配对。');
      const code = String(message.code || '');
      if (!code.startsWith('PP1.') || code.length > 2000) throw new Error('配对码无效。');
      const value = JSON.parse(atob(code.slice(4).replace(/-/g, '+').replace(/_/g, '/')));
      if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^native:[^/\\]{1,100}$/.test(value.profileId) || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('配对码无效。');
      await disconnect(); config = value; currentTab = undefined; pausedByBrowser = false;
      allowedTabs.clear(); taskTabs.clear(); createdTabs.clear(); syncTabLogos();
      await chrome.storage.local.set({ connection: config }); await saveSelection();
      await connect(); return state();
    }
    if (message.method === 'selectTab') {
      if (!config) throw new Error('请先配对 ProfilePilot。');
      const epoch = controlEpoch, expectedSession = sessionId, expectedOwnership = ownership, connection = config;
      const check = () => {
        if (epoch !== controlEpoch || sessionId !== expectedSession || ownership !== expectedOwnership || config !== connection) throw new Error('浏览器控制状态已改变，标签切换已取消。');
      };
      // Serialize UI navigation with Agent actions, rather than only waiting
      // for the old queue and letting a later command overtake this selection.
      const selecting = commandQueue.then(async () => {
        check();
        if (message.newTab === true) await createAndSelectTab('about:blank', check);
        else await select(Number(message.tabId), check);
        check(); return state();
      });
      commandQueue = selecting.catch(() => {});
      return selecting;
    }
    if (message.method === 'reconnect') { await connect(); return state(); }
    if (message.method === 'takeover') { ownership = 'user'; await publish(); return state(); }
    if (message.method === 'return') {
      if (!sessionId) throw new Error('当前没有待继续的任务。');
      const expectedSession = sessionId, generation = controlGeneration();
      const check = () => {
        if (sessionId !== expectedSession || generation !== controlGeneration()) throw new Error('用户已停止或接管，排队恢复已取消。');
      };
      await prepareTask(expectedSession, check); check();
      pausedByBrowser = false; await saveSelection(); check();
      await attachForTask(check); check();
      ownership = 'agent'; await publish(); return state();
    }
    if (message.method === 'disconnect') { await disconnect(true); return state(); }
    throw new Error('未知操作。');
  })().then(result => respond({ result }), error => respond({ error: String(error.message || error) }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') void connect(); });
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.profilepilotInstallation) {
    installationMode = changes.profilepilotInstallation.newValue?.mode;
    void publish();
  }
});
const onboardingUrl = url => /^http:\/\/127\.0\.0\.1:[0-9]+\/profilepilot-connect\/[a-f0-9]{48}$/.test(url || '');
async function installed() {
  if (chrome.contextMenus) {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({ id: 'profilepilot-page', title: '在 ProfilePilot 侧边栏处理此页', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'profilepilot-selection', title: '用 ProfilePilot 处理选中文字', contexts: ['selection'] });
  }
  // Existing tabs do not receive new declarative content scripts after an
  // unpacked install. Reinject only exact, local invitation URLs in this Profile.
  for (const tab of await chrome.tabs.query({})) if (!tab.incognito && onboardingUrl(tab.url)) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['onboarding.js'] }).catch(() => {});
  }
}
chrome.runtime.onInstalled?.addListener(() => { void installed(); });
chrome.runtime.onStartup?.addListener(() => { void installed(); void connect(); });
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (!tab?.id || tab.incognito || !usable(tab.url)) return;
  // Invoke open while Chrome still considers this a user gesture.
  const opening = openSidePanel(tab.id);
  void chrome.storage.session.set({ nativeTaskContext: { id: tab.id, tabId: tab.id, title: tab.title, url: tab.url, selection: info.selectionText || '', at: Date.now() } });
  void opening.catch(() => {});
});
// Chrome extension service workers do not support top-level await. Register all
// listeners synchronously, then restore only a previously paired connection.
void (async () => {
  await chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
  try { installationType = (await chrome.management?.getSelf())?.installType; } catch {}
  installationMode = (await chrome.storage.local.get('profilepilotInstallation')).profilepilotInstallation?.mode;
  const saved = (await chrome.storage.local.get('connection')).connection;
  const savedAccess = (await chrome.storage.local.get('nativeAccess')).nativeAccess;
  if (savedAccess && Array.isArray(savedAccess.blockedOrigins)) access = { ...access, ...savedAccess };
  const selection = (await chrome.storage.session.get('selection')).selection;
  const savedTasks = (await chrome.storage.session.get('taskTabs')).taskTabs;
  const savedLogos = (await chrome.storage.session.get('tabLogos')).tabLogos;
  if (saved) {
    config = saved;
    if (savedLogos?.profileId === config.profileId) {
      for (const id of savedLogos.created || []) if (Number.isSafeInteger(id)) createdTabs.add(id);
      for (const id of savedLogos.touched || []) if (Number.isSafeInteger(id)) logoTabs.add(id);
    }
    if (savedTasks?.profileId === config.profileId && Array.isArray(savedTasks.tasks)) {
      for (const [id, saved] of savedTasks.tasks) if (typeof id === 'string' && Array.isArray(saved?.tabs)) taskTabs.set(id, { tabId: saved.tabId, tabs: saved.tabs.filter(Number.isSafeInteger) });
    }
    // Legacy selection alone is never permission to navigate a user's page.
    // A suspended worker restores a task paused; a Chrome restart starts fresh.
    if (selection?.profileId === config.profileId && taskTabs.has(selection.sessionId)) {
      sessionId = selection.sessionId; pausedByBrowser = true;
      const saved = taskTabs.get(sessionId);
      for (const id of saved.tabs) allowedTabs.add(id);
      currentTab = saved.tabId;
    }
    syncTabLogos();
    await connect();
  }
})().catch(() => { connectionError = '连接配置读取失败，请重新配对。'; });
