export function agentOverlayBootstrapScript(): string {
  return String.raw`(() => {
  if (window.__ppAgentOverlayInstalled) {
    return;
  }
  window.__ppAgentOverlayInstalled = true;

  const SIGNAL_NAME = "__ppAgentOverlaySignal";
  const STORAGE_KEY = "__ppAgentOverlayPosition";
  const state = {
    state: "active",
    agent: "",
    project: "",
    session: "",
    sessionTitle: "",
    currentAction: "",
    currentStep: "",
    nextStep: "",
    todoDone: null,
    todoTotal: null,
    lastMessage: ""
  };
  let collapsed = false;
  let takenOverTimer = null;
  let host = null;
  let root = null;
  let panel = null;
  let dot = null;
  let title = null;
  let meta = null;
  let action = null;
  let progress = null;
  let next = null;
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
      // sessionStorage 可能被禁用。
    }

    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = [
      "<style>",
      ":host{all:initial}",
      "*{box-sizing:border-box}",
      ".wrap{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f4fff9;user-select:none}",
      ".panel{width:min(320px,calc(100vw - 24px));border:1px solid rgba(148,255,213,.28);border-radius:14px;background:rgba(8,13,16,.82);backdrop-filter:blur(16px) saturate(1.35);box-shadow:0 18px 50px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.04) inset;overflow:hidden}",
      ".panel.taken{border-color:rgba(86,240,170,.55);background:rgba(6,27,19,.86)}",
      ".head{display:flex;align-items:center;gap:8px;min-height:38px;padding:9px 10px 7px 12px;cursor:grab}",
      ".head:active{cursor:grabbing}",
      ".pulse{width:9px;height:9px;border-radius:99px;background:#38e1a0;box-shadow:0 0 0 0 rgba(56,225,160,.55);animation:ppPulse 1.45s ease-out infinite;flex:0 0 auto}",
      ".taken .pulse{background:#66f0b2}",
      ".title{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:780;letter-spacing:0}",
      ".hide{width:26px;height:24px;border:0;border-radius:7px;background:rgba(255,255,255,.07);color:#d7fff1;font-size:18px;line-height:20px;cursor:pointer}",
      ".hide:hover{background:rgba(255,255,255,.13)}",
      ".body{padding:0 12px 12px}",
      ".meta{margin:0 0 7px 17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9bb7ad;font-size:11px}",
      ".action{margin:0 0 9px;padding:8px 9px;border-radius:8px;background:rgba(255,255,255,.06);font-size:12.5px;line-height:1.35;overflow-wrap:anywhere}",
      ".progress{margin:0 0 3px;color:#effff8;font-size:12px;font-weight:680;line-height:1.35;overflow-wrap:anywhere}",
      ".next{margin:0 0 8px;color:#9bb7ad;font-size:11.5px;line-height:1.35;overflow-wrap:anywhere}",
      "details{margin:0 0 10px;color:#a9c7bd;font-size:11.5px;line-height:1.4}",
      "summary{cursor:pointer;color:#c9fff0;font-weight:650}",
      ".recent-text{display:block;margin-top:4px;overflow-wrap:anywhere}",
      ".stop{width:100%;min-height:34px;border:1px solid rgba(255,113,100,.55);border-radius:9px;background:linear-gradient(180deg,rgba(255,113,100,.24),rgba(255,113,100,.11));color:#ffe2de;font-size:12px;font-weight:780;cursor:pointer}",
      ".stop:hover:not(:disabled){background:rgba(255,113,100,.27)}",
      ".stop:disabled{opacity:.55;cursor:default}",
      ".dot{display:none;width:36px;height:36px;border:1px solid rgba(148,255,213,.34);border-radius:99px;background:rgba(8,13,16,.84);backdrop-filter:blur(14px);box-shadow:0 12px 34px rgba(0,0,0,.42);cursor:pointer;place-items:center}",
      ".dot .pulse{width:11px;height:11px}",
      ".collapsed .panel{display:none}",
      ".collapsed .dot{display:grid}",
      "@keyframes ppPulse{0%{box-shadow:0 0 0 0 rgba(56,225,160,.58)}70%{box-shadow:0 0 0 9px rgba(56,225,160,0)}100%{box-shadow:0 0 0 0 rgba(56,225,160,0)}}",
      "</style>",
      "<div class=\"wrap\">",
      "  <section class=\"panel\">",
      "    <div class=\"head\"><span class=\"pulse\"></span><span class=\"title\"></span><button class=\"hide\" type=\"button\" title=\"隐藏\">−</button></div>",
      "    <div class=\"body\">",
      "      <div class=\"meta\"></div>",
      "      <div class=\"action\"></div>",
      "      <div class=\"progress\"></div>",
      "      <div class=\"next\"></div>",
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
    action = root.querySelector(".action");
    progress = root.querySelector(".progress");
    next = root.querySelector(".next");
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
    stopButton.addEventListener("click", () => signal("stop"));
    root.querySelector(".head").addEventListener("pointerdown", startDrag);

    document.documentElement.appendChild(host);
    render();
  }

  function signal(action) {
    const binding = window[SIGNAL_NAME];
    if (typeof binding !== "function") {
      return;
    }
    try {
      binding(JSON.stringify({ action, session: state.session || undefined }));
    } catch {
      // 页面或 CDP binding 断开时按钮自然失效。
    }
  }

  function render() {
    if (!host) {
      return;
    }
    const taken = state.state === "takenOver";
    panel.classList.toggle("taken", taken);
    title.textContent = taken ? "✋ 已接管，AI 已停止操作" : "AI 正在操作 · " + (state.agent || "Agent");
    const metaText = [state.project, state.sessionTitle].filter(Boolean).join(" · ");
    meta.textContent = metaText;
    meta.style.display = metaText ? "block" : "none";
    action.textContent = "▸ " + (taken ? "浏览器控制权已交还给你" : state.currentAction || "AI 正在操作浏览器");

    const total = Number(state.todoTotal);
    const done = Number(state.todoDone);
    if (state.currentStep) {
      const index = Number.isFinite(done) && Number.isFinite(total) && total > 0 ? Math.min(done + 1, total) + "/" + total : "";
      progress.textContent = (index ? "第 " + index + " 步：" : "") + state.currentStep;
      progress.style.display = "block";
    } else if (Number.isFinite(total) && total > 0) {
      progress.textContent = Math.max(0, done || 0) + "/" + total + " 已完成";
      progress.style.display = "block";
    } else {
      progress.style.display = "none";
    }
    next.textContent = state.nextStep ? "下一步：" + state.nextStep : "";
    next.style.display = state.nextStep ? "block" : "none";
    recent.style.display = state.lastMessage ? "block" : "none";
    recentText.textContent = state.lastMessage || "";
    stopButton.disabled = taken || typeof window[SIGNAL_NAME] !== "function";
    host.classList.toggle("collapsed", collapsed);
  }

  function collapse() {
    collapsed = true;
    render();
  }

  function expand() {
    collapsed = false;
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
      const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, moveEvent.clientX - offsetX));
      const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, moveEvent.clientY - offsetY));
      host.style.left = left + "px";
      host.style.top = top + "px";
      host.style.right = "auto";
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      try {
        const current = host.getBoundingClientRect();
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ left: current.left, top: current.top }));
      } catch {
        // sessionStorage 可能被禁用。
      }
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }

  window.__ppAgentOverlayUpdate = (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    Object.assign(state, payload);
    if (payload.state === "takenOver") {
      clearTimeout(takenOverTimer);
      takenOverTimer = setTimeout(() => collapse(), 5000);
    }
    render();
  };

  window.__ppAgentOverlayTeardown = () => {
    clearTimeout(takenOverTimer);
    try {
      host && host.remove();
    } catch {
      // 节点可能已被页面移除。
    }
    delete window.__ppAgentOverlayInstalled;
    delete window.__ppAgentOverlayUpdate;
    delete window.__ppAgentOverlayTeardown;
  };

  mount();
})();`;
}
