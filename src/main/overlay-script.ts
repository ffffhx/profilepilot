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
  const OVERLAY_TEXT = {
    zh: {
      revealTitle: "在 ProfilePilot 中查看",
      hideTitle: "隐藏",
      expandTitle: "展开 AI 操作状态",
      sessionHeading: "会话",
      recentSummary: "AI 最近说",
      takenTitle: "✋ 已接管，AI 已停止操作",
      operatingPrefix: "AI 正在操作 · ",
      sessionsSuffix: " 个会话",
      actionPrefix: "▸ ",
      takenAction: "浏览器控制权已交还给你",
      defaultAction: "AI 正在操作浏览器",
      nextPrefix: "下一步：",
      stepLabel: (index) => "第 " + index + " 步：",
      progressDone: (done, total) => done + "/" + total + " 已完成",
      unnamedSession: "未命名会话",
      unknownActivity: "活动未知",
      elapsedPrefix: "已运行 ",
      takenStop: "已接管",
      confirmStop: "再点一次确认接管",
      stopSingle: "⏹ 停止并接管",
      stopAll: "⏹ 全部停止并接管",
      duration: (ms) => {
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
      },
      relativeTime: (ts) => {
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
        return new Date(ts).toLocaleDateString("zh-CN");
      }
    },
    en: {
      revealTitle: "Open in ProfilePilot",
      hideTitle: "Hide",
      expandTitle: "Expand AI status",
      sessionHeading: "Sessions",
      recentSummary: "What AI said",
      takenTitle: "✋ Taken over — AI stopped",
      operatingPrefix: "AI is operating · ",
      sessionsSuffix: " sessions",
      actionPrefix: "▸ ",
      takenAction: "browser control returned to you",
      defaultAction: "AI is operating",
      nextPrefix: "Next: ",
      stepLabel: (index) => "Step " + index + ": ",
      progressDone: (done, total) => done + "/" + total + " completed",
      unnamedSession: "Untitled session",
      unknownActivity: "Activity unknown",
      elapsedPrefix: "Running for ",
      takenStop: "Taken over",
      confirmStop: "Click again to confirm",
      stopSingle: "⏹ Stop & take over",
      stopAll: "⏹ Stop all & take over",
      duration: (ms) => {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (minutes > 0) {
          return minutes + "m " + seconds + "s";
        }
        return seconds + "s";
      },
      relativeTime: (ts) => {
        const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (seconds < 15) {
          return "just now";
        }
        if (seconds < 60) {
          return seconds + "s ago";
        }
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) {
          return minutes + "m ago";
        }
        const hours = Math.floor(minutes / 60);
        if (hours < 24) {
          return hours + "h ago";
        }
        return new Date(ts).toLocaleDateString("en-US");
      }
    }
  };
  const STATE_DEFAULTS = {
    locale: "",
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
  const KNOWN_STATE_FIELDS = Object.keys(STATE_DEFAULTS);
  const STRING_STATE_FIELDS = new Set([
    "profileName",
    "agent",
    "project",
    "session",
    "sessionTitle",
    "currentAction",
    "currentStep",
    "nextStep",
    "lastMessage",
    "updatedAt",
    "startedAt"
  ]);
  const state = cloneStateDefaults();
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
  let sessionHeading = null;
  let sessionList = null;
  let recent = null;
  let recentSummary = null;
  let recentText = null;
  let stopButton = null;
  let revealButton = null;
  let hideButton = null;
  let themeMediaQuery = null;
  let themeMediaListener = null;
  let themeObserver = null;
  let themeUpdateTimer = null;

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
      ".wrap{--pp-text:#f4fff9;--pp-title:#f1fff8;--pp-muted:#a6c1b8;--pp-muted-soft:#7fa89a;--pp-panel-bg:rgba(8,13,16,.84);--pp-panel-border:rgba(148,255,213,.30);--pp-panel-shadow:0 18px 50px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.04) inset;--pp-panel-hover-shadow:0 20px 56px rgba(0,0,0,.46),0 0 0 1px rgba(255,255,255,.06) inset;--pp-taken-bg:rgba(6,27,19,.88);--pp-taken-border:rgba(86,240,170,.58);--pp-control-bg:rgba(255,255,255,.07);--pp-control-hover-bg:rgba(255,255,255,.14);--pp-control-text:#d7fff1;--pp-control-hover-text:#ffffff;--pp-action-bg:rgba(255,255,255,.06);--pp-action-text:#f7fffb;--pp-progress-text:#effff8;--pp-progress-bg:rgba(148,255,213,.13);--pp-next:#9bb7ad;--pp-sessions-bg:rgba(255,255,255,.045);--pp-sessions-border:rgba(255,255,255,.055);--pp-session-heading:#c8fff0;--pp-session-row:#afcac1;--pp-session-agent:#eafff8;--pp-session-name:#bdd7cf;--pp-session-time:#78a292;--pp-details:#a9c7bd;--pp-summary:#c9fff0;--pp-summary-hover:#ffffff;--pp-dot-bg:rgba(8,13,16,.86);--pp-dot-hover-bg:rgba(12,22,24,.92);--pp-dot-border:rgba(148,255,213,.36);--pp-dot-hover-border:rgba(148,255,213,.55);--pp-dot-shadow:0 12px 34px rgba(0,0,0,.42);--pp-stop-text:#ffe2de;--pp-stop-hover-text:#fff2ef;--pp-stop-confirm-text:#fff1dc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--pp-text);user-select:none;opacity:0;transform:translateY(-4px) scale(.985);animation:ppIn .18s ease-out forwards}",
      ":host(.theme-light) .wrap{--pp-text:#173128;--pp-title:#0d241c;--pp-muted:#49635a;--pp-muted-soft:#667d74;--pp-panel-bg:rgba(255,255,255,.82);--pp-panel-border:rgba(34,139,101,.30);--pp-panel-shadow:0 18px 50px rgba(20,41,34,.20),0 0 0 1px rgba(255,255,255,.55) inset;--pp-panel-hover-shadow:0 20px 56px rgba(20,41,34,.24),0 0 0 1px rgba(255,255,255,.70) inset;--pp-taken-bg:rgba(235,255,247,.86);--pp-taken-border:rgba(42,176,123,.46);--pp-control-bg:rgba(13,48,36,.08);--pp-control-hover-bg:rgba(13,48,36,.14);--pp-control-text:#14583d;--pp-control-hover-text:#083624;--pp-action-bg:rgba(22,92,67,.08);--pp-action-text:#102f25;--pp-progress-text:#173128;--pp-progress-bg:rgba(33,143,103,.16);--pp-next:#506b61;--pp-sessions-bg:rgba(20,91,66,.06);--pp-sessions-border:rgba(20,91,66,.14);--pp-session-heading:#135a3e;--pp-session-row:#516b62;--pp-session-agent:#123f2d;--pp-session-name:#39594e;--pp-session-time:#61786f;--pp-details:#536d63;--pp-summary:#145a40;--pp-summary-hover:#06351f;--pp-dot-bg:rgba(255,255,255,.82);--pp-dot-hover-bg:rgba(244,255,250,.92);--pp-dot-border:rgba(34,139,101,.32);--pp-dot-hover-border:rgba(34,139,101,.52);--pp-dot-shadow:0 12px 34px rgba(20,41,34,.20);--pp-stop-text:#8f2119;--pp-stop-hover-text:#68140f;--pp-stop-confirm-text:#74420d}",
      ".panel{width:min(336px,calc(100vw - 24px));border:1px solid var(--pp-panel-border);border-radius:14px;background:var(--pp-panel-bg);backdrop-filter:blur(18px) saturate(1.35);box-shadow:var(--pp-panel-shadow);overflow:hidden;transition:border-color .18s ease,background .18s ease,box-shadow .18s ease,transform .18s ease}",
      ".panel:hover{box-shadow:var(--pp-panel-hover-shadow)}",
      ".panel.taken{border-color:var(--pp-taken-border);background:var(--pp-taken-bg);transform:translateY(1px)}",
      ".head{display:flex;align-items:center;gap:9px;min-height:40px;padding:10px 10px 8px 12px;cursor:grab}",
      ".head:active{cursor:grabbing}",
      ".pulse{width:9px;height:9px;border-radius:99px;background:#38e1a0;box-shadow:0 0 0 0 rgba(56,225,160,.55);animation:ppPulse 1.45s ease-out infinite;flex:0 0 auto}",
      ".taken .pulse{background:#66f0b2}",
      ".title{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:760;letter-spacing:0;color:var(--pp-title)}",
      ".icon-btn{width:26px;height:24px;border:0;border-radius:7px;background:var(--pp-control-bg);color:var(--pp-control-text);font-size:16px;line-height:20px;cursor:pointer;transition:background .14s ease,color .14s ease,transform .14s ease}",
      ".icon-btn:hover{background:var(--pp-control-hover-bg);color:var(--pp-control-hover-text)}",
      ".icon-btn:active{transform:translateY(1px)}",
      ".hide{font-size:18px}",
      ".body{padding:0 12px 12px}",
      ".meta{margin:0 0 4px 18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pp-muted);font-size:11px;line-height:1.3}",
      ".elapsed{margin:0 0 8px 18px;color:var(--pp-muted-soft);font-size:10.5px;line-height:1.2;font-variant-numeric:tabular-nums}",
      ".action{margin:0 0 9px;padding:8px 9px;border-radius:8px;background:var(--pp-action-bg);font-size:12.5px;line-height:1.35;overflow-wrap:anywhere;color:var(--pp-action-text)}",
      ".progress-text{margin:0 0 5px;color:var(--pp-progress-text);font-size:12px;font-weight:680;line-height:1.35;overflow-wrap:anywhere}",
      ".progress-bar{height:3px;margin:0 0 8px;border-radius:99px;background:var(--pp-progress-bg);overflow:hidden}",
      ".progress-fill{display:block;width:0;height:100%;border-radius:99px;background:linear-gradient(90deg,#35d892,#86ffd2);box-shadow:0 0 12px rgba(56,225,160,.55);transition:width .32s ease}",
      ".next{margin:0 0 9px;color:var(--pp-next);font-size:11.5px;line-height:1.35;overflow-wrap:anywhere}",
      ".sessions{margin:0 0 10px;padding:7px 8px;border-radius:8px;background:var(--pp-sessions-bg);border:1px solid var(--pp-sessions-border)}",
      ".session-heading{margin:0 0 5px;color:var(--pp-session-heading);font-size:11px;font-weight:700}",
      ".session-list{display:grid;gap:5px}",
      ".session-row{display:grid;grid-template-columns:minmax(52px,.55fr) minmax(0,1fr) auto;gap:6px;align-items:center;min-height:20px;color:var(--pp-session-row);font-size:10.5px;line-height:1.25}",
      ".session-agent{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pp-session-agent);font-weight:680}",
      ".session-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pp-session-name)}",
      ".session-time{white-space:nowrap;color:var(--pp-session-time);font-variant-numeric:tabular-nums}",
      "details{margin:0 0 10px;color:var(--pp-details);font-size:11.5px;line-height:1.4}",
      "summary{cursor:pointer;color:var(--pp-summary);font-weight:650;outline:none}",
      "summary:hover{color:var(--pp-summary-hover)}",
      ".recent-text{display:block;margin-top:4px;overflow-wrap:anywhere}",
      ".stop{width:100%;min-height:34px;border:1px solid rgba(255,113,100,.58);border-radius:9px;background:linear-gradient(180deg,rgba(255,113,100,.24),rgba(255,113,100,.11));color:var(--pp-stop-text);font-size:12px;font-weight:780;cursor:pointer;transition:background .14s ease,border-color .14s ease,color .14s ease,transform .14s ease}",
      ".stop:hover:not(:disabled){background:rgba(255,113,100,.28);border-color:rgba(255,135,123,.70);color:var(--pp-stop-hover-text)}",
      ".stop:active:not(:disabled){transform:translateY(1px)}",
      ".stop.confirm{background:linear-gradient(180deg,rgba(255,171,92,.27),rgba(255,171,92,.13));border-color:rgba(255,188,112,.68);color:var(--pp-stop-confirm-text)}",
      ".stop:disabled{opacity:.56;cursor:default;transform:none}",
      ".dot{display:none;width:36px;height:36px;border:1px solid var(--pp-dot-border);border-radius:99px;background:var(--pp-dot-bg);backdrop-filter:blur(14px);box-shadow:var(--pp-dot-shadow);cursor:pointer;place-items:center;transition:background .14s ease,border-color .14s ease,transform .14s ease}",
      ".dot:hover{background:var(--pp-dot-hover-bg);border-color:var(--pp-dot-hover-border);transform:translateY(-1px)}",
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
      "    <div class=\"head\"><span class=\"pulse\"></span><span class=\"title\"></span><button class=\"icon-btn reveal\" type=\"button\" title=\"\">⧉</button><button class=\"icon-btn hide\" type=\"button\" title=\"\">−</button></div>",
      "    <div class=\"body\">",
      "      <div class=\"meta\"></div>",
      "      <div class=\"elapsed\"></div>",
      "      <div class=\"action\"></div>",
      "      <div class=\"progress-text\"></div>",
      "      <div class=\"progress-bar\"><span class=\"progress-fill\"></span></div>",
      "      <div class=\"next\"></div>",
      "      <div class=\"sessions\"><div class=\"session-heading\"></div><div class=\"session-list\"></div></div>",
      "      <details class=\"recent\"><summary></summary><span class=\"recent-text\"></span></details>",
      "      <button class=\"stop\" type=\"button\"></button>",
      "    </div>",
      "  </section>",
      "  <button class=\"dot\" type=\"button\" title=\"\"><span class=\"pulse\"></span></button>",
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
    sessionHeading = root.querySelector(".session-heading");
    sessionList = root.querySelector(".session-list");
    recent = root.querySelector(".recent");
    recentSummary = root.querySelector(".recent summary");
    recentText = root.querySelector(".recent-text");
    stopButton = root.querySelector(".stop");
    revealButton = root.querySelector(".reveal");
    hideButton = root.querySelector(".hide");

    root.addEventListener("click", (event) => event.stopPropagation());
    root.addEventListener("dblclick", (event) => event.stopPropagation());
    root.addEventListener("pointerdown", (event) => event.stopPropagation());
    hideButton.addEventListener("click", () => {
      collapse();
      signal("hide");
    });
    revealButton.addEventListener("click", () => signal("reveal"));
    dot.addEventListener("click", () => expand());
    stopButton.addEventListener("click", handleStopClick);
    root.querySelector(".head").addEventListener("pointerdown", startDrag);

    document.documentElement.appendChild(host);
    setupThemeTracking();
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

  function setupThemeTracking() {
    updateTheme();
    themeMediaListener = () => scheduleThemeUpdate();
    if (typeof window.matchMedia === "function") {
      themeMediaQuery = window.matchMedia("(prefers-color-scheme: light)");
      if (typeof themeMediaQuery.addEventListener === "function") {
        themeMediaQuery.addEventListener("change", themeMediaListener);
      } else if (typeof themeMediaQuery.addListener === "function") {
        themeMediaQuery.addListener(themeMediaListener);
      }
    }
    if (typeof MutationObserver === "function") {
      themeObserver = new MutationObserver(themeMediaListener);
      try {
        themeObserver.observe(document.documentElement, { attributes: true, childList: true, attributeFilter: ["class", "style"] });
        if (document.body) {
          themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
        }
      } catch {
        // Some pages lock down observers; media-query updates still work.
      }
    }
    window.addEventListener("pageshow", themeMediaListener, true);
    window.addEventListener("resize", themeMediaListener);
  }

  function cleanupThemeTracking() {
    if (themeUpdateTimer) {
      clearTimeout(themeUpdateTimer);
      themeUpdateTimer = null;
    }
    if (themeMediaQuery && themeMediaListener) {
      if (typeof themeMediaQuery.removeEventListener === "function") {
        themeMediaQuery.removeEventListener("change", themeMediaListener);
      } else if (typeof themeMediaQuery.removeListener === "function") {
        themeMediaQuery.removeListener(themeMediaListener);
      }
    }
    if (themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
    if (themeMediaListener) {
      window.removeEventListener("pageshow", themeMediaListener, true);
      window.removeEventListener("resize", themeMediaListener);
    }
    themeMediaQuery = null;
    themeMediaListener = null;
  }

  function scheduleThemeUpdate() {
    if (themeUpdateTimer) {
      clearTimeout(themeUpdateTimer);
    }
    themeUpdateTimer = setTimeout(() => {
      themeUpdateTimer = null;
      updateTheme();
    }, 40);
  }

  function updateTheme() {
    if (!host) {
      return;
    }
    const light = isLightEnvironment();
    host.classList.toggle("theme-light", light);
    host.style.colorScheme = light ? "light" : "dark";
  }

  function isLightEnvironment() {
    const prefersLight = themeMediaQuery
      ? themeMediaQuery.matches
      : typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;
    const brightness = pageBackgroundBrightness();
    if (brightness === null) {
      return Boolean(prefersLight);
    }
    if (brightness >= 0.72) {
      return true;
    }
    if (brightness <= 0.42) {
      return false;
    }
    return Boolean(prefersLight);
  }

  function pageBackgroundBrightness() {
    const elements = [document.body, document.documentElement].filter(Boolean);
    for (const element of elements) {
      const style = window.getComputedStyle(element);
      const color = parseCssColor(style.backgroundColor);
      if (color) {
        return colorBrightness(color);
      }
    }
    return null;
  }

  function parseCssColor(value) {
    if (!value || value === "transparent") {
      return null;
    }
    const match = value.match(/rgba?\(([^)]+)\)/i);
    if (!match) {
      return null;
    }
    const parts = match[1]
      .trim()
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((part) => Number.parseFloat(part));
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) {
      return null;
    }
    const alpha = Number.isFinite(parts[3]) ? parts[3] : 1;
    if (alpha <= 0.15) {
      return null;
    }
    return {
      r: clampColorByte(parts[0]),
      g: clampColorByte(parts[1]),
      b: clampColorByte(parts[2])
    };
  }

  function clampColorByte(value) {
    return Math.max(0, Math.min(255, value));
  }

  function colorBrightness(color) {
    const r = linearRgb(color.r / 255);
    const g = linearRgb(color.g / 255);
    const b = linearRgb(color.b / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function linearRgb(channel) {
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  }

  function render() {
    if (!host || !panel) {
      return;
    }
    const copy = text();
    const taken = state.state === "takenOver";
    const sessions = normalizedSessions();
    applyStaticText(copy);
    panel.classList.toggle("taken", taken);
    title.textContent = taken ? copy.takenTitle : titleText(sessions, copy);
    const metaText = [state.project, state.sessionTitle].filter(Boolean).join(" · ");
    meta.textContent = metaText;
    meta.style.display = metaText ? "block" : "none";
    action.textContent = copy.actionPrefix + (taken ? copy.takenAction : currentActionText(copy));

    renderProgress();
    next.textContent = state.nextStep ? copy.nextPrefix + state.nextStep : "";
    next.style.display = state.nextStep ? "block" : "none";
    renderSessionList();
    recent.style.display = state.lastMessage ? "block" : "none";
    recentText.textContent = state.lastMessage || "";
    updateElapsed();
    updateStopButton();
    host.classList.toggle("collapsed", collapsed);
    requestAnimationFrame(clampHostIntoViewport);
  }

  function applyStaticText(copy) {
    revealButton.title = copy.revealTitle;
    hideButton.title = copy.hideTitle;
    dot.title = copy.expandTitle;
    sessionHeading.textContent = copy.sessionHeading;
    recentSummary.textContent = copy.recentSummary;
  }

  function titleText(sessions, copy) {
    if (sessions.length >= 2) {
      return copy.operatingPrefix + sessions.length + copy.sessionsSuffix;
    }
    return copy.operatingPrefix + (state.agent || sessions[0]?.agent || "Agent");
  }

  function currentActionText(copy) {
    if (!state.currentAction || state.currentAction === OVERLAY_TEXT.zh.defaultAction || state.currentAction === OVERLAY_TEXT.en.defaultAction) {
      return copy.defaultAction;
    }
    return state.currentAction;
  }

  function renderProgress() {
    const copy = text();
    const total = finiteNumber(state.todoTotal);
    const done = finiteNumber(state.todoDone);
    const hasTodo = done !== null && total !== null && total > 0;
    if (state.currentStep) {
      const index = hasTodo ? Math.min(done + 1, total) + "/" + total : "";
      progressText.textContent = (index ? copy.stepLabel(index) : "") + state.currentStep;
      progressText.style.display = "block";
    } else if (hasTodo) {
      progressText.textContent = copy.progressDone(Math.max(0, done), total);
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
      name.textContent = item.sessionTitle || item.project || item.session || text().unnamedSession;
      const time = document.createElement("div");
      time.className = "session-time";
      time.textContent = item.lastActive ? formatRelativeTime(item.lastActive) : text().unknownActivity;
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
    elapsed.textContent = text().elapsedPrefix + formatDuration(Date.now() - startedTs);
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
      stopButton.textContent = text().takenStop;
      resetStopConfirm();
      return;
    }
    if (stopConfirming) {
      stopButton.textContent = text().confirmStop;
      return;
    }
    stopButton.textContent = isMultiSession() ? text().stopAll : text().stopSingle;
  }

  function resetStopConfirm() {
    stopConfirming = false;
    clearTimeout(stopConfirmTimer);
    stopConfirmTimer = null;
    if (stopButton) {
      stopButton.classList.remove("confirm");
      if (state.state !== "takenOver") {
        stopButton.textContent = isMultiSession() ? text().stopAll : text().stopSingle;
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
    if (event.target && event.target.closest && event.target.closest("button")) {
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

  function text() {
    return OVERLAY_TEXT[currentLocale()];
  }

  function currentLocale() {
    return normalizeLocale(state.locale) || browserLocale();
  }

  function browserLocale() {
    const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
    return normalizeLocale(languages[0]) || normalizeLocale(navigator.language) || "en";
  }

  function normalizeLocale(value) {
    if (typeof value !== "string") {
      return "";
    }
    const lower = value.toLowerCase();
    return lower.startsWith("zh") ? "zh" : lower.startsWith("en") ? "en" : "";
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function cloneStateDefaults() {
    const result = {};
    for (const key of KNOWN_STATE_FIELDS) {
      result[key] = defaultStateValue(key);
    }
    return result;
  }

  function defaultStateValue(key) {
    const value = STATE_DEFAULTS[key];
    return Array.isArray(value) ? [] : value;
  }

  function normalizeKnownStateValue(key, value) {
    if (value === null || value === undefined) {
      return defaultStateValue(key);
    }
    if (key === "state") {
      return value === "takenOver" ? "takenOver" : "active";
    }
    if (key === "locale") {
      return normalizeLocale(value);
    }
    if (key === "sessions") {
      return Array.isArray(value) ? value : [];
    }
    if (key === "todoDone" || key === "todoTotal") {
      return finiteNumber(value);
    }
    if (STRING_STATE_FIELDS.has(key)) {
      return typeof value === "string" ? value : String(value);
    }
    return value;
  }

  function formatDuration(ms) {
    return text().duration(ms);
  }

  function formatRelativeTime(iso) {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) {
      return text().unknownActivity;
    }
    return text().relativeTime(ts);
  }

  window.__ppAgentOverlayUpdate = (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    for (const key of KNOWN_STATE_FIELDS) {
      state[key] = normalizeKnownStateValue(key, payload[key]);
    }
    if (state.state === "takenOver") {
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
    cleanupThemeTracking();
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
      delete window[SIGNAL_NAME];
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
