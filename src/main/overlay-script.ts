export function agentOverlayBootstrapScript(): string {
  return String.raw`(() => {
  if (window.__ppAgentOverlayInstalled) {
    return;
  }
  window.__ppAgentOverlayInstalled = true;

  const SIGNAL_NAME = "__ppAgentOverlaySignal";
  const STORAGE_KEY = "__ppAgentOverlayPosition";
  const COLLAPSED_KEY = "__ppAgentOverlayCollapsed";
  const STOP_CONFIRM_MS = 3000;
  const state = {
    state: "active",
    profileName: "",
    agent: "",
    project: "",
    session: "",
    sessionTitle: "",
    currentAction: "",
    currentStep: "",
    nextStep: "",
    todoDone: null,
    todoTotal: null,
    lastMessage: "",
    updatedAt: "",
    startedAt: "",
    sessions: []
  };
  let collapsed = readCollapsed();
  let takenOverTimer = null;
  let elapsedTimer = null;
  let stopConfirmTimer = null;
  let stopConfirming = false;
  let tearingDown = false;
  let host = null;
  let root = null;
  let panel = null;
  let dot = null;
  let title = null;
  let meta = null;
  let elapsed = null;
  let action = null;
  let progressText = null;
  let progressBar = null;
  let progressFill = null;
  let next = null;
  let sessionsBlock = null;
  let sessionList = null;
  let recent = null;
  let recentText = null;
  let stopButton = null;

  function mount() {
    if (!document.documentElement) {
      setTimeout(mount, 50);
      return;
    }
    host = document.createElement("div");
    host.id = "__pp-agent-overlay";
    host.setAttribute("aria-hidden", "true");
    host.style.position = "fixed";
    host.style.top = "16px";
    host.style.right = "16px";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "auto";
    host.style.colorScheme = "dark";

    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
        host.style.left = Math.max(8, Math.min(window.innerWidth - 48, saved.left)) + "px";
        host.style.top = Math.max(8, Math.min(window.innerHeight - 48, saved.top)) + "px";
        host.style.right = "auto";
      }
    } catch {
      // sessionStorage may be disabled.
    }

    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = [
      "<style>",
      ":host{all:initial}",
      "*{box-sizing:border-box}",
      ".wrap{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f4fff9;user-select:none;opacity:0;transform:translateY(-4px) scale(.985);animation:ppIn .18s ease-out forwards}",
      ".panel{width:min(336px,calc(100vw - 24px));border:1px solid rgba(148,255,213,.30);border-radius:14px;background:rgba(8,13,16,.84);backdrop-filter:blur(18px) saturate(1.35);box-shadow:0 18px 50px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.04) inset;overflow:hidden;transition:border-color .18s ease,background .18s ease,box-shadow .18s ease,transform .18s ease}",
      ".panel:hover{box-shadow:0 20px 56px rgba(0,0,0,.46),0 0 0 1px rgba(255,255,255,.06) inset}",
      ".panel.taken{border-color:rgba(86,240,170,.58);background:rgba(6,27,19,.88);transform:translateY(1px)}",
      ".head{display:flex;align-items:center;gap:9px;min-height:40px;padding:10px 10px 8px 12px;cursor:grab}",
      ".head:active{cursor:grabbing}",
      ".pulse{width:9px;height:9px;border-radius:99px;background:#38e1a0;box-shadow:0 0 0 0 rgba(56,225,160,.55);animation:ppPulse 1.45s ease-out infinite;flex:0 0 auto}",
      ".taken .pulse{background:#66f0b2}",
      ".title{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:760;letter-spacing:0;color:#f1fff8}",
      ".hide{width:26px;height:24px;border:0;border-radius:7px;background:rgba(255,255,255,.07);color:#d7fff1;font-size:18px;line-height:20px;cursor:pointer;transition:background .14s ease,color .14s ease,transform .14s ease}",
      ".hide:hover{background:rgba(255,255,255,.14);color:#ffffff}",
      ".hide:active{transform:translateY(1px)}",
      ".body{padding:0 12px 12px}",
      ".meta{margin:0 0 4px 18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a6c1b8;font-size:11px;line-height:1.3}",
      ".elapsed{margin:0 0 8px 18px;color:#7fa89a;font-size:10.5px;line-height:1.2;font-variant-numeric:tabular-nums}",
      ".action{margin:0 0 9px;padding:8px 9px;border-radius:8px;background:rgba(255,255,255,.06);font-size:12.5px;line-height:1.35;overflow-wrap:anywhere;color:#f7fffb}",
      ".progress-text{margin:0 0 5px;color:#effff8;font-size:12px;font-weight:680;line-height:1.35;overflow-wrap:anywhere}",
      ".progress-bar{height:3px;margin:0 0 8px;border-radius:99px;background:rgba(148,255,213,.13);overflow:hidden}",
      ".progress-fill{display:block;width:0;height:100%;border-radius:99px;background:linear-gradient(90deg,#35d892,#86ffd2);box-shadow:0 0 12px rgba(56,225,160,.55);transition:width .32s ease}",
      ".next{margin:0 0 9px;color:#9bb7ad;font-size:11.5px;line-height:1.35;overflow-wrap:anywhere}",
      ".sessions{margin:0 0 10px;padding:7px 8px;border-radius:8px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.055)}",
      ".session-heading{margin:0 0 5px;color:#c8fff0;font-size:11px;font-weight:700}",
      ".session-list{display:grid;gap:5px}",
      ".session-row{display:grid;grid-template-columns:minmax(52px,.55fr) minmax(0,1fr) auto;gap:6px;align-items:center;min-height:20px;color:#afcac1;font-size:10.5px;line-height:1.25}",
      ".session-agent{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#eafff8;font-weight:680}",
      ".session-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#bdd7cf}",
      ".session-time{white-space:nowrap;color:#78a292;font-variant-numeric:tabular-nums}",
      "details{margin:0 0 10px;color:#a9c7bd;font-size:11.5px;line-height:1.4}",
      "summary{cursor:pointer;color:#c9fff0;font-weight:650;outline:none}",
      "summary:hover{color:#ffffff}",
      ".recent-text{display:block;margin-top:4px;overflow-wrap:anywhere}",
      ".stop{width:100%;min-height:34px;border:1px solid rgba(255,113,100,.58);border-radius:9px;background:linear-gradient(180deg,rgba(255,113,100,.24),rgba(255,113,100,.11));color:#ffe2de;font-size:12px;font-weight:780;cursor:pointer;transition:background .14s ease,border-color .14s ease,color .14s ease,transform .14s ease}",
      ".stop:hover:not(:disabled){background:rgba(255,113,100,.28);border-color:rgba(255,135,123,.70);color:#fff2ef}",
      ".stop:active:not(:disabled){transform:translateY(1px)}",
      ".stop.confirm{background:linear-gradient(180deg,rgba(255,171,92,.27),rgba(255,171,92,.13));border-color:rgba(255,188,112,.68);color:#fff1dc}",
      ".stop:disabled{opacity:.56;cursor:default;transform:none}",
      ".dot{display:none;width:36px;height:36px;border:1px solid rgba(148,255,213,.36);border-radius:99px;background:rgba(8,13,16,.86);backdrop-filter:blur(14px);box-shadow:0 12px 34px rgba(0,0,0,.42);cursor:pointer;place-items:center;transition:background .14s ease,border-color .14s ease,transform .14s ease}",
      ".dot:hover{background:rgba(12,22,24,.92);border-color:rgba(148,255,213,.55);transform:translateY(-1px)}",
      ".dot .pulse{width:11px;height:11px}",
      ":host(.collapsed) .panel{display:none}",
      ":host(.collapsed) .dot{display:grid}",
      ":host(.leaving) .wrap{animation:ppOut .16s ease-in forwards}",
      "@keyframes ppIn{to{opacity:1;transform:translateY(0) scale(1)}}",
      "@keyframes ppOut{to{opacity:0;transform:translateY(-3px) scale(.985)}}",
      "@keyframes ppPulse{0%{box-shadow:0 0 0 0 rgba(56,225,160,.58)}70%{box-shadow:0 0 0 9px rgba(56,225,160,0)}100%{box-shadow:0 0 0 0 rgba(56,225,160,0)}}",
      "</style>",
      "<div class=\"wrap\">",
      "  <section class=\"panel\">",
      "    <div class=\"head\"><span class=\"pulse\"></span><span class=\"title\"></span><button class=\"hide\" type=\"button\" title=\"隐藏\">−</button></div>",
      "    <div class=\"body\">",
      "      <div class=\"meta\"></div>",
      "      <div class=\"elapsed\"></div>",
      "      <div class=\"action\"></div>",
      "      <div class=\"progress-text\"></div>",
      "      <div class=\"progress-bar\"><span class=\"progress-fill\"></span></div>",
      "      <div class=\"next\"></div>",
      "      <div class=\"sessions\"><div class=\"session-heading\">会话</div><div class=\"session-list\"></div></div>",
      "      <details class=\"recent\"><summary>AI 最近说</summary><span class=\"recent-text\"></span></details>",
      "      <button class=\"stop\" type=\"button\">⏹ 停止并接管</button>",
      "    </div>",
      "  </section>",
      "  <button class=\"dot\" type=\"button\" title=\"展开 AI 操作状态\"><span class=\"pulse\"></span></button>",
      "</div>"
    ].join("");

    panel = root.querySelector(".panel");
    dot = root.querySelector(".dot");
    title = root.querySelector(".title");
    meta = root.querySelector(".meta");
    elapsed = root.querySelector(".elapsed");
    action = root.querySelector(".action");
    progressText = root.querySelector(".progress-text");
    progressBar = root.querySelector(".progress-bar");
    progressFill = root.querySelector(".progress-fill");
    next = root.querySelector(".next");
    sessionsBlock = root.querySelector(".sessions");
    sessionList = root.querySelector(".session-list");
    recent = root.querySelector(".recent");
    recentText = root.querySelector(".recent-text");
    stopButton = root.querySelector(".stop");

    root.addEventListener("click", (event) => event.stopPropagation());
    root.addEventListener("dblclick", (event) => event.stopPropagation());
    root.addEventListener("pointerdown", (event) => event.stopPropagation());
    root.querySelector(".hide").addEventListener("click", () => {
      collapse();
      signal("hide");
    });
    dot.addEventListener("click", () => expand());
    stopButton.addEventListener("click", handleStopClick);
    root.querySelector(".head").addEventListener("pointerdown", startDrag);

    document.documentElement.appendChild(host);
    elapsedTimer = setInterval(() => {
      updateElapsed();
      renderSessionList();
    }, 1000);
    render();
    requestAnimationFrame(clampHostIntoViewport);
  }

  function signal(actionName) {
    const binding = window[SIGNAL_NAME];
    if (typeof binding !== "function") {
      return;
    }
    const payload = { action: actionName };
    if (actionName === "stop" && !isMultiSession() && state.session) {
      payload.session = state.session;
    }
    try {
      binding(JSON.stringify(payload));
    } catch {
      // The page or CDP binding may have disconnected.
    }
  }

  function render() {
    if (!host || !panel) {
      return;
    }
    const taken = state.state === "takenOver";
    const sessions = normalizedSessions();
    panel.classList.toggle("taken", taken);
    title.textContent = taken ? "✋ 已接管，AI 已停止操作" : titleText(sessions);
    const metaText = [state.project, state.sessionTitle].filter(Boolean).join(" · ");
    meta.textContent = metaText;
    meta.style.display = metaText ? "block" : "none";
    action.textContent = "▸ " + (taken ? "浏览器控制权已交还给你" : state.currentAction || "AI 正在操作浏览器");

    renderProgress();
    next.textContent = state.nextStep ? "下一步：" + state.nextStep : "";
    next.style.display = state.nextStep ? "block" : "none";
    renderSessionList();
    recent.style.display = state.lastMessage ? "block" : "none";
    recentText.textContent = state.lastMessage || "";
    updateElapsed();
    updateStopButton();
    host.classList.toggle("collapsed", collapsed);
    requestAnimationFrame(clampHostIntoViewport);
  }

  function titleText(sessions) {
    if (sessions.length >= 2) {
      return "AI 正在操作 · " + sessions.length + " 个会话";
    }
    return "AI 正在操作 · " + (state.agent || sessions[0]?.agent || "Agent");
  }

  function renderProgress() {
    const total = finiteNumber(state.todoTotal);
    const done = finiteNumber(state.todoDone);
    const hasTodo = done !== null && total !== null && total > 0;
    if (state.currentStep) {
      const index = hasTodo ? Math.min(done + 1, total) + "/" + total : "";
      progressText.textContent = (index ? "第 " + index + " 步：" : "") + state.currentStep;
      progressText.style.display = "block";
    } else if (hasTodo) {
      progressText.textContent = Math.max(0, done) + "/" + total + " 已完成";
      progressText.style.display = "block";
    } else {
      progressText.style.display = "none";
    }

    if (hasTodo) {
      const percent = Math.max(0, Math.min(100, Math.round((Math.max(0, Math.min(done, total)) / total) * 100)));
      progressBar.style.display = "block";
      progressFill.style.width = percent + "%";
    } else {
      progressBar.style.display = "none";
      progressFill.style.width = "0%";
    }
  }

  function renderSessionList() {
    if (!sessionList) {
      return;
    }
    const sessions = normalizedSessions();
    sessionsBlock.style.display = sessions.length >= 2 ? "block" : "none";
    if (sessions.length < 2) {
      sessionList.textContent = "";
      return;
    }
    sessionList.textContent = "";
    for (const item of sessions) {
      const row = document.createElement("div");
      row.className = "session-row";
      const agent = document.createElement("div");
      agent.className = "session-agent";
      agent.textContent = item.agent || "Agent";
      const name = document.createElement("div");
      name.className = "session-name";
      name.textContent = item.sessionTitle || item.project || item.session || "未命名会话";
      const time = document.createElement("div");
      time.className = "session-time";
      time.textContent = item.lastActive ? formatRelativeTime(item.lastActive) : "活动未知";
      row.append(agent, name, time);
      sessionList.appendChild(row);
    }
  }

  function updateElapsed() {
    if (!elapsed) {
      return;
    }
    const startedAt = state.startedAt || normalizedSessions()[0]?.startedAt || "";
    const startedTs = Date.parse(startedAt);
    if (!Number.isFinite(startedTs)) {
      elapsed.textContent = "";
      elapsed.style.display = "none";
      return;
    }
    elapsed.textContent = "已运行 " + formatDuration(Date.now() - startedTs);
    elapsed.style.display = "block";
  }

  function handleStopClick() {
    if (stopButton.disabled || state.state === "takenOver") {
      return;
    }
    if (!stopConfirming) {
      stopConfirming = true;
      stopButton.classList.add("confirm");
      updateStopButton();
      clearTimeout(stopConfirmTimer);
      stopConfirmTimer = setTimeout(resetStopConfirm, STOP_CONFIRM_MS);
      return;
    }
    resetStopConfirm();
    signal("stop");
  }

  function updateStopButton() {
    const taken = state.state === "takenOver";
    const hasBinding = typeof window[SIGNAL_NAME] === "function";
    stopButton.disabled = taken || !hasBinding;
    if (taken) {
      stopButton.textContent = "已接管";
      resetStopConfirm();
      return;
    }
    if (stopConfirming) {
      stopButton.textContent = "再点一次确认接管";
      return;
    }
    stopButton.textContent = isMultiSession() ? "⏹ 全部停止并接管" : "⏹ 停止并接管";
  }

  function resetStopConfirm() {
    stopConfirming = false;
    clearTimeout(stopConfirmTimer);
    stopConfirmTimer = null;
    if (stopButton) {
      stopButton.classList.remove("confirm");
      if (state.state !== "takenOver") {
        stopButton.textContent = isMultiSession() ? "⏹ 全部停止并接管" : "⏹ 停止并接管";
      }
    }
  }

  function collapse() {
    collapsed = true;
    persistCollapsed();
    render();
  }

  function expand() {
    collapsed = false;
    persistCollapsed();
    render();
  }

  function startDrag(event) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const rect = host.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const move = (moveEvent) => {
      const nextLeft = moveEvent.clientX - offsetX;
      const nextTop = moveEvent.clientY - offsetY;
      const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, nextLeft));
      const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, nextTop));
      host.style.left = left + "px";
      host.style.top = top + "px";
      host.style.right = "auto";
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      persistPosition();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }

  function persistPosition() {
    try {
      const current = host.getBoundingClientRect();
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ left: current.left, top: current.top }));
    } catch {
      // sessionStorage may be disabled.
    }
  }

  function persistCollapsed() {
    try {
      sessionStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // sessionStorage may be disabled.
    }
  }

  function readCollapsed() {
    try {
      return sessionStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function clampHostIntoViewport() {
    if (!host || host.style.right !== "auto") {
      return;
    }
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left));
    const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, rect.top));
    host.style.left = left + "px";
    host.style.top = top + "px";
  }

  function normalizedSessions() {
    if (!Array.isArray(state.sessions)) {
      return [];
    }
    return state.sessions.filter((item) => item && typeof item === "object");
  }

  function isMultiSession() {
    return normalizedSessions().length >= 2;
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return hours + " 小时 " + minutes + " 分";
    }
    if (minutes > 0) {
      return minutes + " 分 " + seconds + " 秒";
    }
    return seconds + " 秒";
  }

  function formatRelativeTime(iso) {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) {
      return "活动未知";
    }
    const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (seconds < 15) {
      return "刚刚";
    }
    if (seconds < 60) {
      return seconds + " 秒前";
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return minutes + " 分钟前";
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return hours + " 小时前";
    }
    return new Date(ts).toLocaleDateString();
  }

  window.__ppAgentOverlayUpdate = (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    Object.assign(state, payload);
    if (!Array.isArray(state.sessions)) {
      state.sessions = [];
    }
    if (payload.state === "takenOver") {
      resetStopConfirm();
      clearTimeout(takenOverTimer);
      takenOverTimer = setTimeout(() => collapse(), 5000);
    }
    render();
  };

  window.__ppAgentOverlayTeardown = () => {
    if (tearingDown) {
      return;
    }
    tearingDown = true;
    clearTimeout(takenOverTimer);
    clearInterval(elapsedTimer);
    resetStopConfirm();
    const cleanup = () => {
      try {
        host && host.remove();
      } catch {
        // The node may have already been removed by the page.
      }
      delete window.__ppAgentOverlayInstalled;
      delete window.__ppAgentOverlayUpdate;
      delete window.__ppAgentOverlayTeardown;
    };
    if (host) {
      host.classList.add("leaving");
      setTimeout(cleanup, 180);
    } else {
      cleanup();
    }
  };

  mount();
})();`;
}
