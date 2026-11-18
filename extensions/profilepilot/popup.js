const $ = selector => document.querySelector(selector);
const setupId = new URLSearchParams(location.hash.slice(1)).get('setup');
let invitation, currentWindowId, polling = false, busy = false, generation = 0;
let latestState, currentSiteOrigin = '';
const connectionDiagnostics = globalThis.ProfilePilotConnectionDiagnostics;
let workerReadFailure;

function parseHttpOrigin(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function showError(error) { $('#error').textContent = error?.message || String(error); $('#error').hidden = false; }
function clearError() { $('#error').hidden = true; }
async function request(method, data = {}) {
  let timer;
  // Bound only the read probe. Never time out/replay a user mutation here.
  let response;
  try {
    const sending = chrome.runtime.sendMessage({ method, ...data });
    response = method === 'state' ? await Promise.race([sending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('diagnostic state timeout')), 4000);
    })]) : await sending;
  } finally { clearTimeout(timer); }
  if (!response || response.error) throw new Error(response?.error || '扩展未响应，请重新打开插件。');
  return response.result;
}
function render(state) {
  latestState = state;
  const pairedView = Boolean(state.profileId) && !invitation;
  $('#profile-name').textContent = state.profileName || (state.profileId === 'native:Default' ? '系统默认 Profile' : state.profileId?.replace(/^native:/, '')) || '当前 Profile';
  $('#connection-state').hidden = false;
  $('#connection-label').textContent = state.connected ? '已连接' : state.profileId ? '未连接' : '尚未配对';
  $('#connection-label').className = 'connection-label' + (state.connected ? ' connected' : '');
  $('#connection-note').textContent = state.connectionError || (state.connected ? '浏览器服务正常' : state.profileId ? '打开 ProfilePilot 或运行 CLI 后会自动重连' : '配对后即可连接浏览器服务');
  $('#connect').hidden = pairedView;
  $('#reconnect').hidden = !state.profileId || state.connected || Boolean(invitation);
  $('#controlled-tab').hidden = !pairedView;

  // The last tab can outlive its session. Only a live control session owns a
  // target; the active Chrome tab and historical conversations are unrelated.
  const hasSession = Boolean(state.connected && state.sessionId);
  const hasTab = hasSession && Number.isSafeInteger(state.tabId) && state.tabId > 0 && Boolean(state.tabTitle || state.url);
  const controlling = hasTab && state.ownership === 'agent' && !state.pausedByBrowser;
  const issue = hasSession && !controlling ? state.controlIssue : undefined;
  $('#control-state').textContent = !state.connected ? '未连接' : hasTab ? controlling ? state.extensionUi ? '扩展界面模式' : '正在控制' : issue ? '连接受阻' : '已暂停' : hasSession ? '等待页面' : '空闲';
  $('#control-state').className = 'control-state' + (controlling ? ' active' : hasTab ? ' paused' : '');
  $('#page-title').textContent = hasTab ? state.tabTitle || (state.url === 'about:blank' ? '空白标签页' : state.url) : !state.connected ? '连接后显示受控标签页' : hasSession ? '当前没有可用的受控标签页' : '当前没有受控标签页';
  let domain = '';
  if (hasTab && state.url) {
    try { domain = new URL(state.url).host || (state.url === 'about:blank' ? '空白页' : ''); } catch { /* No fabricated URL for a closing tab. */ }
  }
  $('#page-domain').textContent = domain;
  $('#page-domain').hidden = !domain;
  $('#page-note').textContent = issue?.message || (hasTab ? controlling ? '' : '浏览器操作已暂停' : !state.connected ? '正在等待浏览器服务连接' : hasSession ? '等待 Agent 选择标签页' : 'Agent 开始控制后，标签页会显示在这里');
  $('#page-note').hidden = !$('#page-note').textContent;

  const isTemporaryInstall = state.installation?.temporary === true || state.installationMode === 'temporary';
  if ($('#temp-install-notice')) $('#temp-install-notice').hidden = !(pairedView && isTemporaryInstall);

  currentSiteOrigin = parseHttpOrigin((hasTab ? state.url : '') || state.activeTabUrl || state.currentTab?.url || '');
  if ($('#site-access-section')) {
    const showSiteAccess = pairedView && Boolean(currentSiteOrigin);
    $('#site-access-section').hidden = !showSiteAccess;
    if (showSiteAccess) {
      try { $('#site-access-origin').textContent = new URL(currentSiteOrigin).host; } catch { $('#site-access-origin').textContent = currentSiteOrigin; }
      const accessCfg = state.access || {};
      const blocked = Array.isArray(accessCfg.blockedOrigins) && accessCfg.blockedOrigins.includes(currentSiteOrigin);
      $('#site-access-select').value = blocked ? 'block' : accessCfg.confirmActions === true ? 'confirm' : 'allow';
    }
  }

  if ($('#security-controls')) {
    const extSessions = Array.isArray(state.sessions) ? state.sessions : [];
    const anyControlling = controlling || (Boolean(state.connected) && extSessions.some(s => s.ownership === 'agent' && !s.pausedByBrowser));
    const anyPaused = (hasSession && !controlling) || (Boolean(state.connected) && extSessions.some(s => s.sessionId && (s.ownership === 'user' || s.pausedByBrowser)));
    $('#security-controls').hidden = !pairedView;
    if ($('#pause-takeover-btn')) $('#pause-takeover-btn').hidden = !(pairedView && anyControlling);
    if ($('#return-control-btn')) $('#return-control-btn').hidden = !(pairedView && !anyControlling && anyPaused);
    if ($('#disconnect-browser-btn')) $('#disconnect-browser-btn').hidden = !pairedView;
  }

  $('#status').textContent = $('#connection-label').textContent + ' · ' + $('#control-state').textContent;
}
async function pollState() {
  if (polling || busy) return;
  polling = true;
  const version = generation;
  try {
    // A local worker read only: opening this view never reconnects, claims a
    // page, reads page content or waits for the desktop's task service.
    const state = await request('state');
    if (workerReadFailure) { void connectionDiagnostics?.record('popup-recovered'); workerReadFailure = undefined; }
    if (version === generation) render(state);
  } catch (error) {
    const detail = connectionDiagnostics?.errorInfo(error);
    const signature = detail?.errorKind || 'unclassified';
    if (workerReadFailure !== signature) void connectionDiagnostics?.record('popup-unreachable', detail);
    workerReadFailure = signature;
    if (version === generation) {
      $('#connection-state').hidden = false;
      $('#connection-label').textContent = '状态暂不可用';
      $('#connection-label').className = 'connection-label';
      $('#connection-note').textContent = '无法读取扩展后台状态。请先导出连接诊断，并保留扩展管理页中的错误，再尝试重新加载。';
      $('#controlled-tab').hidden = true;
      if ($('#temp-install-notice')) $('#temp-install-notice').hidden = true;
      if ($('#site-access-section')) $('#site-access-section').hidden = true;
      if ($('#security-controls')) $('#security-controls').hidden = true;
      $('#status').textContent = '连接状态暂不可用';
    }
  } finally { polling = false; }
}
$('#export-diagnostics')?.addEventListener('click', async () => {
  const button = $('#export-diagnostics'), note = $('#diagnostics-note');
  if (button.disabled) return;
  button.disabled = true; button.textContent = '正在导出…'; note.textContent = '';
  try {
    if (!connectionDiagnostics) throw new Error('诊断模块未加载，请保留扩展管理页中的错误。');
    const report = await connectionDiagnostics.report();
    let saved;
    try { saved = (await chrome.storage.local.get('connection')).connection; }
    catch { report.storageAvailable = false; }
    report.current = { extensionVersion: chrome.runtime.getManifest().version, paired: Boolean(saved),
      pairingKnown: report.storageAvailable,
      ...(Number.isInteger(saved?.port) ? { port: saved.port } : {}), workerReadFailure: workerReadFailure || null };
    await chrome.downloads.download({ url: 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(report, null, 2)),
      filename: 'profilepilot-connection-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', saveAs: false });
    note.textContent = report.storageAvailable ? '诊断文件已开始下载。' : '已开始下载；本地日志存储不可用，记录可能不完整。';
  } catch (error) { note.textContent = error.message || '诊断导出失败，请保留扩展管理页中的错误。'; }
  finally { button.disabled = false; button.textContent = '导出连接诊断'; }
});
function setBusy(value, action = 'connect') {
  busy = value;
  $('#connect-submit').disabled = value;
  $('#reconnect').disabled = value;
  $('#code').readOnly = value;
  for (const id of ['#pause-takeover-btn', '#return-control-btn', '#disconnect-browser-btn', '#site-access-select', '#clear-temp-install-btn']) {
    if ($(id)) $(id).disabled = value;
  }
  $('#connect').setAttribute('aria-busy', String(value && action === 'connect'));
  $('#reconnect').setAttribute('aria-busy', String(value && action === 'reconnect'));
  $('#connect-submit').textContent = value && action === 'connect' ? '正在连接…' : '连接浏览器服务';
  $('#reconnect').textContent = value && action === 'reconnect' ? '正在重新连接…' : '重新连接';
  if (value && (action === 'connect' || action === 'reconnect')) {
    $('#status').textContent = action === 'reconnect' ? '正在重新连接浏览器服务…' : '正在连接浏览器服务…';
  }
}
async function runUiMutation(actionName, fn) {
  if (busy) return;
  clearError(); setBusy(true, actionName); generation++;
  try {
    const result = await fn();
    if (result && typeof result === 'object' && ('connected' in result || 'profileId' in result)) render(result);
    else render(await request('state'));
  } catch (error) { showError(error); }
  finally { setBusy(false, actionName); }
}
$('#pause-takeover-btn')?.addEventListener('click', () => runUiMutation('takeover', () => request('takeover')));
$('#return-control-btn')?.addEventListener('click', () => runUiMutation('return', () => request('return')));
$('#disconnect-browser-btn')?.addEventListener('click', () => runUiMutation('disconnect', () => request('disconnect')));
$('#clear-temp-install-btn')?.addEventListener('click', () => runUiMutation('confirmPersistentInstallation', () => request('confirmPersistentInstallation', { confirmed: true })));
$('#site-access-select')?.addEventListener('change', () => {
  const origin = currentSiteOrigin;
  if (!origin) return;
  const mode = $('#site-access-select').value;
  const prev = latestState?.access || {};
  const blocked = new Set(Array.isArray(prev.blockedOrigins) ? prev.blockedOrigins : []);
  const allowed = new Set(Array.isArray(prev.allowedOrigins) ? prev.allowedOrigins : []);
  let confirmActions = Boolean(prev.confirmActions);
  if (mode === 'block') {
    blocked.add(origin);
    allowed.delete(origin);
  } else if (mode === 'confirm') {
    blocked.delete(origin);
    if (allowed.size > 0) allowed.add(origin);
    confirmActions = true;
  } else {
    blocked.delete(origin);
    if (allowed.size > 0) allowed.add(origin);
    confirmActions = false;
  }
  void runUiMutation('setAccess', async () => {
    const res = await request('setAccess', { blockedOrigins: [...blocked], allowedOrigins: [...allowed], confirmActions });
    if (res && typeof res === 'object' && 'connected' in res) return res;
    if (latestState && res?.access) latestState = { ...latestState, access: res.access };
    return request('state');
  });
});
$('#connect').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  clearError(); setBusy(true); generation++;
  try {
    if (invitation && invitation.expiresAt <= Date.now()) throw new Error('连接请求已过期，请返回应用重新授权。');
    const state = await request('connect', { code: $('#code').value.trim() });
    if (setupId) await chrome.storage.session.remove('onboarding:' + setupId);
    invitation = undefined; $('#code').value = ''; render(state);
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
$('#reconnect').onclick = async () => {
  if (busy) return;
  clearError(); setBusy(true, 'reconnect'); generation++;
  try { render(await request('reconnect')); } catch (error) { showError(error); }
  finally { setBusy(false); }
};
$('#close-panel')?.addEventListener('click', () => {
  if (chrome.sidePanel.close && Number.isInteger(currentWindowId)) void chrome.sidePanel.close({ windowId: currentWindowId }).catch(showError);
  else window.close();
});
window.addEventListener('focus', () => void pollState());
if (setupId && /^[a-f0-9]{48}$/.test(setupId)) {
  document.body.classList.add('authorization-page');
  try {
    invitation = (await chrome.storage.session.get('onboarding:' + setupId))['onboarding:' + setupId];
    if (invitation && invitation.expiresAt > Date.now()) {
      $('#code').value = invitation.code; $('#code').hidden = true;
      $('label[for="code"]').textContent = '请确认：当前 Chrome Profile 是「' + invitation.profileName + '」';
    } else { invitation = undefined; showError(new Error('连接请求已过期，请返回应用重新点击授权并连接。')); }
  } catch (error) { showError(error); }
}
await Promise.all([pollState(), chrome.windows.getCurrent().then(value => { currentWindowId = value.id; }).catch(showError)]);
setInterval(() => void pollState(), 2000);
