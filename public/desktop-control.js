// Register in the main world before installing or rendering the controls.
// An absent/malformed script still cannot produce the separate readiness ACK.
const failNotice = () => window.desktopControl?.noticeFailed?.();
window.addEventListener('error', failNotice, { capture: true });
window.addEventListener('unhandledrejection', failNotice);
let statusRevision = 0, disposed = false, controlContext, controlAttempt = 0, returnExpectation;
let handlersInstalled = false, readyGeneration, pendingReady, statusRead;
function acknowledge(state) {
  const generation = state.inputObservation?.generation;
  if (!handlersInstalled || disposed || !generation || !window.desktopControl.noticeReady || readyGeneration === generation || pendingReady === generation) return;
  pendingReady = generation;
  void window.desktopControl.noticeReady(generation).then(() => { if (!disposed) readyGeneration = generation; }, () => {}).finally(() => { if (pendingReady === generation) pendingReady = undefined; });
}
function render(state) {
    const owner = state.session;
    returnExpectation = owner?.state === 'paused' && state.inputObservation?.generation && Number.isSafeInteger(owner.revision) && owner.revision >= 0
      ? { session: owner.name, generation: state.inputObservation.generation, revision: owner.revision } : undefined;
    const context = JSON.stringify([owner?.name, owner?.revision, owner?.state, state.inputObservation?.generation,
      state.inputObservation?.phase, state.inputObservation?.reason]);
    if (context !== controlContext) {
      controlContext = context;
      const error = document.getElementById('control-error');
      error.textContent = ''; error.hidden = true;
    }
    const preparing = state.inputObservation?.phase === 'arming';
    document.getElementById('stop-shortcut').textContent = state.stopShortcutAvailable ? 'Ctrl + Alt + Esc' : '请点击停止按钮';
    document.getElementById('control-state').textContent = !owner ? '已结束' : preparing ? '正在准备控制' : state.inputObservation?.phase === 'pending' ? '等待重新读取窗口' : owner.state === 'active' ? '正在控制' : '已暂停';
    document.getElementById('control-task').textContent = owner ? owner.name + ' · ' + owner.window.title : '';
    const reason = document.getElementById('control-reason');
    reason.textContent = owner?.state === 'paused' ? state.inputObservation?.message || '' : '';
    reason.hidden = !reason.textContent;
    document.getElementById('takeover').hidden = owner?.state !== 'active';
    document.getElementById('return').hidden = preparing || !returnExpectation;
    acknowledge(state);
}
function update() {
  if (disposed) return Promise.resolve();
  // A slow IPC response must not be made stale by every later polling tick.
  // Push notifications still invalidate this read through statusRevision.
  if (statusRead) return statusRead;
  const revision = ++statusRevision;
  statusRead = (async () => {
    try {
      const state = await window.desktopControl.status();
      if (!disposed && revision === statusRevision) render(state);
    } catch { if (!disposed && revision === statusRevision) document.getElementById('control-state').textContent = '连接中断'; }
  })().finally(() => { statusRead = undefined; });
  return statusRead;
}
for (const [id, action] of [['takeover', 'takeover'], ['return', 'return'], ['stop', 'stop']]) {
  const button = document.getElementById(id);
  button.onclick = async () => {
    const expected = returnExpectation;
    if (action === 'return' && !expected) { await update(); return; }
    const error = document.getElementById('control-error');
    const attempt = ++controlAttempt, context = controlContext;
    error.hidden = true; button.disabled = true;
    try {
      if (action === 'return') await window.desktopControl.control(action, expected);
      else await window.desktopControl.control(action);
    }
    catch (cause) {
      if (!disposed && attempt === controlAttempt && context === controlContext) {
        const message = cause instanceof Error ? cause.message : String(cause);
        error.textContent = message.replace(/^(?:Error:\s*)?Error invoking remote method '[^'\r\n]{1,128}':\s*(?:Error:\s*)?/, '');
        error.hidden = false;
      }
    }
    finally { button.disabled = false; await update(); }
  };
}
const unsubscribe = window.desktopControl.onChanged(state => { if (!disposed) { statusRevision++; render(state); } });
handlersInstalled = true;
void update(); const statusTimer = setInterval(update, 500);
window.addEventListener('pagehide', () => { disposed = true; statusRevision++; clearInterval(statusTimer); unsubscribe(); }, { once: true });
