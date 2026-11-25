// Uses Chrome's documented debugger transport. No ChatGPT runtime dependency.
let socket, config, currentTab, sessionId, ownership = 'user', attached = false, pausedByBrowser = false;
let heartbeat, preview = false, connecting, authenticated = false, connectionError = '', commandQueue = Promise.resolve(), claimQueue = Promise.resolve();
let controlEpoch = 0, globalControlEpoch = 0;
let reconnectTimer, reconnectAttempt = 0, detachGraceTimer;
const RECONNECT_BASE_MS = 500, RECONNECT_MAX_MS = 5000, DETACH_GRACE_MS = 15000;
function clearReconnectSchedule() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; } }
function clearDetachGrace() { if (detachGraceTimer) { clearTimeout(detachGraceTimer); detachGraceTimer = undefined; } }
const connectionDiagnostics = globalThis.ProfilePilotConnectionDiagnostics;
let connectionStartedAt = 0, lastConnectionCheckpoint = 0, lastServerMessageAt = 0;
const connectionLog = (event, details = {}) => { void connectionDiagnostics?.record(event, details); };
async function publishConnectionDiagnostics() {
  if (!connectionDiagnostics || !authenticated) return;
  const report = await connectionDiagnostics.report();
  if (authenticated) send({ type: 'connectionDiagnostics', events: report.events });
}
// A technical interruption is not a user takeover. Keep its cause until an
// explicit resume succeeds or the user actually takes control.
let controlIssue;
// Browser-level CDP is held by the local service, while this extension remains
// the authority for the task/tab and user takeover. Never run both debuggers.
let extensionUi;
function clearExtensionUi(s = primarySession) { if (s.extensionUi) clearTimeout(s.extensionUi.timer); s.extensionUi = undefined; }
function renewExtensionUi(s = primarySession) {
  clearTimeout(s.extensionUi.timer);
  s.extensionUi.timer = setTimeout(() => {
    clearExtensionUi(s); s.ownership = 'user'; s.controlEpoch++; groupState('paused', s.sessionId); void detach(s).then(publish);
  }, 12000);
  s.extensionUi.timer?.unref?.();
}
// A content-script lease is narrower than debugger permission: only an active
// task's top document may temporarily suspend foreign extension iframes.
const frameGuards = new Map();
let frameGuardAttachPermit;
let debuggerRecovery, debuggerRecoverySerial = 0, debuggerRecoveryBudget, debuggerDiagnostic;
function reportDebugger(reason, phase, attempts = 0, code, s = primarySession) {
  s.debuggerDiagnostic = { id: crypto.randomUUID(), at: new Date().toISOString(),
    reason: ['target_closed', 'canceled_by_user'].includes(reason) ? reason : 'unknown', phase, attempts, ...(code ? { code } : {}) };
  send({ type: 'debuggerDiagnostic', sessionId: s.sessionId, diagnostic: s.debuggerDiagnostic });
}
function frameGuardPermission(message, sender) {
  if (!authenticated || socket?.readyState !== WebSocket.OPEN) return { allowed: false };
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || sender.tab.incognito ||
      !/^https?:\/\//.test(sender.url || '') || typeof message.token !== 'string' || message.token.length > 80) return { allowed: false };
  const s = allActiveSessions().find(entry => entry.currentTab === sender.tab.id && entry.allowedTabs.has(sender.tab.id));
  if (!s || s.extensionUi || !s.sessionId || s.pausedByBrowser) return { allowed: false };
  try { assertSite(sender.url); } catch { return { allowed: false }; }
  const generation = s.controlGeneration();
  if (s.ownership !== 'agent' && s.frameGuardAttachPermit !== generation) return { allowed: false };
  const documentKey = sender.documentId || `${sender.tab.id}:0`;
  const previous = frameGuards.get(documentKey);
  if (message.action === 'renew') return { allowed: previous?.token === message.token && previous.generation === generation };
  if (message.action !== 'acquire') return { allowed: false };
  frameGuards.set(documentKey, { token: message.token, tabId: sender.tab.id, documentId: sender.documentId, generation, sessionId: s.sessionId });
  return { allowed: true };
}
async function releaseFrameGuards(s) {
  if (s) s.frameGuardAttachPermit = undefined; else frameGuardAttachPermit = undefined;
  const guards = [];
  for (const [key, guard] of [...frameGuards]) {
    if (!s || guard.sessionId === s.sessionId || guard.tabId === s.currentTab) {
      guards.push(guard);
      frameGuards.delete(key);
    }
  }
  await Promise.all(guards.map(guard => bounded(Promise.resolve().then(() => chrome.tabs.sendMessage?.(guard.tabId,
    { method: 'frameGuard.release', token: guard.token }, guard.documentId ? { documentId: guard.documentId } : { frameId: 0 })),
    1000, '恢复扩展浮层超时。').catch(() => {})));
}
async function prepareFrameGuard(check, strict = false, s = primarySession) {
  if (!chrome.scripting?.executeScript || !s.sessionId || (s.ownership !== 'agent' && s.frameGuardAttachPermit !== s.controlGeneration())) return;
  // The static document-start script handles navigation. This injection also
  // covers pages opened before installation or before this task was claimed.
  const result = await bounded(chrome.scripting.executeScript({ target: { tabId: s.currentTab, frameIds: [0] },
    files: ['frame-guard.js'], injectImmediately: true }), 3000, '扩展浮层兼容处理超时。').catch(error => {
      if (strict) throw Object.assign(new Error(`扩展浮层预检查失败：${String(error.message || error)}`), { code: 'NATIVE_FRAME_GUARD_UNAVAILABLE' });
      return undefined;
    });
  check();
  return result;
}
function debuggerFailure(error) {
  if (error?.code?.startsWith('NATIVE_')) return error;
  const detail = String(error?.message || error);
  let code = 'NATIVE_DEBUGGER_UNAVAILABLE', message = `Chrome 调试连接不可用：${detail}`;
  if (/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(detail)) {
    code = 'NATIVE_EXTENSION_FRAME_CONFLICT';
    message = 'Chrome 阻止调试含有其他扩展内容的页面。已尝试临时移开可识别的扩展浮层；剩余冲突无法自动处理，请检查该页的扩展界面。反复交还控制不会消除这个限制。原始原因：' + detail;
  } else if (/Another debugger is already attached|Debugger is occupied/i.test(detail)) {
    code = 'NATIVE_DEBUGGER_BUSY';
    message = '当前标签页的调试连接被开发者工具或其他扩展占用。请结束占用后重试恢复。原始原因：' + detail;
  }
  return Object.assign(new Error(message), { code });
}
function rememberIssue(error, s = primarySession) {
  s.controlIssue = { code: error.code || 'NATIVE_DEBUGGER_UNAVAILABLE', message: String(error.message || error).slice(0, 1000) };
}
// A restarted worker must never accept a token issued by its predecessor.
let controlInstance = crypto.randomUUID();
const controlGeneration = () => `${controlInstance}:${controlEpoch}`;
let installationType;
let installationMode;
const allowedTabs = new Set();
const peerSessions = new Map(), borrowedUserTabs = new Set(), pendingDialogs = new Map();
const primarySession = {
  get sessionId() { return sessionId; }, set sessionId(v) { sessionId = v; },
  get currentTab() { return currentTab; }, set currentTab(v) { currentTab = v; },
  get allowedTabs() { return allowedTabs; },
  get ownership() { return ownership; }, set ownership(v) { ownership = v; },
  get attached() { return attached; }, set attached(v) { attached = v; },
  get pausedByBrowser() { return pausedByBrowser; }, set pausedByBrowser(v) { pausedByBrowser = v; },
  get controlEpoch() { return controlEpoch; }, set controlEpoch(v) { controlEpoch = v; },
  get controlInstance() { return controlInstance; }, set controlInstance(v) { controlInstance = v; },
  get controlIssue() { return controlIssue; }, set controlIssue(v) { controlIssue = v; },
  get preview() { return preview; }, set preview(v) { preview = v; },
  get extensionUi() { return extensionUi; }, set extensionUi(v) { extensionUi = v; },
  get childSessions() { return childSessions; },
  get debugFrameCapture() { return debugFrameCapture; }, set debugFrameCapture(v) { debugFrameCapture = v; },
  get debuggerRecovery() { return debuggerRecovery; }, set debuggerRecovery(v) { debuggerRecovery = v; },
  get debuggerRecoverySerial() { return debuggerRecoverySerial; }, set debuggerRecoverySerial(v) { debuggerRecoverySerial = v; },
  get debuggerRecoveryBudget() { return debuggerRecoveryBudget; }, set debuggerRecoveryBudget(v) { debuggerRecoveryBudget = v; },
  get debuggerDiagnostic() { return debuggerDiagnostic; }, set debuggerDiagnostic(v) { debuggerDiagnostic = v; },
  get frameGuardAttachPermit() { return frameGuardAttachPermit; }, set frameGuardAttachPermit(v) { frameGuardAttachPermit = v; },
  get commandQueue() { return commandQueue; }, set commandQueue(v) { commandQueue = v; },
  controlGeneration() { return `${controlInstance}:${controlEpoch}`; }
};
function createPeerSession(id) {
  const peer = {
    sessionId: id, currentTab: undefined, allowedTabs: new Set(), ownership: 'user',
    attached: false, pausedByBrowser: false, controlEpoch: 0, controlInstance: crypto.randomUUID(),
    controlIssue: undefined, preview: false, extensionUi: undefined, childSessions: new Map(),
    debugFrameCapture: false, debuggerRecovery: undefined, debuggerRecoverySerial: 0,
    debuggerRecoveryBudget: undefined, debuggerDiagnostic: undefined, frameGuardAttachPermit: undefined,
    commandQueue: Promise.resolve(),
    controlGeneration() { return `${peer.controlInstance}:${peer.controlEpoch}`; }
  };
  return peer;
}
function findSession(id) {
  if (!id) return undefined;
  if (id === sessionId) return primarySession;
  return peerSessions.get(id);
}
function allActiveSessions() {
  return [...(sessionId ? [primarySession] : []), ...peerSessions.values()];
}
function ownerSessionForTab(tabId, excludeSessionId) {
  if (!Number.isSafeInteger(tabId)) return undefined;
  return allActiveSessions().find(s => s.sessionId !== excludeSessionId && (s.currentTab === tabId || s.allowedTabs.has(tabId)));
}
function leadSession() {
  return sessionId ? primarySession : (peerSessions.values().next().value || primarySession);
}
// Only tabs created for a task (or explicitly added during takeover) belong to
// that task. Session storage cannot survive Chrome restart and stale tab IDs.
const taskTabs = new Map();
// Creation marks last for this Chrome session, including after a task finishes.
const createdTabs = new Set(), logoTabs = new Set(), logoUpdates = new Map();
const appliedLogos = new Map();
// Tasks retain their own states but share one native group per window. Chrome
// groups cannot span windows; never move or unpin a user's tab to show status.
const taskGroups = new Map();
let groupQueue = Promise.resolve();
const GROUP_STATES = {
  running: { color: 'blue', label: '执行中' }, waiting: { color: 'purple', label: '等待你处理' },
  paused: { color: 'orange', label: '已暂停' }, completed: { color: 'green', label: '已完成' },
  failed: { color: 'red', label: '执行异常' }, cancelled: { color: 'orange', label: '已取消' }
};
function groupState(phase, id = sessionId, title) {
  if (!id || !Object.hasOwn(GROUP_STATES, phase)) return;
  let record = taskGroups.get(id);
  if (!record) { record = { phase, title: '', groups: {}, enrolled: [] }; taskGroups.set(id, record); }
  record.phase = phase;
  if (typeof title === 'string') record.title = title.replace(/[\s\u0000-\u001f]+/g, ' ').trim().slice(0, 60);
}
function taskPhase(status) {
  return ({ running: 'running', queued: 'running', waiting_user: 'waiting', paused: 'paused',
    completed: 'completed', partial: 'paused', failed: 'failed', cancelled: 'cancelled' })[status];
}
function saveTaskGroups() {
  return chrome.storage.session.set({ taskGroups: { profileId: config?.profileId, tasks: [...taskGroups] } });
}
const GROUP_PRIORITY = ['failed', 'waiting', 'paused', 'running', 'cancelled', 'completed'];
const groupable = tab => tab && !tab.incognito && !tab.pinned && usable(tab.url) && Number.isInteger(tab.windowId);
function groupOwner(tab) {
  return [...taskGroups].find(([, record]) => record.groups[tab.windowId] === tab.groupId && record.enrolled.includes(tab.id));
}
function syncTaskGroups() {
  if (!chrome.tabs.group || !chrome.tabGroups?.update) return Promise.resolve();
  groupQueue = groupQueue.catch(() => {}).then(async () => {
    const connection = config;
    const currentConnection = () => config === connection;
    const windowGroups = new Map(), knownGroups = new Map();
    // Membership validates stored IDs. Never discover groups by their title:
    // a similarly named user group is not ours to merge or recolor.
    for (const [id, record] of taskGroups) {
      for (const [windowId, groupId] of Object.entries(record.groups)) {
        const group = await chrome.tabGroups.get(groupId).catch(() => null);
        const members = group ? await chrome.tabs.query({ groupId }).catch(() => []) : [];
        if (!currentConnection()) return;
        if (taskGroups.get(id) !== record) break;
        if (!group || group.shared || group.windowId !== Number(windowId) || !members.some(t => record.enrolled.includes(t.id))) {
          delete record.groups[windowId]; continue;
        }
        knownGroups.set(groupId, group);
        if (!windowGroups.has(group.windowId)) windowGroups.set(group.windowId, groupId);
      }
    }
    // Migrate previous per-task groups, moving only their tracked members.
    // Tabs dragged out by the user and unrelated tabs in those groups stay put.
    for (const [groupId, group] of knownGroups) {
      const target = windowGroups.get(group.windowId);
      if (target === groupId) continue;
      const members = await chrome.tabs.query({ groupId }).catch(() => []);
      if (!currentConnection()) return;
      const tabIds = members.filter(t => groupable(t) && groupOwner(t)).map(t => t.id);
      if (!tabIds.length) continue;
      try {
        await chrome.tabs.group({ groupId: target, tabIds });
        if (!currentConnection()) return;
        for (const record of taskGroups.values()) if (record.enrolled.some(id => tabIds.includes(id))) record.groups[group.windowId] = target;
      } catch { /* Closing or dragged tabs can be reconciled on the next sync. */ }
    }
    for (const [id, record] of taskGroups) {
      const current = () => currentConnection() && taskGroups.get(id) === record;
      // Only a live task may enroll new tabs; historical membership is visual
      // bookkeeping, never permission to control another task's pages.
      const activeEntry = findSession(id);
      const tabs = activeEntry ? [...activeEntry.allowedTabs] : [];
      for (const tabId of tabs) {
        if (!current() || record.enrolled.includes(tabId)) continue;
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!current() || !findSession(id)?.allowedTabs.has(tabId)) continue;
        if (!groupable(tab)) continue;
        let groupId = windowGroups.get(tab.windowId);
        const group = Number.isInteger(groupId) ? await chrome.tabGroups.get(groupId).catch(() => null) : null;
        if (!current() || !findSession(id)?.allowedTabs.has(tabId)) continue;
        // Validate membership as well as the ID before reusing a stored group.
        const members = group ? await chrome.tabs.query({ groupId }).catch(() => []) : [];
        if (!current() || !findSession(id)?.allowedTabs.has(tabId)) continue;
        if (!group || group.windowId !== tab.windowId || group.shared || !members.some(t => groupOwner(t))) groupId = undefined;
        try {
          if (groupId === undefined) {
            groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
            if (!current()) continue;
          } else if (tab.groupId !== groupId) await chrome.tabs.group({ groupId, tabIds: [tabId] });
          if (!current()) continue;
          windowGroups.set(tab.windowId, groupId);
          record.groups[tab.windowId] = groupId;
          record.enrolled.push(tabId);
          // A tab's displayed state belongs to its most recent task only.
          for (const [otherId, other] of taskGroups) if (otherId !== id) other.enrolled = other.enrolled.filter(t => t !== tabId);
        } catch { /* Pinned, closing or dragged tabs must not fail page actions. */ }
      }
    }
    // Chrome has one color per group. Count tabs by their own task state and
    // prefer the current task's color only in windows containing its members.
    const groupIds = new Set([...taskGroups.values()].flatMap(record => Object.values(record.groups)));
    for (const groupId of groupIds) {
      const group = await chrome.tabGroups.get(groupId).catch(() => null);
      const members = group ? await chrome.tabs.query({ groupId }).catch(() => []) : [];
      if (!currentConnection()) return;
      if (!group || group.shared) continue;
      const counts = new Map(); let activePhase;
      for (const tab of members) {
        const owner = groupOwner(tab);
        if (!owner) continue;
        const [id, record] = owner;
        counts.set(record.phase, (counts.get(record.phase) || 0) + 1);
        if (id === sessionId || (!activePhase && findSession(id))) activePhase = record.phase;
      }
      const phase = activePhase || GROUP_PRIORITY.find(value => counts.has(value));
      if (!phase) continue;
      const order = [phase, ...GROUP_PRIORITY.filter(value => value !== phase && counts.has(value))];
      const title = `ProfilePilot · ${order.map(value => `${GROUP_STATES[value].label} ${counts.get(value)}`).join(' · ')}`;
      const color = GROUP_STATES[phase].color;
      if (group.color !== color || group.title !== title) await chrome.tabGroups.update(groupId, { color, title }).catch(() => {});
    }
    if (!currentConnection()) return;
    await saveTaskGroups();
  }).catch(() => {});
  return groupQueue;
}
const childSessions = new Map();
function forgetChildSession(id, map = childSessions) {
  for (const [child, entry] of map) if (entry.parentSessionId === id) forgetChildSession(child, map);
  map.delete(id);
}
function staleFrameSession() {
  return Object.assign(new Error('子 frame 调试会话已失效；请重新发现当前标签页的 frame 并重新观察，不要重放输入。'), { code: 'NATIVE_FRAME_SESSION_STALE' });
}
let debugFrameCapture = false;
// Protocol follow-ups must run while a page command awaits a network response.
// Never allow Runtime.evaluate/Input/DOM mutations to bypass the action queue.
const debugFollowups = new Set(['Network.enable','Network.disable','Network.getResponseBody','Runtime.enable','Runtime.runIfWaitingForDebugger','Log.enable','Performance.enable','Target.setAutoAttach','Fetch.enable','Fetch.disable','Fetch.continueRequest','Fetch.fulfillRequest','Fetch.failRequest','Tracing.start','Tracing.end']);
let access = { blockedOrigins: [], confirmActions: false }, uiSequence = 0;
const uiPending = new Map();
let previewCapture;
const inputFrames = new Map();
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
// Hidden headful Chrome can defer input ACKs and mousemove/rAF delivery for
// five seconds until it draws another frame. Request that frame alongside the
// real input, as the Gateway does. Capture the root surface (including OOPIFs)
// without clipping/resizing it, activating a tab, or emulating focus.
function requestInputFrame(tabId, s = primarySession) {
  const owner = s.sessionId, epoch = s.controlEpoch, recovery = s.debuggerRecoverySerial;
  const current = () => s.attached && s.ownership === 'agent' && !s.pausedByBrowser && !s.extensionUi &&
    s.currentTab === tabId && s.sessionId === owner && s.controlEpoch === epoch && s.debuggerRecoverySerial === recovery;
  if (!owner || !current()) return;
  const existing = inputFrames.get(tabId);
  if (existing?.owner === owner && existing.epoch === epoch && existing.recovery === recovery) {
    existing.again = true; return;
  }
  const frame = { owner, epoch, recovery, again: true };
  inputFrames.set(tabId, frame);
  void (async () => {
    try {
      while (frame.again && current() && inputFrames.get(tabId) === frame) {
        frame.again = false;
        const started = Date.now();
        await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'jpeg', quality: 1, fromSurface: true, captureBeyondViewport: false
        });
        if (Date.now() - started >= 1000) break;
      }
    } catch {
    } finally {
      if (inputFrames.get(tabId) === frame) inputFrames.delete(tabId);
    }
  })();
}
async function debuggerCommand(method, params = {}, previewOnly = false, cdpSessionId, s = primarySession) {
  // A background tab may have no compositor frame. Visual reads are optional
  // and cannot cause uncertain input, so timing out must not revoke ownership.
  const visualOnly = previewOnly || method === 'Page.captureScreenshot';
  const recoverySerial = s.debuggerRecoverySerial;
  const owner = s.sessionId, epoch = s.controlEpoch, commandTab = s.currentTab;
  try {
    const tabId = s.currentTab;
    const operation = chrome.debugger.sendCommand({ tabId, ...(cdpSessionId ? { sessionId: cdpSessionId } : {}) }, method, params);
    if (!previewOnly && /^Input\.(dispatch(?:Mouse|Key|Touch)Event|insertText|imeSetComposition)$/.test(method)) requestInputFrame(tabId, s);
    return await bounded(operation, visualOnly ? 2500 : 10000,
      `${previewOnly ? '实时画面' : visualOnly ? '截图' : method === 'Runtime.evaluate' ? '页面读取或操作' : '浏览器操作'}无响应，已停止等待。`);
  } catch (error) {
    if (cdpSessionId && /Session with given id not found|No session with given id/i.test(String(error.message))) {
      forgetChildSession(cdpSessionId, s.childSessions);
      throw staleFrameSession();
    }
    if (/Detached while handling command|Debugger is not attached|Session with given id not found/i.test(String(error.message))) {
      // The browser's detach event can arrive just after the command rejection.
      for (let turn = 0; turn < 5 && !s.debuggerRecovery && recoverySerial === s.debuggerRecoverySerial && s.ownership === 'agent'; turn++) await delay(20);
      if ((s.debuggerRecovery && await s.debuggerRecovery.promise) || recoverySerial !== s.debuggerRecoverySerial) {
        throw Object.assign(new Error('页面调试连接已自动恢复。上一操作可能已执行，请重新观察页面核查结果，不要重放输入或提交。'), { code: 'NATIVE_DEBUGGER_RECOVERED' });
      }
    }
    if (!visualOnly && String(error.message).includes('无响应')) {
      const retained = s.sessionId === owner && s.controlEpoch === epoch && s.currentTab === commandTab && s.ownership === 'agent' && !s.pausedByBrowser;
      error = Object.assign(new Error(`${error.message}（${method}）操作结果尚未确认，请重新观察核查结果，勿重放操作。`),
        { code: retained ? 'NATIVE_COMMAND_TIMEOUT' : 'NATIVE_TIMEOUT_UNCERTAIN' });
      if (retained) { s.controlEpoch++; await detach(s); await publish(); }
    }
    throw error;
  }
}
function requireOwner(expected) {
  const s = findSession(expected);
  if (!s || s.sessionId !== expected) throw new Error('浏览器会话不匹配。');
  if (s.ownership !== 'agent') {
    if (s.controlIssue) throw Object.assign(new Error(s.controlIssue.message), { code: s.controlIssue.code });
    throw new Error('用户正在操作浏览器，请交还后继续。');
  }
  return s;
}
async function state() {
  const lead = leadSession();
  const tab = lead.currentTab ? await chrome.tabs.get(lead.currentTab).catch(() => undefined) : undefined;
  let activeTabUrl;
  if (chrome.tabs.query) {
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    const activeTab = Array.isArray(activeTabs) ? activeTabs[0] : undefined;
    if (activeTab && !activeTab.incognito && usable(activeTab.url)) activeTabUrl = activeTab.url;
  }
  const sessionList = await Promise.all(allActiveSessions().map(async s => {
    const sTab = s.currentTab === lead.currentTab ? tab : (s.currentTab ? await chrome.tabs.get(s.currentTab).catch(() => undefined) : undefined);
    return {
      sessionId: s.sessionId,
      tabId: s.currentTab,
      tabs: [...s.allowedTabs],
      ownership: s.ownership,
      pausedByBrowser: s.pausedByBrowser,
      controlGeneration: s.controlGeneration(),
      controlIssue: s.controlIssue,
      dialogPending: s.currentTab ? pendingDialogs.get(s.currentTab) : undefined,
      tabTitle: sTab?.title,
      url: sTab?.url
    };
  }));
  return {
    connected: authenticated && socket?.readyState === WebSocket.OPEN,
    extensionUi: allActiveSessions().some(s => Boolean(s.extensionUi)) || Boolean(extensionUi),
    taskTabs: true,
    controlGeneration: lead.controlGeneration(),
    extensionVersion: chrome.runtime.getManifest?.().version || '0.2.0',
    installationType,
    installationMode,
    installation: { type: installationType, mode: installationMode, temporary: installationMode === 'temporary' },
    capabilities: ['debugCapture', 'extensionUi', 'liveView', 'tabs', 'cdp', 'cdpSessions', 'frameSessionSnapshot', 'history', 'downloads', 'sidePanel', 'taskGroups', 'cookies', 'dialogs', 'multiSession'],
    profileId: config?.profileId,
    tabId: lead.currentTab,
    sessionId: lead.sessionId,
    ownership: lead.ownership,
    tabTitle: tab?.title,
    url: tab?.url,
    activeTabUrl,
    dialogPending: lead.currentTab ? pendingDialogs.get(lead.currentTab) : undefined,
    sessions: sessionList,
    pausedByBrowser: lead.pausedByBrowser,
    controlIssue: lead.controlIssue,
    debuggerDiagnostic: lead.debuggerDiagnostic,
    connectionError,
    access
  };
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
  void syncTaskGroups();
  const value = await state(); send({ type: 'state', state: value });
  const anyAgent = allActiveSessions().some(s => s.ownership === 'agent' && !s.pausedByBrowser);
  await chrome.action.setBadgeText({ text: !value.connected ? '' : anyAgent ? 'AI' : '你' });
  await chrome.action.setBadgeBackgroundColor({ color: anyAgent ? '#517843' : '#8e7546' });
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
  // Migration only: restore icons injected by older versions. New tasks use
  // native groups and never replace a website's favicon or title.
  void saveTabLogos().catch(() => {});
  for (const id of logoTabs) {
    const next = (logoUpdates.get(id) || Promise.resolve()).then(async () => {
      const tab = await chrome.tabs.get(id).catch(() => undefined);
      if (!tab || tab.incognito || !/^https?:\/\//.test(tab.url || '') || tab.discarded || tab.frozen || tab.status === 'unloaded') return;
      const marked = false;
      const stamp = `${marked}:${tab.url}`;
      if (id !== forceTab && appliedLogos.get(id) === stamp) return;
      await chrome.scripting.executeScript({ target: { tabId: id }, func: updatePageTabLogo, args: [marked ? chrome.runtime.getURL('icons/icon-32.png') : null] });
      appliedLogos.set(id, stamp);
    }).catch(() => {}); // Restricted pages or closing tabs must not stop a task.
    logoUpdates.set(id, next);
    void next.finally(() => { if (logoUpdates.get(id) === next) logoUpdates.delete(id); });
  }
}
function markBorrowedTabIfUserOwned(tab) {
  if (!tab || !Number.isSafeInteger(tab.id) || createdTabs.has(tab.id)) return;
  const inUserGroup = Number.isInteger(tab.groupId) && tab.groupId >= 0 && !groupOwner(tab);
  if (!inUserGroup) borrowedUserTabs.add(tab.id);
}
async function ungroupBorrowedTabs(tabIds, endedSessionId) {
  for (const tabId of tabIds) {
    if (!borrowedUserTabs.has(tabId) || createdTabs.has(tabId) || ownerSessionForTab(tabId, endedSessionId)) continue;
    borrowedUserTabs.delete(tabId);
    if (typeof chrome.tabs.ungroup === 'function') {
      const record = taskGroups.get(endedSessionId);
      if (record) record.enrolled = record.enrolled.filter(id => id !== tabId);
      await chrome.tabs.ungroup(tabId).catch(() => {});
    }
  }
}
function normalizeCookieDomainFilter(domains) {
  if (!Array.isArray(domains) || !domains.length) return null;
  const list = domains.map(d => String(d || '').trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
  return list.length ? list : null;
}
async function exportCookies(p = {}) {
  if (!chrome.cookies?.getAll) throw new Error('当前浏览器不支持 cookies.export。');
  const all = await chrome.cookies.getAll({});
  const filters = normalizeCookieDomainFilter(p.domains);
  const cookies = !filters ? all : all.filter(c => {
    const host = String(c?.domain || '').trim().toLowerCase().replace(/^\.+/, '');
    return host && filters.some(f => host === f || host.endsWith('.' + f));
  });
  return { cookies };
}
async function importCookies(p = {}) {
  if (!chrome.cookies?.set) throw new Error('当前浏览器不支持 cookies.import。');
  if (!Array.isArray(p.cookies)) throw new Error('cookies.import 需要 cookies 数组。');
  let imported = 0, failed = 0;
  const errors = [];
  for (const cookie of p.cookies) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') { failed++; continue; }
    const rawDomain = String(cookie.domain || '').trim();
    const cleanHost = rawDomain.replace(/^\.+/, '');
    const isHostPrefix = cookie.name.startsWith('__Host-');
    const isSecurePrefix = cookie.name.startsWith('__Secure-');
    const secure = Boolean(cookie.secure) || isHostPrefix || isSecurePrefix;
    const cookiePath = isHostPrefix ? '/' : (cookie.path && String(cookie.path).startsWith('/') ? cookie.path : '/' + (cookie.path || ''));
    let url = typeof cookie.url === 'string' && /^https?:\/\//i.test(cookie.url) ? cookie.url : '';
    if (!url) {
      if (!cleanHost) { failed++; continue; }
      url = `${secure ? 'https' : 'http'}://${cleanHost}${cookiePath}`;
    }
    const details = { url, name: cookie.name, value: cookie.value, path: cookiePath, secure, httpOnly: Boolean(cookie.httpOnly) };
    const isHostOnly = isHostPrefix || cookie.hostOnly === true || (!rawDomain.startsWith('.') && cookie.hostOnly !== false);
    if (!isHostOnly && cleanHost) details.domain = rawDomain.startsWith('.') ? rawDomain : '.' + cleanHost;
    if (typeof cookie.sameSite === 'string') {
      const ss = cookie.sameSite.trim().toLowerCase();
      if (ss === 'none' || ss === 'no_restriction') details.sameSite = 'no_restriction';
      else if (ss === 'lax') details.sameSite = 'lax';
      else if (ss === 'strict') details.sameSite = 'strict';
      else if (ss === 'unspecified') details.sameSite = 'unspecified';
    }
    const exp = Number.isFinite(cookie.expirationDate) ? cookie.expirationDate : (Number.isFinite(cookie.expires) ? cookie.expires : undefined);
    if (!cookie.session && exp !== undefined && exp > 0) details.expirationDate = exp;
    if (typeof cookie.storeId === 'string' && cookie.storeId) details.storeId = cookie.storeId;
    if (cookie.partitionKey) {
      const topLevelSite = typeof cookie.partitionKey === 'string' ? cookie.partitionKey.trim() : String(cookie.partitionKey.topLevelSite || '').trim();
      if (topLevelSite) {
        details.partitionKey = { topLevelSite, ...(typeof cookie.partitionKey === 'object' && typeof cookie.partitionKey.hasCrossSiteAncestors === 'boolean' ? { hasCrossSiteAncestors: cookie.partitionKey.hasCrossSiteAncestors } : {}) };
      }
    }
    try {
      const saved = await chrome.cookies.set(details);
      if (saved) imported++; else failed++;
    } catch (error) {
      failed++;
      errors.push({ name: cookie.name, error: String(error?.message || error) });
    }
  }
  return { imported, failed, ...(errors.length ? { errors } : {}) };
}
async function attach(check = () => {}, duringRecovery = false, s = primarySession) {
  check();
  if (s.extensionUi) throw Object.assign(new Error('扩展界面模式已启用，请先 extension-ui disconnect 再操作网页。'), { code: 'NATIVE_EXTENSION_UI_ACTIVE' });
  if (!duringRecovery && s.debuggerRecovery) { await s.debuggerRecovery.promise; check(); }
  if (s.pausedByBrowser) {
    if (s.controlIssue) throw Object.assign(new Error(s.controlIssue.message), { code: s.controlIssue.code });
    throw new Error('浏览器调试已由你停止，请在 ProfilePilot 中点击继续任务。');
  }
  if (!s.currentTab || !s.allowedTabs.has(s.currentTab)) throw new Error('请在扩展中选择一个允许操作的标签页。');
  let tab = await chrome.tabs.get(s.currentTab); check();
  assertSite(tab.url);
  if (tab.discarded || tab.frozen || tab.status === 'unloaded') {
    throw new Error('标签页正在休眠；请显式打开该页恢复后继续，后台操作不会切换当前页面。');
  }
  const guardResult = /^https?:\/\//.test(tab.url) ? await prepareFrameGuard(check, duringRecovery, s) : undefined;
  if (s.attached) return;
  const target = { tabId: s.currentTab };
  let expired = false;
  const attaching = (async () => {
    try { await chrome.debugger.attach(target, '1.3'); }
    catch (error) {
      if (!/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(String(error.message)) ||
          !guardResult?.some(entry => entry.result?.active && entry.result.removed > 0 && Date.now() - entry.result.lastRemovedAt < 1500)) throw error;
      await delay(100); check();
      if (expired) throw error;
      await chrome.debugger.attach(target, '1.3');
    }
  })().then(() => {
    if (expired) { void chrome.debugger.detach(target).catch(() => {}); return; }
    s.attached = true;
  });
  try { await bounded(attaching, 4000, '无法连接授权标签页，请检查 Chrome 的调试提示后继续。'); check(); }
  catch (error) { expired = true; if (s.attached) await detach(s); throw debuggerFailure(error); }
}
async function attachForTask(check = () => {}, s = primarySession) {
  const generation = s.controlGeneration();
  s.frameGuardAttachPermit = generation;
  try { await attach(check, false, s); }
  catch (error) {
    if (generation !== s.controlGeneration()) throw error;
    error = debuggerFailure(error); rememberIssue(error, s);
    s.ownership = 'user'; s.controlEpoch++; s.pausedByBrowser = true; groupState('failed', s.sessionId); await releaseFrameGuards(s); await publish(); throw error;
  }
  finally { if (s.frameGuardAttachPermit === generation) s.frameGuardAttachPermit = undefined; }
}
async function stopPreview(s = primarySession) {
  if (!s.attached || !s.preview) { s.preview = false; return; }
  s.preview = false;
  await debuggerCommand('Page.stopScreencast', {}, true, undefined, s).catch(() => {});
  await debuggerCommand('Emulation.setFocusEmulationEnabled', { enabled: false }, true, undefined, s).catch(() => {});
}
async function clearFocusEmulation(s = primarySession) {
  if (!s.attached) return;
  await bounded(chrome.debugger.sendCommand({ tabId: s.currentTab }, 'Emulation.setFocusEmulationEnabled', { enabled: false }), 1000, '清理页面焦点模拟超时。').catch(() => {});
}
async function detach(s = primarySession) {
  clearExtensionUi(s);
  if (s.currentTab !== undefined) {
    inputFrames.delete(s.currentTab);
    pendingDialogs.delete(s.currentTab);
  }
  if (s.debuggerRecovery) s.debuggerRecovery.cancelled = true;
  const tabId = s.currentTab; const wasAttached = s.attached; s.attached = false; s.preview = false;
  s.childSessions.clear(); s.debugFrameCapture = false;
  if (wasAttached) await bounded(chrome.debugger.detach({ tabId }), 1000, '停止浏览器调试超时。').catch(() => {});
  await releaseFrameGuards(s);
}
async function select(tabId, check = () => {}, s = primarySession) {
  const expectedSession = s.sessionId, expectedOwnership = s.ownership, epoch = s.controlEpoch;
  const callerCheck = check;
  check = () => {
    callerCheck();
    if (s.sessionId !== expectedSession || s.ownership !== expectedOwnership || s.controlEpoch !== epoch) throw new Error('浏览器控制状态已改变，标签切换已取消。');
  };
  check();
  if (s.sessionId && ownerSessionForTab(tabId, s.sessionId)) {
    throw Object.assign(new Error(`标签页 ${tabId} 已由另一个任务占用。`), { code: 'NATIVE_SESSION_CONFLICT' });
  }
  const tab = await chrome.tabs.get(tabId); check();
  if (tab.incognito) throw new Error('请选择普通网页标签页。');
  assertSite(tab.url);
  if (tab.discarded || tab.frozen || tab.status === 'unloaded') throw new Error('目标标签页正在休眠，当前操作标签未切换；可在当前标签打开目标地址，或由用户恢复休眠标签页。');
  markBorrowedTabIfUserOwned(tab);
  const previousTab = s.currentTab, previousAllowed = [...s.allowedTabs], previousPaused = s.pausedByBrowser;
  await detach(s); check(); s.currentTab = tabId;
  if (!s.sessionId) s.allowedTabs.clear();
  s.allowedTabs.add(tabId);
  try {
    if (s.sessionId && s.ownership === 'agent') { await attach(check, false, s); check(); }
    await saveSelection(); check(); await publish(); check();
  }
  catch (error) {
    check();
    if (s.currentTab === tabId) {
      await detach(s); check(); s.currentTab = previousTab;
      s.allowedTabs.clear(); for (const id of previousAllowed) s.allowedTabs.add(id);
      s.pausedByBrowser = previousPaused;
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
    throw createdTabFailure(error, tab.id);
  }
}
async function createAndSelectTab(url, check, s = primarySession) {
  const tab = await createReadyTab(url, check);
  try { await select(tab.id, check, s); check(); return { tabId: tab.id }; }
  catch (error) { throw createdTabFailure(error, tab.id); }
}
async function saveSelection() {
  for (const s of allActiveSessions()) {
    if (s.sessionId) taskTabs.set(s.sessionId, { tabId: s.currentTab, tabs: [...s.allowedTabs] });
  }
  const lead = leadSession();
  await chrome.storage.session.set({ selection: { profileId: config?.profileId, tabId: lead.currentTab, sessionId: lead.sessionId }, taskTabs: { profileId: config?.profileId, tasks: [...taskTabs] } });
}
async function prepareTask(id, check, options = {}, s = primarySession) {
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('无效的任务会话。');
  const saved = taskTabs.get(id);
  const idleSelection = !s.sessionId && s === primarySession && currentTab && allowedTabs.has(currentTab) ? currentTab : undefined;
  if (!options.newTab && options.tabId === undefined && s.sessionId === id && s.currentTab && s.allowedTabs.has(s.currentTab)) {
    const tab = await chrome.tabs.get(s.currentTab).catch(() => undefined); check();
    if (tab && usable(tab.url) && !tab.incognito) return;
  }
  await detach(s); check();
  s.currentTab = undefined; s.allowedTabs.clear();
  for (const tabId of saved?.tabs || []) {
    if (ownerSessionForTab(tabId, id)) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined); check();
    if (tab && usable(tab.url) && !tab.incognito) {
      markBorrowedTabIfUserOwned(tab);
      s.allowedTabs.add(tabId);
    }
  }
  s.currentTab = options.newTab || options.preferNewTab ? undefined : s.allowedTabs.has(saved?.tabId) ? saved.tabId : [...s.allowedTabs][0];
  const wantsExistingTab = !options.newTab && !options.preferNewTab;
  if (options.tabId !== undefined) {
    const requestedId = Number(options.tabId);
    const conflict = ownerSessionForTab(requestedId, id);
    if (conflict) throw Object.assign(new Error(`标签页 ${requestedId} 已由另一个任务（${conflict.sessionId}）占用。`), { code: 'NATIVE_SESSION_CONFLICT' });
    const selected = await chrome.tabs.get(requestedId); check();
    if (selected.incognito) throw new Error('请选择普通网页标签页。');
    assertSite(selected.url);
    markBorrowedTabIfUserOwned(selected);
    s.currentTab = selected.id; s.allowedTabs.add(s.currentTab);
  } else if (!s.currentTab && !options.newTab && wantsExistingTab) {
    const tabs = await ordinaryTabs(); check();
    const active = chrome.tabs.query ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] : undefined;
    check();
    if ((options.activeTab === true || options.useCurrentTab === true) && active && ownerSessionForTab(active.id, id)) {
      throw Object.assign(new Error(`当前活动标签页（${active.id}）已由另一个任务占用。`), { code: 'NATIVE_SESSION_CONFLICT' });
    }
    const permitted = tab => {
      if (ownerSessionForTab(tab.id, id)) return false;
      try { assertSite(tab.url); return !tab.discarded && !tab.frozen && tab.status !== 'unloaded'; } catch { return false; }
    };
    const tab = tabs.find(t => t.id === idleSelection && permitted(t)) || tabs.find(t => t.id === active?.id && permitted(t)) || tabs.find(permitted);
    if (tab) {
      markBorrowedTabIfUserOwned(tab);
      s.currentTab = tab.id; s.allowedTabs.add(tab.id);
    }
  }
  if (!s.currentTab) {
    if (typeof chrome.tabs.create !== 'function') {
      throw Object.assign(new Error('当前没有空闲标签页，已有标签页已由另一个任务占用。'), { code: 'NATIVE_SESSION_CONFLICT' });
    }
    const tab = await createReadyTab('about:blank', check); check();
    s.currentTab = tab.id; s.allowedTabs.add(tab.id);
    taskTabs.set(id, { tabId: s.currentTab, tabs: [...s.allowedTabs] });
    await saveSelection(); check();
  }
  taskTabs.set(id, { tabId: s.currentTab, tabs: [...s.allowedTabs] });
}
async function handle(method, p, check = () => {}) {
  if (method === 'control' && p.action === 'resume') {
    const resumeTarget = findSession(p.sessionId) || leadSession();
    const transportCheck = check;
    check = () => {
      transportCheck();
      if (typeof p.controlGeneration !== 'string') throw new Error('请更新 ProfilePilot 应用以使用停止代次保护后再恢复任务。');
      if (p.controlGeneration !== resumeTarget.controlGeneration()) throw new Error('用户已停止或接管，排队恢复已取消。');
    };
    check.bindSession = transportCheck.bindSession;
  }
  check();
  if (method === 'extension.reload') {
    if (allActiveSessions().length) throw new Error('当前 Profile 仍有任务（包括已接管任务），请结束后更新扩展。');
    if (installationMode === 'temporary') throw new Error('当前为临时安装，Chrome 可能在重载后禁用扩展。请先完成持久安装，并在扩展中明确确认后再更新。');
    connectionLog('reload-requested');
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: true, version: chrome.runtime.getManifest?.().version || '0.2.0' };
  }
  if (method === 'cookies.export') return exportCookies(p);
  if (method === 'cookies.import') return importCookies(p);
  if (method === 'tabs' && !p.sessionId) {
    const leadTab = leadSession().currentTab;
    return (await ordinaryTabs()).map(t => ({ id: String(t.id), title: t.title, url: t.url, active: t.active, current: t.id === leadTab, discarded: Boolean(t.discarded), frozen: Boolean(t.frozen), status: t.status }));
  }
  if (method === 'liveView') {
    const tabs = (await bounded(chrome.tabs.query({ windowType: 'normal' }), 1000, '预览标签页查询超时。')).filter(t => !t.incognito && !String(t.url || '').startsWith('chrome-extension://'));
    const focused = await bounded(chrome.windows.getLastFocused(), 1000, '预览窗口查询超时。').catch(() => null);
    const tab = tabs.find(t => t.active && t.windowId === focused?.id) || tabs.filter(t => t.active).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    let screenshot = null, screenshotError = null;
    if (tab) {
      if (!/^https?:\/\//i.test(tab.url || '')) screenshotError = '此浏览器内部页面不支持预览。';
      else try {
        if (!previewCapture) {
          const capture = { tabId: tab.id, windowId: tab.windowId, url: tab.url,
            promise: chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 65 }) };
          previewCapture = capture;
          void capture.promise.finally(() => { if (previewCapture === capture) previewCapture = undefined; }).catch(() => {});
        }
        const capture = previewCapture;
        if (capture.tabId !== tab.id || capture.windowId !== tab.windowId || capture.url !== tab.url) throw new Error('上一帧仍在等待 Chrome，当前页面预览不可用。');
        screenshot = await bounded(capture.promise, 2500, '实时预览截图超时；文字读取与控制请求仍可使用。');
        const active = await bounded(chrome.tabs.query({ windowId: tab.windowId, active: true }), 1000, '无法核验预览标签页。');
        check();
        if (active[0]?.id !== tab.id || active[0]?.url !== tab.url) { screenshot = null; screenshotError = '页面已切换，正在等待下一帧。'; }
      } catch (error) {
        screenshot = null;
        const message = String(error?.message || error);
        screenshotError = /<all_urls>|activeTab|permission|access.*page/i.test(message)
          ? '扩展截图权限未生效，请在 chrome://extensions 重新加载 ProfilePilot 扩展并允许网站访问。'
          : /minimized|view.*not.*visible|image readback failed/i.test(message)
            ? '浏览器窗口暂时无法生成画面，恢复窗口后会自动重试。'
            : /超时|上一帧/.test(message) ? 'Chrome 尚未返回预览画面；标签页查询与控制不受此截图等待阻塞。'
            : '暂时无法抓取当前页面，正在自动重试。';
      }
    }
    return { port: 0, capturedAt: new Date().toISOString(), tabCount: tabs.length,
      tabs: tabs.map(t => ({ targetId: String(t.id), title: t.title || '', url: t.url || '', faviconUrl: null, primary: t.id === tab?.id })),
      primaryTitle: tab?.title || null, primaryUrl: tab?.url || null, screenshot, screenshotError, error: null };
  }
  if (method === 'history') {
    const anyUser = allActiveSessions().some(s => s.ownership !== 'agent');
    if (anyUser || (p.sessionId && !findSession(p.sessionId))) throw new Error('当前 Profile 已占用或用户正在操作浏览器。');
    const startTime = p.startTime === undefined ? 0 : Number(p.startTime), endTime = p.endTime === undefined ? Date.now() : Number(p.endTime);
    const maxResults = p.maxResults === undefined ? 100 : Number(p.maxResults);
    if (![startTime, endTime, maxResults].every(Number.isFinite) || startTime < 0 || endTime < startTime || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10000) throw new Error('历史搜索时间或数量无效。');
    return chrome.history.search({ text: String(p.query || ''), startTime, endTime, maxResults });
  }
  if (method === 'claim') {
    const existing = findSession(p.sessionId);
    if (existing && existing.ownership === 'user') requireOwner(p.sessionId);
    const userTaken = allActiveSessions().find(s => s.sessionId !== p.sessionId && (s.ownership === 'user' || s.pausedByBrowser));
    if (userTaken) throw Object.assign(new Error('这个 Profile 已由另一个任务占用。'), { code: 'NATIVE_SESSION_CONFLICT' });
    if (p.tabId !== undefined) {
      const conflict = ownerSessionForTab(Number(p.tabId), p.sessionId);
      if (conflict) throw Object.assign(new Error(`标签页 ${Number(p.tabId)} 已由另一个任务（${conflict.sessionId}）占用。`), { code: 'NATIVE_SESSION_CONFLICT' });
    } else if (!p.newTab && taskTabs.get(p.sessionId)?.tabId !== undefined) {
      const savedConflict = ownerSessionForTab(taskTabs.get(p.sessionId).tabId, p.sessionId);
      if (savedConflict) throw Object.assign(new Error(`标签页 ${taskTabs.get(p.sessionId).tabId} 已由另一个任务（${savedConflict.sessionId}）占用。`), { code: 'NATIVE_SESSION_CONFLICT' });
    }
    const usePrimary = !existing && !sessionId;
    const s = existing || (usePrimary ? primarySession : createPeerSession(p.sessionId));
    if (!existing && !usePrimary) peerSessions.set(p.sessionId, s);
    check.bindSession?.(s);
    try {
      await prepareTask(p.sessionId, check, p, s); check();
    } catch (error) {
      if (!existing && !usePrimary) peerSessions.delete(p.sessionId);
      throw error;
    }
    s.sessionId = p.sessionId; s.ownership = 'agent'; s.pausedByBrowser = false;
    groupState('running', s.sessionId, p.taskTitle);
    await saveSelection(); check();
    await attachForTask(check, s); s.controlIssue = undefined;
    await publish(); return {};
  }
  if (method === 'control') {
    let s = findSession(p.sessionId);
    const canRestoreIdle = p.action === 'resume' && (!sessionId || taskTabs.has(p.sessionId));
    if (!s && !['complete', 'release'].includes(p.action) && !canRestoreIdle) throw new Error('浏览器会话不匹配。');
    if (p.action === 'resume') {
      const userTaken = allActiveSessions().find(entry => entry.sessionId !== p.sessionId && (entry.ownership === 'user' || entry.pausedByBrowser));
      if (userTaken) throw Object.assign(new Error('这个 Profile 已由另一个任务占用。'), { code: 'NATIVE_SESSION_CONFLICT' });
      const createdPeer = !s && Boolean(sessionId);
      if (!s) {
        s = !sessionId ? primarySession : createPeerSession(p.sessionId);
        if (createdPeer) peerSessions.set(p.sessionId, s);
      }
      check.bindSession?.(s);
      try {
        await prepareTask(p.sessionId, check, {}, s); check();
      } catch (error) {
        if (createdPeer) peerSessions.delete(p.sessionId);
        throw error;
      }
      s.sessionId = p.sessionId; s.pausedByBrowser = false; await saveSelection();
      await attachForTask(check, s); check(); s.controlIssue = undefined; s.ownership = 'agent';
      groupState('running', s.sessionId, p.taskTitle);
    } else if (p.action === 'handoff') {
      s.ownership = 'user'; s.controlIssue = undefined;
      const prior = taskGroups.get(s.sessionId)?.phase;
      groupState(p.groupPhase === 'paused' || prior === 'paused' ? 'paused' : prior === 'failed' ? 'failed' : 'waiting', s.sessionId);
      await detach(s);
    } else if (['complete', 'release'].includes(p.action)) {
      const releaseTabs = s ? [...s.allowedTabs] : [...(taskTabs.get(p.sessionId)?.tabs || [])];
      if (s) s.ownership = 'user';
      const phase = p.groupPhase === 'waiting' && taskGroups.get(p.sessionId)?.phase === 'paused' ? 'paused' : p.groupPhase;
      if (s || taskGroups.has(p.sessionId)) groupState(p.action === 'release' ? 'cancelled' : ['failed', 'paused', 'waiting'].includes(phase) ? phase : 'completed', p.sessionId, p.taskTitle);
      await saveSelection();
      if (s) {
        if (s === primarySession) {
          sessionId = undefined; await detach(primarySession); currentTab = undefined; allowedTabs.clear(); pausedByBrowser = false; controlIssue = undefined;
        } else {
          await detach(s); peerSessions.delete(p.sessionId);
        }
      }
      await ungroupBorrowedTabs(releaseTabs, p.sessionId);
      await saveSelection();
    } else throw new Error('未知控制操作。');
    await publish(); return {};
  }
  if (method === 'taskState') {
    const s = findSession(p.sessionId);
    if (!s || p.controlGeneration !== s.controlGeneration() || !taskGroups.has(s.sessionId)) return { applied: false };
    const phase = taskPhase(p.status), record = taskGroups.get(s.sessionId);
    if (!phase) return { applied: false };
    if (s.ownership === 'agent' || (!['failed', 'paused', 'cancelled'].includes(record.phase) && phase !== 'running')) groupState(phase, s.sessionId, p.taskTitle);
    await syncTaskGroups(); return { applied: true };
  }
  if (method === 'disconnect') { await disconnect(true); return {}; }
  if (method === 'focus') {
    const s = p.sessionId ? findSession(p.sessionId) : leadSession();
    const targetTab = s?.currentTab;
    if (!targetTab) throw new Error('浏览器会话不匹配。');
    const tab = await chrome.tabs.update(targetTab, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return {};
  }
  if (method === 'preview') {
    const s = findSession(p.sessionId);
    if (!s) throw new Error('浏览器会话不匹配。');
    if (!PREVIEW_METHODS.has(p.method)) throw new Error('预览不支持此操作。');
    if (p.method === 'Page.stopScreencast') { await stopPreview(s); return {}; }
    await attach(check, false, s); check();
    if (p.method === 'Page.startScreencast') s.preview = true;
    return debuggerCommand(p.method, p.params || {}, true, undefined, s);
  }
  const s = requireOwner(p.sessionId);
  if (method === 'extensionUi.begin') {
    if (s.extensionUi) throw new Error('扩展界面模式已启用。');
    if (typeof p.token !== 'string' || !/^[a-f0-9]{64}$/.test(p.token)) throw new Error('扩展界面许可无效。');
    await detach(s); check(); requireOwner(p.sessionId);
    s.extensionUi = { token: p.token, generation: s.controlGeneration(), tabId: s.currentTab };
    renewExtensionUi(s);
    await releaseFrameGuards(s); check(); requireOwner(p.sessionId);
    return { tabId: s.currentTab, generation: s.controlGeneration() };
  }
  if (method === 'extensionUi.check' || method === 'extensionUi.end') {
    if (!s.extensionUi || s.extensionUi.token !== p.token || s.extensionUi.generation !== s.controlGeneration() || s.extensionUi.tabId !== s.currentTab) throw new Error('扩展界面许可已失效，请重新连接。');
    if (method === 'extensionUi.end') { clearExtensionUi(s); await publish(); return {}; }
    const tab = await chrome.tabs.get(s.currentTab); check(); requireOwner(p.sessionId); assertSite(tab.url);
    if (tab.incognito || tab.discarded || tab.frozen || tab.status === 'unloaded') throw new Error('授权标签页不可用。');
    const targets = await chrome.debugger.getTargets(); check(); requireOwner(p.sessionId);
    const matches = targets.filter(t => t.tabId === s.currentTab && t.type === 'page');
    if (matches.length !== 1) throw new Error('无法唯一识别授权标签页的调试目标。');
    renewExtensionUi(s);
    return { targetId: matches[0].id, tabId: s.currentTab, url: tab.url, generation: s.controlGeneration() };
  }
  if (s.extensionUi && method !== 'tabs') throw Object.assign(new Error('扩展界面模式已启用，请先 extension-ui disconnect 再操作网页。'), { code: 'NATIVE_EXTENSION_UI_ACTIVE' });
  if (method === 'preparePointer') {
    const tab = await chrome.tabs.get(s.currentTab); check(); requireOwner(p.sessionId);
    if (p.foreground === true && !tab.active) { await chrome.tabs.update(s.currentTab, { active: true }); check(); requireOwner(p.sessionId); }
    await attach(check, false, s); check(); requireOwner(p.sessionId);
    return {};
  }
  if (method === 'tabs') {
    const tabs = await (chrome.tabs.query ? ordinaryTabs() : Promise.all([...s.allowedTabs].map(id => chrome.tabs.get(id).catch(() => undefined))).then(list => list.filter(t => t && !t.incognito && usable(t.url))));
    return tabs.filter(Boolean).map(t => ({ id: String(t.id), title: t.title, url: t.url, current: t.id === s.currentTab, discarded: Boolean(t.discarded), frozen: Boolean(t.frozen), status: t.status }));
  }
  if (method === 'switch') { await select(Number(p.tabId), check, s); return {}; }
  if (method === 'newTab') {
    const url = p.url || 'about:blank'; assertSite(url);
    return createAndSelectTab(url, () => { check(); requireOwner(p.sessionId); }, s);
  }
  if (method === 'closeTab') {
    const id = Number(p.tabId); if (!s.allowedTabs.has(id)) throw new Error('该标签页未授权。');
    if (id === s.currentTab) {
      const closing = await chrome.tabs.get(id); check(); requireOwner(p.sessionId);
      const candidates = [...s.allowedTabs].filter(other => other !== id);
      if (s.allowedTabs.has(closing.openerTabId)) candidates.sort((a, b) => Number(b === closing.openerTabId) - Number(a === closing.openerTabId));
      for (const candidate of candidates) {
        const tab = await chrome.tabs.get(candidate).catch(() => undefined); check(); requireOwner(p.sessionId);
        if (!tab || !usable(tab.url) || tab.incognito) continue;
        await select(candidate, check, s); check(); requireOwner(p.sessionId); break;
      }
    }
    check(); requireOwner(p.sessionId);
    await chrome.tabs.remove(id); return {};
  }
  if (method === 'open') {
    const url = new URL(p.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持 HTTP/HTTPS 页面。');
    assertSite(url.href);
    await attach(check, false, s); check(); requireOwner(p.sessionId); return debuggerCommand('Page.navigate', { url: url.href }, false, undefined, s);
  }
  if (method === 'dialog') {
    const accept = typeof p.accept === 'boolean' ? p.accept : p.action === 'accept' ? true : p.action === 'dismiss' ? false : undefined;
    if (typeof accept !== 'boolean') throw new Error('dialog 需要布尔值 accept 或 action: "accept"|"dismiss"。');
    await attach(check, false, s); check(); requireOwner(p.sessionId);
    const previousDialog = pendingDialogs.get(s.currentTab) || null;
    await debuggerCommand('Page.handleJavaScriptDialog', { accept, ...(typeof p.promptText === 'string' ? { promptText: p.promptText } : {}) }, false, undefined, s);
    pendingDialogs.delete(s.currentTab);
    await publish();
    return { handled: true, accept, dialog: previousDialog };
  }
  if (method === 'cdp') {
    if (typeof p.method !== 'string' || !/^[A-Za-z]+\.[A-Za-z0-9]+$/.test(p.method)) throw new Error('无效的 CDP 方法。');
    if (p.cdpSessionId && !s.childSessions.has(p.cdpSessionId)) throw staleFrameSession();
    if (p.method === 'Page.navigate') assertSite(p.params?.url);
    await attach(check, false, s); check(); requireOwner(p.sessionId);
    if (p.method === 'ProfilePilot.getFrameSessions') {
      if (p.cdpSessionId) throw staleFrameSession();
      return { tabId: s.currentTab, sessions: [...s.childSessions].filter(([, entry]) => entry.type === 'iframe').map(([childId, entry]) => ({ sessionId: childId, parentSessionId: entry.parentSessionId })) };
    }
    if (p.debugCapture === true && p.method === 'Target.setAutoAttach') s.debugFrameCapture = p.params?.waitForDebuggerOnStart === true;
    const cdpParams = p.method === 'Target.setAutoAttach' && p.params?.autoAttach && s.debugFrameCapture ? { ...p.params, waitForDebuggerOnStart: true } : p.params || {};
    return debuggerCommand(p.method, cdpParams, false, p.cdpSessionId, s);
  }
  if (method.startsWith('downloads.')) return handleDownload(method, p, check, s);
  throw new Error('未知扩展操作。');
}
function downloadItem(item) {
  return { id: item.id, filename: item.filename, state: item.state, error: item.error, url: item.url, finalUrl: item.finalUrl, bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, exists: item.exists, danger: item.danger };
}
async function handleDownload(method, p, check, s = primarySession) {
  const owner = p.sessionId;
  if (method === 'downloads.start') {
    assertSite(p.url);
    if (!/^https?:\/\//.test(p.url)) throw new Error('下载地址必须是 HTTP/HTTPS。');
    const id = await chrome.downloads.download({ url: p.url, ...(p.filename ? { filename: String(p.filename) } : {}), conflictAction: 'uniquify', saveAs: false });
    downloadOwners.set(id, owner);
    check(); requireOwner(owner);
    return { id };
  }
  if (method === 'downloads.arm') {
    if ([...downloadArms.values()].some(a => a.sessionId === owner && !a.id)) throw new Error('已有未完成的下载监听，请完成或 disarm 后再开始。');
    await attach(check, false, s); await debuggerCommand('Page.enable', {}, false, undefined, s);
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
  let matchedSession;
  for (const arm of downloadArms.values()) {
    const ownerSession = findSession(arm.sessionId);
    if (!ownerSession || ownerSession.ownership !== 'agent' || arm.id || (arm.url && ![item.url, item.finalUrl].includes(arm.url))) continue;
    arm.candidates.set(item.id, item); matchedSession = ownerSession;
  }
  if (matchedSession) send({ type: 'cdp', sessionId: matchedSession.sessionId, tabId: matchedSession.currentTab, method: 'downloads.candidateCreated', params: downloadItem(item) });
  correlateDownloads();
});
chrome.downloads?.onChanged.addListener(delta => {
  const owner = downloadOwners.get(delta.id);
  const ownerSession = owner ? findSession(owner) : undefined;
  if (owner) send({ type: 'cdp', sessionId: owner, tabId: ownerSession?.currentTab ?? currentTab, method: 'downloads.onChanged', params: delta });
});
function desktopUi(method, params = {}) {
  if (!authenticated || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('请先连接 ProfilePilot 浏览器服务。'));
  const id = `ui-${++uiSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { uiPending.delete(id); reject(new Error('应用请求超时，请核查任务状态；不要重复提交。')); }, 20000);
    timer?.unref?.();
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
  connectionLog('disconnect-requested', { paired: Boolean(config), step: forget ? 'forget-pairing' : 'replace-connection' });
  globalControlEpoch++;
  clearReconnectSchedule();
  clearDetachGrace();
  const sessionsToClose = allActiveSessions();
  if (!sessionsToClose.length) {
    ownership = 'user'; controlEpoch++; groupState(forget ? 'cancelled' : 'failed'); await detach();
  } else {
    for (const s of sessionsToClose) {
      s.ownership = 'user'; s.controlEpoch++; groupState(forget ? 'cancelled' : 'failed', s.sessionId); await detach(s);
    }
  }
  await syncTaskGroups();
  const old = socket; socket = undefined; authenticated = false; reconnectAttempt = 0; clearInterval(heartbeat); old?.close();
  if (forget) {
    config = undefined; sessionId = undefined; currentTab = undefined;
    peerSessions.clear(); allowedTabs.clear(); borrowedUserTabs.clear(); pendingDialogs.clear();
    taskTabs.clear(); taskGroups.clear(); createdTabs.clear();
    await chrome.storage.local.remove('connection');
    await chrome.storage.session.remove(['selection', 'taskTabs', 'taskGroups']);
  }
  await publish();
}
async function connect() {
  clearReconnectSchedule();
  if (connecting || !config || (socket?.readyState === WebSocket.OPEN && authenticated)) {
    if (config && !authenticated && connectionStartedAt && Date.now() - connectionStartedAt >= 15000)
      connectionLog('connect-pending', { port: config.port, elapsedMs: Date.now() - connectionStartedAt, step: connecting ? 'socket-opening' : 'authentication' });
    return connecting;
  }
  if (socket && !authenticated) {
    const staleSocket = socket; socket = undefined; try { staleSocket.close?.(); } catch {}
  }
  connecting = (async () => {
    authenticated = false; connectionError = '';
    connectionStartedAt = Date.now();
    connectionLog('connect-attempt', { port: config.port });
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/profilepilot`); socket = ws;
    let finishHandshake;
    const handshakeDone = new Promise(resolve => { finishHandshake = resolve; });
    const handshakeTimer = setTimeout(() => finishHandshake(), 5000);
    handshakeTimer?.unref?.();
    const settleHandshake = () => { clearTimeout(handshakeTimer); finishHandshake(); };
    ws.onopen = () => { connectionLog('socket-open', { port: config.port }); send({ type: 'hello', profileId: config.profileId, token: config.token }); };
    ws.onmessage = event => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      lastServerMessageAt = Date.now();
      if (message.type === 'ui-result') {
        const pending = uiPending.get(message.id);
        if (pending) { uiPending.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
        return;
      }
      if (message.type === 'welcome') {
        authenticated = true;
        reconnectAttempt = 0;
        clearReconnectSchedule();
        clearDetachGrace();
        connectionLog('authenticated', { port: config.port, elapsedMs: Date.now() - connectionStartedAt });
        void publishConnectionDiagnostics();
        clearInterval(heartbeat); heartbeat = setInterval(() => send({ type: 'heartbeat' }), 20000);
        heartbeat?.unref?.();
        settleHandshake();
        void publish(); return;
      }
      if (!Number.isInteger(message.id) || typeof message.method !== 'string') return;
      const expiresAt = Number.isFinite(message.expiresAt) ? message.expiresAt : Date.now() + 15000;
      const msgSessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : undefined;
      if (message.method === 'disconnect') {
        globalControlEpoch++;
        const active = allActiveSessions();
        if (!active.length) { ownership = 'user'; controlIssue = undefined; controlEpoch++; frameGuardAttachPermit = undefined; }
        for (const s of active) { s.ownership = 'user'; s.controlIssue = undefined; s.controlEpoch++; s.frameGuardAttachPermit = undefined; }
      } else if (message.method === 'control' && ['handoff', 'complete', 'release'].includes(message.params?.action)) {
        const target = findSession(msgSessionId);
        if (target) { target.ownership = 'user'; target.controlIssue = undefined; target.controlEpoch++; target.frameGuardAttachPermit = undefined; }
      }
      const initialGlobalEpoch = globalControlEpoch;
      let trackedSession = msgSessionId ? findSession(msgSessionId) : primarySession;
      let epoch = trackedSession ? trackedSession.controlEpoch : undefined;
      const check = () => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) throw new Error('扩展连接已改变，旧请求已取消。');
        if (globalControlEpoch !== initialGlobalEpoch) {
          throw Object.assign(new Error('控制状态已改变，排队操作已取消；请读取当前状态并重新观察。'),
            { code: 'NATIVE_USER_IN_CONTROL' });
        }
        const currentSession = msgSessionId ? (findSession(msgSessionId) || trackedSession) : primarySession;
        if (epoch !== undefined) {
          const currentEpoch = currentSession ? currentSession.controlEpoch : controlEpoch;
          if (epoch !== currentEpoch) {
            const stillAgent = currentSession ? (currentSession.ownership === 'agent' && !currentSession.pausedByBrowser) : (ownership === 'agent' && !pausedByBrowser);
            throw Object.assign(new Error('控制状态已改变，排队操作已取消；请读取当前状态并重新观察。'),
              { code: stillAgent ? 'NATIVE_OBSERVATION_STALE' : 'NATIVE_USER_IN_CONTROL' });
          }
        }
        if (Date.now() >= expiresAt) throw new Error('请求已超时，未执行排队的浏览器操作。');
      };
      check.bindSession = s => { trackedSession = s; epoch = s.controlEpoch; };
      // An explicit takeover invalidates queued input before awaiting earlier work.
      const execute = async () => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        try { const result = await handle(message.method, message.params || {}, check); send({ id: message.id, result }); }
        catch (error) { send({ id: message.id, error: String(error.message || error), ...(error.code?.startsWith('NATIVE_') ? { code: error.code } : {}) }); }
      };
      // Read-only preview capture, cookie export/import, JS dialog handling, and
      // download waiting must not hold or deadlock behind the session action queue.
      if (
        message.method === 'downloads.wait' ||
        message.method === 'liveView' ||
        message.method === 'dialog' ||
        message.method === 'cookies.export' ||
        message.method === 'cookies.import' ||
        (message.method === 'cdp' && message.params?.debugCapture === true && debugFollowups.has(message.params.method))
      ) void execute();
      else if (message.method === 'claim' && !trackedSession) {
        claimQueue = claimQueue.then(execute);
      } else {
        const queueOwner = msgSessionId ? findSession(msgSessionId) : undefined;
        if (queueOwner && queueOwner !== primarySession) queueOwner.commandQueue = queueOwner.commandQueue.then(execute);
        else commandQueue = commandQueue.then(execute);
      }
    };
    ws.onclose = event => {
      if (socket !== ws) return;
      connectionLog('socket-close', { port: config?.port, closeCode: event?.code, wasClean: event?.wasClean, authenticated });
      authenticated = false;
      if (event?.code === 4001) connectionError = '配对码已失效或连接已撤销，请断开配对后生成新码。';
      if (event?.code === 4009) connectionError = '这个 Profile 已有扩展连接，请检查是否选错了 Chrome Profile。';
      socket = undefined; clearInterval(heartbeat); settleHandshake();
      for (const pending of uiPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('浏览器服务连接中断，请检查任务是否已提交。')); }
      uiPending.clear();
      const permanent = !config || event?.code === 4001 || event?.code === 4009;
      if (permanent) {
        globalControlEpoch++;
        clearReconnectSchedule();
        clearDetachGrace();
        reconnectAttempt = 0;
        const sessions = allActiveSessions();
        if (!sessions.length) { ownership = 'user'; controlEpoch++; groupState('failed'); void detach().then(publish); }
        else void Promise.all(sessions.map(s => { s.ownership = 'user'; s.controlEpoch++; groupState('failed', s.sessionId); return detach(s); })).then(publish);
        return;
      }
      // Keep attached agent sessions alive during transient service restarts for a
      // 15s grace period; non-attached / user-paused sessions bump epoch immediately.
      const sessions = allActiveSessions();
      let hasAttachedAgent = false;
      if (!sessions.length) {
        ownership = 'user'; controlEpoch++; groupState('failed');
      } else {
        for (const s of sessions) {
          if (s.ownership === 'agent' && s.attached && !s.pausedByBrowser) hasAttachedAgent = true;
          else { s.ownership = 'user'; s.controlEpoch++; groupState('failed', s.sessionId); void detach(s); }
        }
      }
      if (hasAttachedAgent && !detachGraceTimer) {
        detachGraceTimer = setTimeout(() => {
          detachGraceTimer = undefined;
          if (authenticated) return;
          const remaining = allActiveSessions();
          if (!remaining.length) { ownership = 'user'; controlEpoch++; groupState('failed'); void detach().then(publish); }
          else void Promise.all(remaining.map(s => { s.ownership = 'user'; s.controlEpoch++; groupState('failed', s.sessionId); return detach(s); })).then(publish);
        }, DETACH_GRACE_MS);
        detachGraceTimer?.unref?.();
      }
      clearReconnectSchedule();
      const backoffMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt++));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (config && !authenticated) void connect();
      }, backoffMs);
      reconnectTimer?.unref?.();
      void publish();
    };
    ws.onerror = () => { connectionLog('socket-error', { port: config?.port, authenticated }); settleHandshake(); };
    ws.addEventListener?.('error', settleHandshake, { once: true });
    ws.addEventListener?.('close', settleHandshake, { once: true });
    await handshakeDone;
    if (socket === ws && !authenticated && ws.readyState === WebSocket.OPEN) {
      try { ws.close?.(); } catch {}
    }
  })().finally(() => { connecting = undefined; });
  return connecting;
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  const s = allActiveSessions().find(entry => entry.currentTab === source.tabId && entry.attached);
  if (!s) return;
  if (method === 'Target.attachedToTarget' && params.sessionId) s.childSessions.set(params.sessionId, { parentSessionId: source.sessionId, type: params.targetInfo?.type });
  if (method === 'Target.detachedFromTarget' && params.sessionId) forgetChildSession(params.sessionId, s.childSessions);
  if (method === 'Page.javascriptDialogOpening') {
    pendingDialogs.set(source.tabId, {
      type: params?.type || 'alert',
      message: String(params?.message || ''),
      defaultPrompt: typeof params?.defaultPrompt === 'string' ? params.defaultPrompt : undefined,
      url: typeof params?.url === 'string' ? params.url : undefined,
      hasBrowserHandler: Boolean(params?.hasBrowserHandler),
      openedAt: Date.now()
    });
    void publish();
  }
  if (method === 'Page.javascriptDialogClosed') {
    if (pendingDialogs.delete(source.tabId)) void publish();
  }
  if (method === 'Page.downloadWillBegin') {
    for (const arm of downloadArms.values()) if (arm.sessionId === s.sessionId && !arm.id && (!arm.frameId || arm.frameId === params.frameId) && (!arm.url || arm.url === params.url)) {
      if (arm.began && arm.began.guid !== params.guid) arm.error = '多次下载事件无法唯一关联，请使用明确下载地址。';
      arm.began = params;
    }
    correlateDownloads();
  }
  send({ type: 'cdp', sessionId: s.sessionId, cdpSessionId: source.sessionId, tabId: source.tabId, method, params });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const s = allActiveSessions().find(entry => entry.currentTab === source.tabId && (entry.attached || entry.debuggerRecovery || entry.frameGuardAttachPermit));
  if (!s) return;
  inputFrames.delete(source.tabId);
  pendingDialogs.delete(source.tabId);
  // Cancellation can arrive while an attach promise is pending. It must win
  // even though our attached flag has not been set yet.
  if (reason === 'canceled_by_user') {
    if (s.debuggerRecovery) s.debuggerRecovery.cancelled = true;
    reportDebugger(reason, 'cancelled', 0, undefined, s); s.controlIssue = undefined;
    s.attached = false; s.preview = false; s.childSessions.clear(); s.debugFrameCapture = false;
    s.ownership = 'user'; s.controlEpoch++; s.pausedByBrowser = true; groupState('paused', s.sessionId);
    void releaseFrameGuards(s).then(publish); return;
  }
  if (!s.attached) return;
  reportDebugger(reason, 'detached', 0, undefined, s);
  // A document navigation loses the old guard's removal history. Reconnect
  // only the same still-authorized live HTTP(S) tab; Chrome enforces access and
  // debugger exclusivity. This restores transport, never a command or input.
  if (reason === 'target_closed' && s.ownership === 'agent' && !s.pausedByBrowser && s.allowedTabs.has(s.currentTab) && !s.debuggerRecovery) {
    s.attached = false; s.preview = false; s.childSessions.clear(); s.debugFrameCapture = false;
    const tabId = s.currentTab, owner = s.sessionId, generation = s.controlGeneration();
    const job = { cancelled: false, promise: undefined };
    const check = () => {
      if (job.cancelled || s.currentTab !== tabId || s.sessionId !== owner || s.controlGeneration() !== generation || s.ownership !== 'agent' || s.pausedByBrowser) throw Error('控制状态已改变，自动恢复已取消。');
    };
    s.debuggerRecovery = job;
    job.promise = (async () => {
      let attempts = 0;
      try {
        const scope = `${generation}:${tabId}`;
        if (s.debuggerRecoveryBudget?.scope !== scope || Date.now() - s.debuggerRecoveryBudget.started > 10000) {
          s.debuggerRecoveryBudget = { scope, started: Date.now(), count: 0 };
        }
        if (++s.debuggerRecoveryBudget.count > 3) throw Object.assign(new Error('同一页面反复断开，已停止自动重连；请检查页面扩展或调试器冲突。'), { code: 'NATIVE_DEBUGGER_RECOVERY_LIMIT' });
        // Let navigation/frame disposal settle without waiting indefinitely.
        await delay(50); check();
        for (attempts = 1; attempts <= 2; attempts++) {
          const tab = await bounded(chrome.tabs.get(tabId), 1000, '检查调试标签页超时。'); check();
          if (!s.allowedTabs.has(tabId) || tab.incognito || !/^https?:\/\//.test(tab.url || '') || tab.discarded || tab.frozen || tab.status === 'unloaded') {
            throw Object.assign(new Error('原调试标签页已关闭、休眠或不再是可控制的网页。'), { code: 'NATIVE_DEBUGGER_TARGET_UNAVAILABLE' });
          }
          reportDebugger(reason, 'attaching', attempts, undefined, s);
          try { await attach(check, true, s); check(); break; }
          catch (error) {
            check();
            // A document can be replaced between tabs.get and script/attach.
            // Busy/forbidden targets are definitive; never keep retrying them.
            const transient = error.code === 'NATIVE_FRAME_GUARD_UNAVAILABLE' ||
              (error.code === 'NATIVE_DEBUGGER_UNAVAILABLE' && /No (?:tab|target)|target closed|frame.*(?:removed|not found)|document.*(?:unloaded|changed)/i.test(error.message));
            if (attempts === 2 || !transient) throw error;
            await delay(150); check();
          }
        }
        s.debuggerRecoverySerial++; s.controlIssue = undefined;
        reportDebugger(reason, 'recovered', attempts, undefined, s);
        send({ type: 'cdp', sessionId: s.sessionId, tabId: s.currentTab, method: 'ProfilePilot.debuggerReconnected', params: {} });
        await publish(); return true;
      } catch (cause) {
        if (!job.cancelled && s.currentTab === tabId && s.sessionId === owner && s.controlGeneration() === generation && s.ownership === 'agent') {
          const error = debuggerFailure(cause);
          reportDebugger(reason, 'failed', attempts, error.code, s);
          rememberIssue(Object.assign(new Error(`Chrome 调试连接断开（${reason}），恢复失败：${error.message}`), { code: error.code }), s);
          s.ownership = 'user'; s.controlEpoch++; s.pausedByBrowser = true; groupState('failed', s.sessionId); await releaseFrameGuards(s); await publish();
        }
        return false;
      } finally { if (s.debuggerRecovery === job) s.debuggerRecovery = undefined; }
    })();
    return;
  }
  reportDebugger(reason, 'failed', 0, 'NATIVE_DEBUGGER_DETACHED', s);
  rememberIssue(Object.assign(new Error(`Chrome 已断开当前页面的调试连接（${reason}）；请检查目标状态。`), { code: 'NATIVE_DEBUGGER_DETACHED' }), s);
  s.attached = false; s.preview = false; s.ownership = 'user'; s.controlEpoch++; s.pausedByBrowser = true; groupState('failed', s.sessionId); void releaseFrameGuards(s).then(publish);
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (allActiveSessions().some(s => s.currentTab === id) && (change.url || change.title)) void publish();
  if (change.groupId !== undefined || change.pinned !== undefined) void syncTaskGroups();
  if (logoTabs.has(id) && (change.url || change.status === 'complete')) syncTabLogos(id);
});
chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  for (const record of taskGroups.values()) record.enrolled = record.enrolled.map(id => id === removedId ? addedId : id);
  void syncTaskGroups();
  if (createdTabs.delete(removedId)) createdTabs.add(addedId);
  if (borrowedUserTabs.delete(removedId)) borrowedUserTabs.add(addedId);
  if (pendingDialogs.has(removedId)) {
    pendingDialogs.set(addedId, pendingDialogs.get(removedId));
    pendingDialogs.delete(removedId);
  }
  if (logoTabs.delete(removedId)) logoTabs.add(addedId);
  appliedLogos.delete(removedId);
  syncTabLogos(addedId);
  // Discarding/restoring can replace the tab's integer ID without changing the
  // browsing slot the user authorized. Track Chrome's explicit replacement.
  for (const saved of taskTabs.values()) {
    saved.tabs = saved.tabs.map(id => id === removedId ? addedId : id);
    if (saved.tabId === removedId) saved.tabId = addedId;
  }
  let changedCurrent = false;
  const candidates = allActiveSessions();
  if (!candidates.length && allowedTabs.delete(removedId)) {
    allowedTabs.add(addedId);
    if (currentTab === removedId) { currentTab = addedId; attached = false; preview = false; changedCurrent = true; }
  }
  for (const s of candidates) {
    if (!s.allowedTabs.delete(removedId)) continue;
    s.allowedTabs.add(addedId);
    if (s.currentTab === removedId) {
      s.currentTab = addedId; s.attached = false; s.preview = false;
      changedCurrent = true;
    }
  }
  if (!changedCurrent) { void saveSelection(); return; }
  void saveSelection().then(publish);
});
chrome.tabs.onCreated.addListener(tab => {
  if (!tab.openerTabId || tab.incognito) return;
  const s = allActiveSessions().find(entry => entry.allowedTabs.has(tab.openerTabId) && entry.sessionId && entry.ownership === 'agent');
  if (s) { s.allowedTabs.add(tab.id); createdTabs.add(tab.id); void syncTaskGroups(); void saveSelection(); }
});
chrome.tabs.onRemoved.addListener(id => {
  for (const record of taskGroups.values()) record.enrolled = record.enrolled.filter(tabId => tabId !== id);
  createdTabs.delete(id); borrowedUserTabs.delete(id); pendingDialogs.delete(id);
  logoTabs.delete(id); appliedLogos.delete(id);
  allowedTabs.delete(id);
  for (const saved of taskTabs.values()) { saved.tabs = saved.tabs.filter(other => other !== id); if (saved.tabId === id) saved.tabId = undefined; }
  if (!allActiveSessions().length && id === currentTab) {
    attached = false; ownership = 'user'; controlEpoch++; pausedByBrowser = false; currentTab = undefined;
  }
  for (const s of allActiveSessions()) {
    s.allowedTabs.delete(id);
    if (id === s.currentTab) {
      s.attached = false; s.ownership = 'user'; s.controlEpoch++; s.pausedByBrowser = Boolean(s.sessionId);
      groupState('paused', s.sessionId); s.currentTab = undefined;
    }
  }
  void saveSelection().then(publish);
});
chrome.tabGroups?.onRemoved?.addListener(group => {
  for (const record of taskGroups.values()) for (const [windowId, id] of Object.entries(record.groups)) if (id === group.id) delete record.groups[windowId];
  void saveTaskGroups();
});
const onboardingInvitations = new Map();
function onboardingInvitation(url) {
  const pending = onboardingInvitations.get(url);
  if (pending) return pending;
  const work = (async () => {
    const id = new URL(url).pathname.split('/').pop();
    const key = `onboarding:${id}`;
    // The page can be reinjected on install/startup or reopened after a failed
    // redirect. Keep the single-use delivery in extension-only session storage.
    const saved = (await chrome.storage.session.get(key))[key];
    if (saved && saved.expiresAt > Date.now()) return saved;
    if (saved) await chrome.storage.session.remove(key);
    // POST carries the extension Origin, which the desktop strictly checks.
    const response = await fetch(`${url}/pair`, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error('连接请求已过期或已使用，请返回应用重新点击授权并连接。');
    const invitation = await response.json();
    await chrome.storage.session.set({ [key]: invitation });
    return invitation;
  })();
  onboardingInvitations.set(url, work);
  void work.finally(() => { if (onboardingInvitations.get(url) === work) onboardingInvitations.delete(url); }).catch(() => {});
  return work;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.method === 'frameGuard') { respond(frameGuardPermission(message, sender)); return; }
  if (message?.method === 'onboarding') {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || sender.tab.incognito || !/^http:\/\/127\.0\.0\.1:[0-9]+\/profilepilot-connect\/[a-f0-9]{48}$/.test(sender.url || '')) return;
    void (async () => {
      if (allActiveSessions().length) throw new Error('当前 Profile 有任务尚未结束，请先结束任务后连接。');
      await onboardingInvitation(sender.url);
      const id = new URL(sender.url).pathname.split('/').pop();
      await chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL(`popup.html#setup=${id}`) });
      respond({ result: {} });
    })().catch(error => respond({ error: error.message }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || !['popup.html', 'sidepanel.html'].some(file => sender.url?.split('#')[0] === chrome.runtime.getURL(file))) return;
  // Stop at receipt, before a slow UI request or queued command can execute.
  if (message.method === 'takeover' || (message.method === 'taskControl' && ['stop', 'takeover'].includes(message.action))) {
    clearDetachGrace();
    if (!message.sessionId) globalControlEpoch++;
    const targets = message.sessionId ? [findSession(message.sessionId)].filter(Boolean) : allActiveSessions();
    if (!targets.length) {
      ownership = 'user'; controlIssue = undefined; controlEpoch++; frameGuardAttachPermit = undefined; groupState('paused'); void detach().then(publish);
    } else {
      for (const s of targets) {
        s.ownership = 'user'; s.controlIssue = undefined; s.controlEpoch++; s.frameGuardAttachPermit = undefined; groupState('paused', s.sessionId);
      }
      void Promise.all(targets.map(s => detach(s))).then(publish);
    }
  }
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
      access = next; await chrome.storage.local.set({ nativeAccess: access });
      for (const s of allActiveSessions()) {
        if (s.currentTab) {
          try { assertSite((await chrome.tabs.get(s.currentTab)).url); }
          catch { s.ownership = 'user'; s.controlEpoch++; groupState('paused', s.sessionId); await detach(s); }
        }
      }
      if (!allActiveSessions().length && currentTab) {
        try { assertSite((await chrome.tabs.get(currentTab)).url); }
        catch { ownership = 'user'; controlEpoch++; groupState('paused'); await detach(); }
      }
      if (authenticated) void desktopUi('setAccess', next).catch(() => {});
      await publish(); return { access };
    }
    if (['startTask', 'taskMessage', 'taskControl', 'taskReply'].includes(message.method)) {
      const { method, ...params } = message;
      if (method === 'startTask' && params.tabId === undefined && !params.newTab) params.tabId = (await pageContext())?.id;
      return desktopUi(method, params);
    }
    if (message.method === 'connect') {
      if (allActiveSessions().length) throw new Error('请先结束现有任务，再重新配对。');
      const code = String(message.code || '');
      if (!code.startsWith('PP1.') || code.length > 2000) throw new Error('配对码无效。');
      const value = JSON.parse(atob(code.slice(4).replace(/-/g, '+').replace(/_/g, '/')));
      if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^native:[^/\\]{1,100}$/.test(value.profileId) || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('配对码无效。');
      await disconnect(); config = value; currentTab = undefined; pausedByBrowser = false;
      peerSessions.clear(); allowedTabs.clear(); borrowedUserTabs.clear(); pendingDialogs.clear();
      taskTabs.clear(); taskGroups.clear(); createdTabs.clear(); syncTabLogos();
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
    if (message.method === 'takeover') {
      const targets = message.sessionId ? [findSession(message.sessionId)].filter(Boolean) : allActiveSessions();
      if (!targets.length) { ownership = 'user'; groupState('paused'); }
      else for (const s of targets) { s.ownership = 'user'; groupState('paused', s.sessionId); }
      await publish(); return state();
    }
    if (message.method === 'return') {
      const s = message.sessionId ? findSession(message.sessionId) : (allActiveSessions().find(entry => entry.ownership === 'user' || entry.pausedByBrowser) || primarySession);
      if (!s || !s.sessionId) throw new Error('当前没有待继续的任务。');
      const expectedSession = s.sessionId, generation = s.controlGeneration();
      const check = () => {
        if (s.sessionId !== expectedSession || generation !== s.controlGeneration()) throw new Error('用户已停止或接管，排队恢复已取消。');
      };
      await prepareTask(expectedSession, check, {}, s); check();
      s.pausedByBrowser = false; await saveSelection(); check();
      await attachForTask(check, s); check(); s.controlIssue = undefined;
      s.ownership = 'agent'; groupState('running', s.sessionId); await publish(); return state();
    }
    if (message.method === 'disconnect') { await disconnect(true); return state(); }
    throw new Error('未知操作。');
  })().then(result => respond({ result }), error => respond({ error: String(error.message || error) }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'reconnect') return;
  if (authenticated && Date.now() - lastConnectionCheckpoint >= 300000) {
    lastConnectionCheckpoint = Date.now();
    connectionLog('heartbeat-checkpoint', { port: config?.port, authenticated, elapsedMs: Date.now() - lastServerMessageAt });
    void publishConnectionDiagnostics();
  }
  void connect();
});
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
chrome.runtime.onInstalled?.addListener(() => { connectionLog('extension-installed'); void installed(); });
chrome.runtime.onStartup?.addListener(() => { connectionLog('browser-startup'); void installed(); void connect(); });
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (!tab?.id || tab.incognito || !usable(tab.url)) return;
  // Invoke open while Chrome still considers this a user gesture.
  const opening = openSidePanel(tab.id);
  void chrome.storage.session.set({ nativeTaskContext: { id: tab.id, tabId: tab.id, title: tab.title, url: tab.url, selection: info.selectionText || '', at: Date.now() } });
  void opening.catch(() => {});
});
// Chrome extension service workers do not support top-level await. Register all
// listeners synchronously, then restore only a previously paired connection.
let connectionInitializationStep = 'alarms';
void (async () => {
  await chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
  connectionInitializationStep = 'installation';
  try { installationType = (await chrome.management?.getSelf())?.installType; } catch {}
  installationMode = (await chrome.storage.local.get('profilepilotInstallation')).profilepilotInstallation?.mode;
  connectionInitializationStep = 'connection-storage';
  const saved = (await chrome.storage.local.get('connection')).connection;
  connectionInitializationStep = 'access-storage';
  const savedAccess = (await chrome.storage.local.get('nativeAccess')).nativeAccess;
  if (savedAccess && Array.isArray(savedAccess.blockedOrigins)) access = { ...access, ...savedAccess };
  connectionInitializationStep = 'session-storage';
  const selection = (await chrome.storage.session.get('selection')).selection;
  const savedTasks = (await chrome.storage.session.get('taskTabs')).taskTabs;
  const savedGroups = (await chrome.storage.session.get('taskGroups')).taskGroups;
  const savedLogos = (await chrome.storage.session.get('tabLogos')).tabLogos;
  if (saved) {
    config = saved;
    connectionInitializationStep = 'restore-session';
    if (savedGroups?.profileId === config.profileId && Array.isArray(savedGroups.tasks)) {
      for (const [id, record] of savedGroups.tasks) if (typeof id === 'string' && record && Array.isArray(record.enrolled) && record.groups && Object.hasOwn(GROUP_STATES, record.phase)) {
        taskGroups.set(id, { phase: record.phase === 'running' ? 'paused' : record.phase,
          title: typeof record.title === 'string' ? record.title.slice(0, 60) : '',
          groups: Object.fromEntries(Object.entries(record.groups).filter(([windowId, groupId]) => /^\d+$/.test(windowId) && Number.isInteger(groupId) && groupId >= 0)),
          enrolled: record.enrolled.filter(Number.isSafeInteger) });
      }
    }
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
    void syncTaskGroups();
    connectionInitializationStep = 'connect';
    await connect();
  }
  connectionLog('worker-ready', { paired: Boolean(config) });
})().catch(error => {
  connectionLog('initialization-failed', { step: connectionInitializationStep, ...connectionDiagnostics?.errorInfo(error) });
  connectionError = '扩展初始化失败，请先导出连接诊断；现有配对已保留。';
});
