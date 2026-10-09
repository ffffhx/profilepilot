const $ = selector => document.querySelector(selector);
const setupId = new URLSearchParams(location.hash.slice(1)).get('setup');
let invitation, currentWindowId, polling = false, busy = false, generation = 0;

function showError(error) { $('#error').textContent = error?.message || String(error); $('#error').hidden = false; }
function clearError() { $('#error').hidden = true; }
async function request(method, data = {}) {
  const response = await chrome.runtime.sendMessage({ method, ...data });
  if (!response || response.error) throw new Error(response?.error || '扩展未响应，请重新打开插件。');
  return response.result;
}
function render(state) {
  $('#profile-name').textContent = state.profileName || (state.profileId === 'native:Default' ? '系统默认 Profile' : state.profileId?.replace(/^native:/, '')) || '当前 Profile';
  $('#connection-state').hidden = false;
  $('#connection-label').textContent = state.connected ? '已连接' : state.profileId ? '未连接' : '尚未配对';
  $('#connection-label').className = 'connection-label' + (state.connected ? ' connected' : '');
  $('#connection-note').textContent = state.connectionError || (state.connected ? '浏览器服务正常' : state.profileId ? '打开 ProfilePilot 或运行 CLI 后会自动重连' : '配对后即可连接浏览器服务');
  $('#connect').hidden = Boolean(state.profileId) && !invitation;
  $('#reconnect').hidden = !state.profileId || state.connected || Boolean(invitation);
  $('#controlled-tab').hidden = !state.profileId || Boolean(invitation);

  // The last tab can outlive its session. Only a live control session owns a
  // target; the active Chrome tab and historical conversations are unrelated.
  const hasSession = Boolean(state.connected && state.sessionId);
  const hasTab = hasSession && Number.isSafeInteger(state.tabId) && state.tabId > 0 && Boolean(state.tabTitle || state.url);
  const controlling = hasTab && state.ownership === 'agent' && !state.pausedByBrowser;
  $('#control-state').textContent = !state.connected ? '未连接' : hasTab ? controlling ? '正在控制' : '已暂停' : hasSession ? '等待页面' : '空闲';
  $('#control-state').className = 'control-state' + (controlling ? ' active' : hasTab ? ' paused' : '');
  $('#page-title').textContent = hasTab ? state.tabTitle || (state.url === 'about:blank' ? '空白标签页' : state.url) : !state.connected ? '连接后显示受控标签页' : hasSession ? '当前没有可用的受控标签页' : '当前没有受控标签页';
  let domain = '';
  if (hasTab && state.url) {
    try { domain = new URL(state.url).host || (state.url === 'about:blank' ? '空白页' : ''); } catch { /* No fabricated URL for a closing tab. */ }
  }
  $('#page-domain').textContent = domain;
  $('#page-domain').hidden = !domain;
  $('#page-note').textContent = hasTab ? controlling ? '' : '浏览器操作已暂停' : !state.connected ? '正在等待浏览器服务连接' : hasSession ? '等待 Agent 选择标签页' : 'Agent 开始控制后，标签页会显示在这里';
  $('#page-note').hidden = !$('#page-note').textContent;
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
    if (version === generation) render(state);
  } catch (error) {
    if (version === generation) {
      $('#connection-state').hidden = false;
      $('#connection-label').textContent = '状态暂不可用';
      $('#connection-label').className = 'connection-label';
      $('#connection-note').textContent = error.message;
      $('#controlled-tab').hidden = true;
      $('#status').textContent = '连接状态暂不可用';
    }
  } finally { polling = false; }
}
function setBusy(value) {
  busy = value;
  $('#connect-submit').disabled = value;
  $('#reconnect').disabled = value;
}
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
  clearError(); setBusy(true); generation++;
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
