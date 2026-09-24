// Uses Chrome's documented debugger transport. No ChatGPT runtime dependency.
let socket, config, currentTab, sessionId, ownership = 'user', attached = false, pausedByBrowser = false;
let heartbeat, preview = false, connecting, authenticated = false, connectionError = '', commandQueue = Promise.resolve();
const allowedTabs = new Set();
// Only tabs created for a task (or explicitly added during takeover) belong to
// that task. Session storage cannot survive Chrome restart and stale tab IDs.
const taskTabs = new Map();
const CDP_METHODS = new Set(['Runtime.evaluate', 'Runtime.releaseObject', 'Page.navigate', 'Page.getNavigationHistory', 'Page.navigateToHistoryEntry', 'Page.captureScreenshot', 'Page.handleJavaScriptDialog', 'DOM.setFileInputFiles', 'DOM.describeNode', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);
const PREVIEW_METHODS = new Set(['Page.enable', 'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck', 'Emulation.setFocusEmulationEnabled']);
const send = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
const usable = url => /^(https?:\/\/|about:blank$)/.test(url || '');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(operation, timeout, message) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function debuggerCommand(method, params = {}, previewOnly = false) {
  // A background tab may have no compositor frame. Visual reads are optional
  // and cannot cause uncertain input, so timing out must not revoke ownership.
  const visualOnly = previewOnly || method === 'Page.captureScreenshot';
  try {
    return await bounded(chrome.debugger.sendCommand({ tabId: currentTab }, method, params), visualOnly ? 2500 : 10000,
      `${previewOnly ? '实时画面' : visualOnly ? '截图' : method === 'Runtime.evaluate' ? '页面读取或操作' : '浏览器操作'}无响应，已停止等待。`);
  } catch (error) {
    // Stop the debugger before allowing another task command to run. In-flight
    // input may have taken effect; never replay it automatically after a timeout.
    if (!visualOnly) { ownership = 'user'; pausedByBrowser = true; await detach(); void publish(); }
    throw error;
  }
}
function requireOwner(expected) {
  if (!sessionId || sessionId !== expected) throw new Error('浏览器会话不匹配。');
  if (ownership !== 'agent') throw new Error('用户正在操作浏览器，请交还后继续。');
}
async function state() {
  const tab = currentTab ? await chrome.tabs.get(currentTab).catch(() => undefined) : undefined;
  return { connected: authenticated && socket?.readyState === WebSocket.OPEN, taskTabs: true, profileId: config?.profileId, tabId: currentTab, sessionId, ownership, tabTitle: tab?.title, url: tab?.url, pausedByBrowser, connectionError };
}
async function publish() {
  const value = await state(); send({ type: 'state', state: value });
  await chrome.action.setBadgeText({ text: !value.connected ? '' : ownership === 'agent' ? 'AI' : '你' });
  await chrome.action.setBadgeBackgroundColor({ color: ownership === 'agent' ? '#517843' : '#8e7546' });
}
async function attach(check = () => {}) {
  check();
  if (pausedByBrowser) throw new Error('浏览器调试已由你停止，请在 ProfilePilot 中点击继续任务。');
  if (!currentTab || !allowedTabs.has(currentTab)) throw new Error('请在扩展中选择一个允许操作的标签页。');
  let tab = await chrome.tabs.get(currentTab); check();
  if (!usable(tab.url)) throw new Error('此页面不允许自动化，请选择普通网页。');
  // Memory Saver leaves a valid tab ID and URL, but no renderer to answer CDP.
  // Restore only the tab explicitly authorized by the user. Activating it also
  // unfreezes a tab; do not reload live pages or change the user's window focus.
  if (tab.discarded || tab.frozen || tab.status === 'unloaded') {
    await chrome.tabs.update(currentTab, { active: true }); check();
    const deadline = Date.now() + 8000;
    do {
      tab = await chrome.tabs.get(currentTab); check();
      // Loading resources (ads, streaming connections, slow third-party scripts)
      // are not evidence that the renderer is still asleep. CDP can attach and
      // inspect a loading page; waiting for "complete" makes slow sites deadlock.
      if (!tab.discarded && !tab.frozen && tab.status !== 'unloaded') break;
      if (Date.now() >= deadline) throw new Error('任务标签页仍处于休眠状态，暂时无法连接。请打开该标签页后继续，任务记录已保留。');
      await delay(100); check();
    } while (true);
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
  try { await attach(check); }
  catch (error) {
    // A failed connection is not a user takeover. Keep it paused, and publish
    // the actual cause so the desktop doesn't ask the user to grant control again.
    ownership = 'user'; pausedByBrowser = true; await publish(); throw error;
  }
}
async function stopPreview() {
  if (!attached || !preview) { preview = false; return; }
  preview = false;
  await debuggerCommand('Page.stopScreencast', {}, true).catch(() => {});
  await debuggerCommand('Emulation.setFocusEmulationEnabled', { enabled: false }, true).catch(() => {});
}
async function detach() {
  // Detach itself stops screencasting. Waiting for a stuck Page command first
  // would prevent takeover/release from ever reaching Chrome.
  const tabId = currentTab; const wasAttached = attached; attached = false; preview = false;
  if (wasAttached) await bounded(chrome.debugger.detach({ tabId }), 1000, '停止浏览器调试超时。').catch(() => {});
}
async function select(tabId, check = () => {}) {
  if (!allowedTabs.has(tabId)) throw new Error('该标签页未授权给当前任务。');
  await detach(); check(); currentTab = tabId; await attach(check); await saveSelection(); await publish();
}
async function saveSelection() {
  if (sessionId) taskTabs.set(sessionId, { tabId: currentTab, tabs: [...allowedTabs] });
  await chrome.storage.session.set({ selection: { profileId: config?.profileId, tabId: currentTab, sessionId }, taskTabs: { profileId: config?.profileId, tasks: [...taskTabs] } });
}
async function prepareTask(id, check) {
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('无效的任务会话。');
  const saved = taskTabs.get(id);
  if (sessionId === id && currentTab && allowedTabs.has(currentTab)) {
    const tab = await chrome.tabs.get(currentTab).catch(() => undefined); check();
    if (tab && usable(tab.url) && !tab.incognito) return;
  }
  await detach(); check();
  currentTab = undefined; allowedTabs.clear();
  for (const tabId of saved?.tabs || []) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined); check();
    if (tab && usable(tab.url) && !tab.incognito) allowedTabs.add(tabId);
  }
  currentTab = allowedTabs.has(saved?.tabId) ? saved.tabId : [...allowedTabs][0];
  if (!currentTab) {
    // No opener: existing user tabs never become ancestors of task-owned tabs.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    try {
      check();
      if (!tab.id || tab.incognito) throw new Error('无法创建普通任务标签页。');
    } catch (error) { if (tab.id) await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
    currentTab = tab.id; allowedTabs.add(tab.id);
    taskTabs.set(id, { tabId: currentTab, tabs: [...allowedTabs] });
    await saveSelection(); check();
    // tabs.create may resolve with only pendingUrl. Wait for the newly created
    // page to commit before attach validates it; never inspect another user tab.
    const deadline = Date.now() + 4000;
    while (true) {
      const ready = await chrome.tabs.get(tab.id); check();
      if (usable(ready.url)) break;
      if (Date.now() >= deadline) throw new Error('新任务标签页尚未加载，请继续任务重试。');
      await delay(50); check();
    }
  }
  taskTabs.set(id, { tabId: currentTab, tabs: [...allowedTabs] });
}
async function handle(method, p, check = () => {}) {
  check();
  if (method === 'claim') {
    if (sessionId && sessionId !== p.sessionId) throw new Error('这个 Profile 已由另一个任务占用。');
    if (sessionId && ownership === 'user') throw new Error('用户正在操作浏览器，请交还后继续。');
    await prepareTask(p.sessionId, check); check();
    sessionId = p.sessionId; ownership = 'agent'; pausedByBrowser = false;
    await saveSelection(); check();
    await attachForTask(check);
    await publish(); return {};
  }
  if (method === 'control') {
    if (sessionId && sessionId !== p.sessionId) throw new Error('浏览器会话不匹配。');
    if (p.action === 'resume') { await prepareTask(p.sessionId, check); check(); sessionId = p.sessionId; pausedByBrowser = false; await saveSelection(); await attachForTask(check); check(); ownership = 'agent'; }
    else if (p.action === 'handoff') ownership = 'user';
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
    const window = await chrome.windows.get(tab.windowId); check(); requireOwner(p.sessionId);
    if (window.state === 'minimized') throw new Error('Chrome 窗口已最小化，请还原窗口后继续点击；本次点击未执行。');
    if (!tab.active) { await chrome.tabs.update(currentTab, { active: true }); check(); requireOwner(p.sessionId); }
    await attach(check); check(); requireOwner(p.sessionId);
    return {};
  }
  if (method === 'tabs') {
    const tabs = await Promise.all([...allowedTabs].map(id => chrome.tabs.get(id).catch(() => undefined)));
    return tabs.filter(Boolean).map(t => ({ id: String(t.id), title: t.title, url: t.url, current: t.id === currentTab }));
  }
  if (method === 'switch') { await select(Number(p.tabId), check); return {}; }
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
    await attach(check); check(); requireOwner(p.sessionId); return debuggerCommand('Page.navigate', { url: url.href });
  }
  if (method === 'cdp') {
    if (!CDP_METHODS.has(p.method)) throw new Error('此浏览器方法未开放给任务。');
    await attach(check); check(); requireOwner(p.sessionId); return debuggerCommand(p.method, p.params || {});
  }
  throw new Error('未知扩展操作。');
}
async function disconnect(forget = false) {
  ownership = 'user'; await detach();
  const old = socket; socket = undefined; authenticated = false; clearInterval(heartbeat); old?.close();
  if (forget) { config = undefined; sessionId = undefined; currentTab = undefined; allowedTabs.clear(); taskTabs.clear(); await chrome.storage.local.remove('connection'); await chrome.storage.session.remove(['selection', 'taskTabs']); }
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
      if (message.type === 'welcome') {
        authenticated = true;
        clearInterval(heartbeat); heartbeat = setInterval(() => send({ type: 'heartbeat' }), 20000);
        void publish(); return;
      }
      if (!Number.isInteger(message.id) || typeof message.method !== 'string') return;
      const expiresAt = Number.isFinite(message.expiresAt) ? message.expiresAt : Date.now() + 15000;
      const check = () => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) throw new Error('扩展连接已改变，旧请求已取消。');
        if (Date.now() >= expiresAt) throw new Error('请求已超时，未执行排队的浏览器操作。');
      };
      // An explicit takeover invalidates queued input before awaiting earlier work.
      if ((message.method === 'control' && ['handoff', 'complete', 'release'].includes(message.params?.action) && message.params?.sessionId === sessionId) || message.method === 'disconnect') ownership = 'user';
      commandQueue = commandQueue.then(async () => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        try { const result = await handle(message.method, message.params || {}, check); send({ id: message.id, result }); }
        catch (error) { send({ id: message.id, error: String(error.message || error) }); }
      });
    };
    ws.onclose = event => {
      if (socket !== ws) return;
      authenticated = false;
      if (event.code === 4001) connectionError = '配对码已失效或连接已撤销，请断开配对后生成新码。';
      if (event.code === 4009) connectionError = '这个 Profile 已有扩展连接，请检查是否选错了 Chrome Profile。';
      socket = undefined; clearInterval(heartbeat); ownership = 'user'; void detach().then(publish);
    };
    ws.onerror = () => {};
    await new Promise(resolve => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', resolve, { once: true }); });
  })().finally(() => { connecting = undefined; });
  return connecting;
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== currentTab || source.sessionId || !attached) return;
  if (['Page.screencastFrame', 'Page.screencastVisibilityChanged', 'Page.frameNavigated'].includes(method)) send({ type: 'cdp', method, params });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== currentTab || !attached) return;
  attached = false; preview = false; ownership = 'user'; pausedByBrowser = true; void publish();
});
chrome.tabs.onUpdated.addListener((id, change) => { if (id === currentTab && (change.url || change.title)) void publish(); });
chrome.tabs.onReplaced.addListener((addedId, removedId) => {
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
chrome.tabs.onCreated.addListener(tab => { if (tab.openerTabId && allowedTabs.has(tab.openerTabId) && sessionId && ownership === 'agent' && !tab.incognito) { allowedTabs.add(tab.id); void saveSelection(); } });
chrome.tabs.onRemoved.addListener(id => {
  allowedTabs.delete(id);
  for (const saved of taskTabs.values()) { saved.tabs = saved.tabs.filter(other => other !== id); if (saved.tabId === id) saved.tabId = undefined; }
  if (id === currentTab) { attached = false; ownership = 'user'; pausedByBrowser = Boolean(sessionId); currentTab = undefined; }
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
  if (sender.id !== chrome.runtime.id || sender.url?.split('#')[0] !== chrome.runtime.getURL('popup.html')) return;
  void (async () => {
    if (message.method === 'state') return state();
    if (message.method === 'connect') {
      if (sessionId) throw new Error('请先结束现有任务，再重新配对。');
      const code = String(message.code || '');
      if (!code.startsWith('PP1.') || code.length > 2000) throw new Error('配对码无效。');
      const value = JSON.parse(atob(code.slice(4).replace(/-/g, '+').replace(/_/g, '/')));
      if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^native:[^/\\]{1,100}$/.test(value.profileId) || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('配对码无效。');
      await disconnect(); config = value; currentTab = undefined; pausedByBrowser = false;
      allowedTabs.clear(); taskTabs.clear();
      await chrome.storage.local.set({ connection: config }); await saveSelection();
      await connect(); return state();
    }
    if (message.method === 'selectTab') {
      if (!config) throw new Error('请先配对 ProfilePilot。');
      if (!sessionId) throw new Error('新任务会自动新建标签页；只有接管当前任务时才需要选择已有页面。');
      if (ownership === 'agent') throw new Error('请先点击“我来操作”，再更换授权标签页。');
      await commandQueue;
      const tab = await chrome.tabs.get(Number(message.tabId));
      if (!usable(tab.url) || tab.incognito) throw new Error('请选择普通网页标签页。');
      await detach(); currentTab = tab.id; pausedByBrowser = false; allowedTabs.clear(); allowedTabs.add(tab.id);
      await saveSelection(); await publish(); return state();
    }
    if (message.method === 'reconnect') { await connect(); return state(); }
    if (message.method === 'takeover') { ownership = 'user'; await publish(); return state(); }
    if (message.method === 'return') { if (!sessionId) throw new Error('当前没有待继续的任务。'); await prepareTask(sessionId, () => {}); pausedByBrowser = false; await saveSelection(); await attachForTask(); ownership = 'agent'; await publish(); return state(); }
    if (message.method === 'disconnect') { await disconnect(true); return state(); }
    throw new Error('未知操作。');
  })().then(result => respond({ result }), error => respond({ error: String(error.message || error) }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') void connect(); });
// Chrome extension service workers do not support top-level await. Register all
// listeners synchronously, then restore only a previously paired connection.
void (async () => {
  await chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
  const saved = (await chrome.storage.local.get('connection')).connection;
  const selection = (await chrome.storage.session.get('selection')).selection;
  const savedTasks = (await chrome.storage.session.get('taskTabs')).taskTabs;
  if (saved) {
    config = saved;
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
    await connect();
  }
})().catch(() => { connectionError = '连接配置读取失败，请重新配对。'; });
