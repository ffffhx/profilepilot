// Kept separate from the compiled application bundle so a missing/broken bundle
// leaves a usable recovery screen. No device or browser action is retried here.
(() => {
  const panel = document.getElementById("workspace-startup");
  const status = document.getElementById("workspace-startup-status");
  const retry = document.getElementById("workspace-startup-retry");
  let ready = false;
  let failed = false;
  const fail = reason => {
    if (ready || failed) return;
    failed = true;
    status.textContent = "界面加载未完成。请重新加载界面；如果仍未恢复，可在诊断日志中查看原因。";
    panel.hidden = false;
    retry.hidden = false;
    window.desktopWindow?.reportStartupFailure?.(reason);
  };
  const timer = setTimeout(() => fail("startup-timeout"), 10000);
  window.addEventListener("workspace-shell-ready", () => {
    ready = true;
    clearTimeout(timer);
    panel.hidden = true;
  }, { once: true });
  window.addEventListener("error", event => {
    if (event.target instanceof HTMLScriptElement) fail("script-load");
    else if (event instanceof ErrorEvent) fail("script-error");
  }, true);
  window.addEventListener("unhandledrejection", () => fail("script-error"));
  retry.addEventListener("click", () => {
    if (window.desktopWindow?.reloadWorkspace) window.desktopWindow.reloadWorkspace();
    else status.textContent = "界面连接未就绪，请从托盘菜单选择“重新加载界面”。";
  });
})();
