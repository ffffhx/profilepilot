const $ = selector => document.querySelector(selector);
const status = $('#status');
const setupId = new URLSearchParams(location.hash.slice(1)).get('setup');
let invitation, browserState, currentWindowId, pageContext, selectedTaskId;
let tabRefreshVersion = 0, tabRefreshTimer, renderedTabs = '', renderedMessages = '';
let accessLoaded = false, sending = false, newConversation = false, contextKey = '';
let renderVersion = 0, conversationVersion = 0, draftVersion = 0, submission;
let displayTabs = [];
const labels = { queued: '等待执行', running: '正在执行', waiting_user: '等待你的回复', paused: '已停止，可继续', completed: '已完成', partial: '部分完成', failed: '执行失败', cancelled: '已结束' };
function showError(error) { $('#error').textContent = error?.message || String(error); $('#error').hidden = false; }
function clearError() { $('#error').hidden = true; }
async function request(method, data = {}) {
  const result = await chrome.runtime.sendMessage({ method, ...data });
  if (!result || result.error) throw new Error(result?.error || '扩展未响应，请重新打开侧边栏。');
  return result.result;
}
function task() { return newConversation ? undefined : browserState?.task; }
function externalBrowserSession() {
  const session = browserState?.sessionId;
  // Built-in tasks reserve pp-task-*; a historical conversation must not own
  // controls for the external Agent currently holding this browser.
  return Boolean(session && !session.startsWith('pp-task-'));
}
function taskOwnsBrowser() {
  return Boolean(task() && browserState?.sessionId && !externalBrowserSession() &&
    (!browserState.taskSessionId || browserState.taskSessionId === browserState.sessionId));
}
function selectedTarget() {
  const value = $('#next-tab').value;
  if (value === 'new') return { newTab: true };
  const tabId = value === 'current' ? browserState?.currentTab?.id ?? browserState?.currentTab?.tabId : Number(value);
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new Error('请打开普通网页，或选择“新建页”。');
  return { tabId };
}
async function actionTarget() {
  const choice = $('#next-tab').value;
  if (choice === 'current') {
    const current = await request('getPageContext');
    if ($('#next-tab').value !== choice) throw new Error('任务页面已改变，请重新发送。');
    if (!current || !Number.isSafeInteger(current.id ?? current.tabId)) throw new Error('请打开普通网页，或选择“新建页”。');
    browserState.currentTab = current; renderPageContext();
  }
  return selectedTarget();
}
function updateButtons() {
  const current = task(), connected = Boolean(browserState?.connected);
  const pending = current?.pending || browserState?.pending;
  const external = externalBrowserSession();
  const ownsBrowser = Boolean(browserState?.sessionId && (external || !browserState.taskSessionId || browserState.taskSessionId === browserState.sessionId));
  $('#takeover').disabled = !connected || !(browserState?.sessionId || current && ['queued', 'running', 'waiting_user'].includes(current.status));
  const resumable = browserState?.sessionId
    ? external || !current ? browserState.ownership === 'user'
      : taskOwnsBrowser() && (current.status === 'paused' || pending?.kind === 'handoff')
    : current?.status === 'paused' || pending?.kind === 'handoff';
  $('#return').disabled = !connected || !resumable;
  $('#select-tab').disabled = !connected || !ownsBrowser || !$('#next-tab').value;
  $('#select-tab').hidden = !ownsBrowser || newConversation;
  $('#send').disabled = !connected || browserState?.taskServiceAvailable === false || sending || !$('#prompt').value.trim();
  $('#send').textContent = sending ? '发送中…' : current ? '发送' : '开始任务';
  $('#prompt-label').textContent = current ? '继续对话' : '让浏览器帮你做什么？';
}
function renderConversation() {
  const current = task();
  $('#conversation').hidden = !current;
  if (!current) { renderedMessages = ''; $('#messages').replaceChildren(); return; }
  $('#task-title').textContent = current.title || '当前任务';
  $('#task-status').textContent = labels[current.status] || current.status || '';
  $('#task-status').className = current.status === 'waiting_user' ? 'waiting' : current.status === 'completed' ? 'complete' : current.status === 'paused' ? 'paused' : '';
  const events = current.events || browserState?.events || current.messages || [];
  const streamValue = current.stream || browserState?.stream;
  const stream = typeof streamValue === 'string' ? streamValue : streamValue?.text;
  const entries = [...events, ...(stream ? [{ kind: 'assistant', text: stream }] : [])];
  if (!entries.length && current.prompt) entries.push({ kind: 'user', text: current.prompt });
  // The popup is a compact task card; the side panel retains the full log.
  const latest = [...entries].reverse().find(entry => entry.kind === 'assistant');
  const summary = latest?.text || latest?.content || current.prompt || '';
  $('#task-summary').textContent = summary; $('#task-summary').hidden = !summary;
  const progress = entries.filter(entry => ['action', 'system'].includes(entry.kind)).slice(-3);
  $('#task-progress').hidden = !progress.length;
  $('#task-progress').replaceChildren(...progress.map((entry, index) => {
    const text = String(entry.text || entry.content || '');
    const step = document.createElement('span');
    const complete = entry.status === 'completed' || entry.completed === true;
    step.className = 'progress-step' + (complete ? ' complete' : index === progress.length - 1 && current.status === 'running' ? ' active' : '');
    step.textContent = text.split('\n')[0].slice(0, 14); step.title = text; return step;
  }));
  const signature = JSON.stringify([current.id, entries]);
  if (signature !== renderedMessages) {
    const log = $('#messages');
    const follow = !renderedMessages || log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    renderedMessages = signature;
    const nodes = entries.map(entry => {
      const row = document.createElement('div');
      const kind = ['user', 'assistant', 'system', 'action', 'error'].includes(entry.kind) ? entry.kind : 'assistant';
      row.className = 'message ' + kind;
      const label = document.createElement('span'); label.className = 'message-label';
      label.textContent = kind === 'user' ? '你' : kind === 'assistant' ? 'Agent' : kind === 'error' ? '执行提示' : '进度';
      const copy = document.createElement('div'); copy.textContent = entry.text || entry.content || '';
      row.replaceChildren(label, copy); return row;
    });
    log.replaceChildren(...nodes); if (follow) log.scrollTop = log.scrollHeight;
  }
  const pending = current.pending || browserState?.pending;
  $('#pending').hidden = !pending;
  $('#pending').textContent = pending ? [pending.title, pending.details, pending.kind === 'confirmation' ? '此任务启用了逐次确认。' : '可在下方回复，或继续任务。'].filter(Boolean).join('\n') : '';
  $('#decision-controls').hidden = pending?.kind !== 'confirmation';
}
function renderPageContext() {
  const target = $('#next-tab').value;
  const context = target === 'current' ? browserState?.currentTab : pageContext || displayTabs.find(tab => String(tab.id) === target);
  $('#page-title').textContent = target === 'new' ? '在当前 Profile 新建后台标签页' : context?.title || context?.url || '选择普通网页即可开始';
  let domain = '';
  if (target !== 'new' && context?.url) { try { domain = new URL(context.url).hostname; } catch { /* Browser internal pages have no public domain. */ } }
  $('#page-domain').textContent = domain;
  $('#page-current').ariaPressed = String(target !== 'new');
  $('#page-current').textContent = target === 'current' || target === 'new' ? '当前页' : '选定页面';
  $('#page-new').ariaPressed = String(target === 'new');
  const matches = pageContext && target !== 'new' && (target === 'current' ? (pageContext.id ?? pageContext.tabId) === (browserState?.currentTab?.id ?? browserState?.currentTab?.tabId) : String(pageContext.id ?? pageContext.tabId) === target);
  const selection = matches ? pageContext.selection || '' : '';
  $('#selection').textContent = selection; $('#selection').hidden = !selection;
  $('#include-selection-label').hidden = !selection;
}
async function render() {
  const version = ++renderVersion;
  const state = await request('getUiState', selectedTaskId ? { taskId: selectedTaskId } : {});
  if (version !== renderVersion) return;
  browserState = state;
  if (!newConversation && state.task?.id) selectedTaskId = state.task.id;
  $('#connect').hidden = Boolean(state.profileId) && !invitation;
  $('#controls').hidden = !state.profileId || Boolean(invitation);
  $('#temporary-installation').hidden = state.installationMode !== 'temporary';
  status.textContent = state.connectionError || (invitation ? '请确认当前 Profile 并连接浏览器服务。' : state.connected ? '浏览器服务已连接 · ' + state.profileId + '\n' + (state.sessionId ? state.ownership === 'agent' ? '任务操作中 · 可随时停止' : '已停止浏览器操作' : '可直接使用当前页，也可新建页') : state.profileId ? '浏览器服务未连接。运行 ppilot browser status 或打开 ProfilePilot，可启动服务并自动重连。' : '尚未配对');
  $('#desktop-required').hidden = !state.connected || state.taskServiceAvailable !== false;
  $('#compose').hidden = state.taskServiceAvailable === false;
  if (state.taskError) status.textContent += '\n任务服务：' + state.taskError;
  const namedTask = state.task?.profileId === state.profileId ? state.task?.profileName : '';
  $('#profile-name').textContent = state.profileName || namedTask || (state.profileId === 'native:Default' ? '默认 Profile' : state.profileId?.replace(/^native:/, '')) || '当前 Profile';
  $('#connection-label').textContent = state.connected ? '已连接' : state.profileId ? '未连接' : '尚未配对';
  $('#connection-label').className = 'connection-label' + (state.connected ? ' connected' : '');
  $('#connection-note').textContent = state.connectionError || state.taskError || (state.connected ? state.sessionId ? state.ownership === 'agent' ? '任务操作中，可随时停止' : '已停止浏览器操作' : '浏览器服务正常' : state.profileId ? '等待浏览器服务重连' : '连接当前 Chrome Profile');
  $('#access-summary').textContent = state.access?.confirmActions ? '逐次确认已开启' : '';
  if (!accessLoaded && state.access) {
    $('#blocked-origins').value = (state.access.blockedOrigins || []).join('\n');
    $('#allowed-origins').value = (state.access.allowedOrigins || []).join('\n');
    $('#confirm-actions').checked = state.access.confirmActions === true; accessLoaded = true;
  }
  renderConversation(); renderPageContext(); updateButtons();
}
async function refreshTabs() {
  const version = ++tabRefreshVersion;
  const tabs = (await chrome.tabs.query({})).filter(t => !t.incognito && /^https?:\/\//.test(t.url || '') && !/^http:\/\/127\.0\.0\.1:[0-9]+\/profilepilot-connect\//.test(t.url || ''));
  if (version !== tabRefreshVersion) return;
  displayTabs = tabs;
  const signature = JSON.stringify(tabs.map(t => [t.id, t.title, t.url, t.windowId, t.active]));
  if (signature === renderedTabs) return;
  const first = !renderedTabs; renderedTabs = signature;
  const select = $('#next-tab'), previous = select.value;
  const choices = [{ value: 'current', label: '当前页' }, { value: 'new', label: '新建页' },
    ...tabs.map(t => ({ value: String(t.id), label: (t.title || t.url) + ' — ' + new URL(t.url).hostname + (t.windowId === currentWindowId ? '（当前窗口）' : '') }))];
  const nodes = choices.map(choice => { const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; return option; });
  select.replaceChildren(...nodes);
  select.value = first && !previous ? 'current' : choices.some(c => c.value === previous) ? previous : '';
  if (!select.value) { const option = document.createElement('option'); option.value = ''; option.textContent = '该页面已关闭，请重新选择'; option.disabled = true; nodes.unshift(option); select.replaceChildren(...nodes); select.value = ''; }
  updateButtons(); renderPageContext();
}
function scheduleTabRefresh() {
  clearTimeout(tabRefreshTimer);
  tabRefreshTimer = setTimeout(() => void refreshTabs().catch(showError), 100);
}
async function refreshContext() {
  const target = await actionTarget();
  if (target.newTab) { pageContext = undefined; renderPageContext(); return; }
  pageContext = await request('getPageContext', target); renderPageContext();
}
async function useSavedContext() {
  const saved = (await chrome.storage.session.get('nativeTaskContext')).nativeTaskContext;
  if (!saved) return;
  const key = JSON.stringify(saved);
  if (key === contextKey) return;
  contextKey = key; pageContext = saved;
  const tabId = saved.tabId ?? saved.id;
  if (tabId) { await refreshTabs(); $('#next-tab').value = String(tabId); }
  renderPageContext(); updateButtons();
  await chrome.storage.session.remove('nativeTaskContext');
  contextKey = '';
}
$('#connect').addEventListener('submit', async event => {
  event.preventDefault(); clearError();
  try {
    if (invitation && invitation.expiresAt <= Date.now()) throw new Error('连接请求已过期，请返回应用重新授权。');
    await request('connect', { code: $('#code').value.trim() });
    if (setupId) await chrome.storage.session.remove('onboarding:' + setupId);
    invitation = undefined; selectedTaskId = undefined; $('#code').value = ''; await render();
  } catch (error) { showError(error); }
});
for (const id of ['reconnect', 'disconnect']) $('#' + id).onclick = async () => {
  clearError();
  try { await request(id); accessLoaded = false; if (id === 'disconnect') selectedTaskId = undefined; await render(); } catch (error) { showError(error); }
};
$('#open-side-panel').onclick = () => {
  clearError();
  // Chrome requires the original click gesture. Messaging the worker and then
  // awaiting tabs.query loses that gesture on some supported Chrome versions.
  if (!Number.isInteger(currentWindowId)) { showError(new Error('正在读取当前窗口，请稍后重试。')); return; }
  void chrome.sidePanel.open({ windowId: currentWindowId }).catch(showError);
};
$('#close-panel').onclick = () => {
  if (chrome.sidePanel.close && Number.isInteger(currentWindowId)) void chrome.sidePanel.close({ windowId: currentWindowId }).catch(showError);
  else window.close();
};
$('#confirm-persistent-installation').onclick = async () => {
  clearError();
  try { await request('confirmPersistentInstallation', { confirmed: true }); await render(); }
  catch (error) { showError(error); }
};
$('#takeover').onclick = async () => {
  clearError();
  try {
    const current = task();
    // Takeover in the extension aborts browser commands immediately, including if the app is busy.
    if (browserState?.sessionId) await request('takeover');
    if (current?.id && !externalBrowserSession() && ['queued', 'running', 'waiting_user'].includes(current.status)) await request('taskControl', { taskId: current.id, action: 'stop', requestId: crypto.randomUUID() });
    await render();
  } catch (error) { showError(error); }
};
$('#return').onclick = async () => {
  clearError();
  try {
    const current = task();
    if (browserState?.sessionId && (externalBrowserSession() || !current)) await request('return');
    else if (current?.id && (!browserState?.sessionId || taskOwnsBrowser())) await request('taskControl', { taskId: current.id, action: 'resume', requestId: crypto.randomUUID() });
    else throw new Error('当前对话不拥有浏览器，请先选择正在操作的任务。');
    await render();
  } catch (error) { showError(error); }
};
$('#select-tab').onclick = async () => {
  clearError();
  try { await request('selectTab', await actionTarget()); await render(); } catch (error) { showError(error); }
};
$('#refresh-context').onclick = () => { clearError(); void refreshContext().catch(showError); };
if ($('#reread-context')) $('#reread-context').onclick = $('#refresh-context').onclick;
$('#new-task').onclick = () => { conversationVersion++; renderVersion++; newConversation = true; selectedTaskId = undefined; submission = undefined; renderConversation(); updateButtons(); $('#prompt').focus(); };
$('#prompt').addEventListener('input', () => { draftVersion++; updateButtons(); });
$('#next-tab').addEventListener('change', () => { pageContext = undefined; renderPageContext(); updateButtons(); });
for (const [id, target] of [['page-current', 'current'], ['page-new', 'new']]) $('#' + id).onclick = () => {
  $('#next-tab').value = target; pageContext = undefined; renderPageContext(); updateButtons();
};
$('#compose').addEventListener('submit', async event => {
  event.preventDefault(); if (sending) return;
  const draft = $('#prompt').value, prompt = draft.trim(); if (!prompt) return;
  const conversation = conversationVersion, draftAtSend = draftVersion;
  clearError(); sending = true; updateButtons();
  try {
    const current = task();
    const context = $('#include-selection').checked ? pageContext : undefined;
    // The retry identity describes the user's input, not visibility changed by
    // polling. A lost response must keep its original target and request ID.
    const key = JSON.stringify({ prompt, target: $('#next-tab').value,
      selection: context && [context.id ?? context.tabId, context.url, context.selection] });
    // Preserve both target and command after a lost response, even if the user has
    // changed Chrome tabs or polling has already discovered the newly created task.
    if (!submission || submission.key !== key || submission.conversation !== conversation) {
      const target = current ? {} : await actionTarget();
      let selection;
      if (!current && context?.selection && (context.id ?? context.tabId) === target.tabId) {
        const actual = await request('getPageContext', { tabId: target.tabId });
        if ((actual?.id ?? actual?.tabId) === target.tabId && actual?.url === context.url) selection = context.selection;
      }
      // New conversation selection while resolving the target cancels this
      // unsent request; after dispatch it only isolates the eventual response.
      if (conversation !== conversationVersion) return;
      const payload = current ? { taskId: current.id, message: prompt } : { prompt, ...target, ...(selection ? { selection } : {}) };
      submission = { key, conversation, id: crypto.randomUUID(), method: current ? 'taskMessage' : 'startTask', payload };
    }
    const sent = submission;
    const result = await request(sent.method, { ...sent.payload, requestId: sent.id });
    if (submission === sent) submission = undefined;
    if (conversation !== conversationVersion) return;
    if (draftVersion === draftAtSend && $('#prompt').value === draft) $('#prompt').value = '';
    newConversation = false;
    if (result?.id) browserState.task = result; else if (result?.task) browserState.task = result.task;
    selectedTaskId = browserState.task?.id;
    await render();
  } catch (error) { if (conversation === conversationVersion) showError(error); }
  finally { sending = false; updateButtons(); }
});
for (const [id, approved] of [['approve', true], ['deny', false]]) $('#' + id).onclick = async () => {
  const current = task(), pending = current?.pending || browserState?.pending;
  if (!current || pending?.kind !== 'confirmation') return;
  clearError(); $('#approve').disabled = true; $('#deny').disabled = true;
  try { await request('taskReply', { taskId: current.id, decisionId: pending.id, answer: $('#prompt').value.trim(), approved, requestId: crypto.randomUUID() }); await render(); }
  catch (error) { showError(error); }
  finally { $('#approve').disabled = false; $('#deny').disabled = false; }
};
$('#access-form').addEventListener('submit', async event => {
  event.preventDefault(); clearError();
  try {
    const origins = selector => [...new Set($(selector).value.split(/\r?\n/).map(v => v.trim()).filter(Boolean).map(value => {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('请填写完整网站来源，例如 https://example.com。');
      return url.origin;
    }))];
    const blockedOrigins = origins('#blocked-origins'), allowedOrigins = origins('#allowed-origins');
    await request('setAccess', { blockedOrigins, allowedOrigins, confirmActions: $('#confirm-actions').checked });
    $('#allowed-origins').value = allowedOrigins.join('\n');
    $('#blocked-origins').value = blockedOrigins.join('\n'); $('#access-result').textContent = '已保存，当前 Profile 的任务立即采用此设置。';
    await render();
  } catch (error) { showError(error); }
});
for (const name of ['onCreated', 'onRemoved', 'onReplaced', 'onActivated']) chrome.tabs[name]?.addListener(scheduleTabRefresh);
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.url || change.title || change.status) scheduleTabRefresh(); });
chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'session' && changes.nativeTaskContext) void useSavedContext().catch(showError); });
window.addEventListener('focus', () => { scheduleTabRefresh(); void render().catch(showError); });
if (setupId && /^[a-f0-9]{48}$/.test(setupId)) {
  document.body.classList.add('authorization-page');
  invitation = (await chrome.storage.session.get('onboarding:' + setupId))['onboarding:' + setupId];
  if (invitation && invitation.expiresAt > Date.now()) {
    $('#code').value = invitation.code; $('#code').hidden = true;
    $('label[for="code"]').textContent = '请确认：当前 Chrome Profile 是「' + invitation.profileName + '」';
    $('#connect button[type="submit"]').textContent = '连接浏览器服务';
  } else { invitation = undefined; showError(new Error('连接请求已过期，请返回应用重新点击授权并连接。')); }
}
try {
  currentWindowId = (await chrome.windows.getCurrent()).id;
  await render(); await refreshTabs(); await useSavedContext();
} catch (error) { showError(error); }
setInterval(() => void render().catch(showError), 2000);
