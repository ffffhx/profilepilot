const status = document.querySelector('#status');
const setupId = new URLSearchParams(location.hash.slice(1)).get('setup');
let invitation;
let setupError = '';
let browserState;
let currentWindowId;
let tabRefreshVersion = 0;
let tabRefreshTimer;
let renderedTabs = '';
if (setupId && /^[a-f0-9]{48}$/.test(setupId)) {
  document.body.classList.add('authorization-page');
  invitation = (await chrome.storage.session.get(`onboarding:${setupId}`))[`onboarding:${setupId}`];
  if (invitation && invitation.expiresAt > Date.now()) {
    document.querySelector('#code').value = invitation.code;
    document.querySelector('#code').hidden = true;
    document.querySelector('label[for="code"]').textContent = `请确认：当前 Chrome Profile 是「${invitation.profileName}」`;
    document.querySelector('#connect button[type="submit"]').textContent = '授权并连接此 Profile';
  } else {
    invitation = undefined;
    setupError = '连接请求已过期，请返回应用重新点击授权并连接。';
  }
}
async function request(method, data = {}) {
  const result = await chrome.runtime.sendMessage({ method, ...data });
  if (result.error) throw new Error(result.error); return result.result;
}
async function render() {
  const state = await request('state');
  browserState = state;
  document.querySelector('#connect').hidden = Boolean(state.profileId) && !invitation;
  document.querySelector('#controls').hidden = !state.profileId || Boolean(invitation);
  document.querySelector('#takeover').disabled = !state.sessionId || state.ownership !== 'agent';
  document.querySelector('#return').disabled = !state.sessionId || state.ownership !== 'user' || !state.connected;
  document.querySelector('#select-tab').disabled = !state.sessionId || state.ownership === 'agent' || !document.querySelector('#next-tab').value;
  status.textContent = setupError || state.connectionError || (invitation ? '配对已自动准备，请确认并连接当前 Profile。任务会自动新开标签页。' : state.connected ? `已连接 ${state.profileId} · ${state.sessionId ? state.ownership === 'agent' ? 'Agent 操作中' : '由你操作' : '等待任务'}\n${state.sessionId ? state.tabTitle || '继续任务时将新开标签页' : '新任务会自动新开标签页，无需手动选择'}` : state.profileId ? '应用未连接，请打开 ProfilePilot；连接会自动恢复。' : '尚未配对');
}
document.querySelector('#connect').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (invitation && invitation.expiresAt <= Date.now()) throw new Error('连接请求已过期，请返回应用重新授权。');
    await request('connect', { code: document.querySelector('#code').value.trim() });
    if (setupId) await chrome.storage.session.remove(`onboarding:${setupId}`);
    invitation = undefined; document.querySelector('#code').value = ''; await render();
  }
  catch (e) { status.textContent = e.message; }
});
for (const id of ['reconnect', 'takeover', 'return', 'disconnect']) document.querySelector(`#${id}`).onclick = async () => {
  try { await request(id); await render(); } catch (e) { status.textContent = e.message; }
};
document.querySelector('#select-tab').onclick = async () => {
  try { await request('selectTab', { tabId: document.querySelector('#next-tab').value }); await render(); }
  catch (e) { status.textContent = e.message; }
};
async function refreshTabs() {
  const version = ++tabRefreshVersion;
  const tabs = (await chrome.tabs.query({})).filter(t => !t.incognito && /^https?:\/\//.test(t.url || '') && !/^http:\/\/127\.0\.0\.1:[0-9]+\/profilepilot-connect\//.test(t.url || ''));
  if (version !== tabRefreshVersion) return;
  const signature = JSON.stringify(tabs.map(t => [t.id, t.title, t.url, t.windowId]));
  if (signature === renderedTabs) return;
  const firstRender = !renderedTabs;
  renderedTabs = signature;
  for (const selector of ['#next-tab']) {
    const select = document.querySelector(selector);
    const previous = select.value;
    const preferred = selector === '#next-tab' && browserState?.tabId
      ? browserState.tabId : tabs.find(t => t.active && t.windowId === currentWindowId)?.id;
    const selected = previous || (firstRender && preferred ? String(preferred) : '');
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = tabs.length ? '请选择网页标签页' : '请先打开一个网页标签页'; placeholder.disabled = true;
    const options = tabs.map(tab => {
      const option = document.createElement('option');
      option.value = String(tab.id);
      option.textContent = `${tab.title || tab.url} — ${new URL(tab.url).hostname}${tab.windowId === currentWindowId ? '（当前窗口）' : ''}`;
      return option;
    });
    select.replaceChildren(placeholder, ...options);
    // Keep the user's choice across updates. A removed tab requires a new choice.
    select.value = tabs.some(t => String(t.id) === selected) ? selected : '';
  }
  document.querySelector('#select-tab').disabled = !browserState?.sessionId || browserState.ownership === 'agent' || !document.querySelector('#next-tab').value;
}
function scheduleTabRefresh() {
  clearTimeout(tabRefreshTimer);
  tabRefreshTimer = setTimeout(() => void refreshTabs().catch(error => { status.textContent = error.message; }), 100);
}
chrome.tabs.onCreated.addListener(scheduleTabRefresh);
chrome.tabs.onRemoved.addListener(scheduleTabRefresh);
chrome.tabs.onReplaced.addListener(scheduleTabRefresh);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.title || change.status) scheduleTabRefresh();
});
window.addEventListener('focus', scheduleTabRefresh);
document.querySelector('#next-tab').addEventListener('change', () => {
  document.querySelector('#select-tab').disabled = !browserState?.sessionId || browserState.ownership === 'agent' || !document.querySelector('#next-tab').value;
});
currentWindowId = (await chrome.windows.getCurrent()).id;
await render();
await refreshTabs();
setInterval(() => void render().catch(() => {}), 2000);
