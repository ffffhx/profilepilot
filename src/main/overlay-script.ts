export function agentOverlayBootstrapScript(): string {
  return String.raw`(() => {
  const TERMINAL_STOP_KEY = "__ppAgentOverlayTerminalStopUntil";
  try {
    if (window.top !== window.self) {
      return;
    }
  } catch {
    return;
  }
  try {
    const terminalStopUntil = Number(window.sessionStorage.getItem(TERMINAL_STOP_KEY));
    if (Number.isFinite(terminalStopUntil) && terminalStopUntil > Date.now()) {
      return;
    }
    if (terminalStopUntil) {
      window.sessionStorage.removeItem(TERMINAL_STOP_KEY);
    }
  } catch {
    // Opaque origins may deny sessionStorage; main-process script removal remains authoritative.
  }
  if (window.__ppAgentOverlayInstalled) {
    return;
  }
  window.__ppAgentOverlayInstalled = true;

  const SIGNAL_NAME = "__ppAgentOverlaySignal";
  const STORAGE_KEY = "__ppAgentOverlayPosition";
  const HUD_INSET_PX = 16;
  const HUD_COLLISION_MARGIN_PX = 12;
  const HUD_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
  const HUD_AVOID_EVENT = "__pp-agent-overlay-avoid";
  const STOP_CONFIRM_MS = 3000;
  const HOST_REATTACH_LIMIT = 8;
  const HOST_REATTACH_WINDOW_MS = 10000;
  const HOST_REATTACH_BACKOFF_MS = 3000;
  // ProfilePilot 正常运行时至少每 30 秒校准一次状态。连续错过两轮以上更新，说明
  // CDP / App 已断开；此时必须自行撤掉旧浮层，不能继续伪装成“Agent 操作中”。
  const OVERLAY_HEARTBEAT_TIMEOUT_MS = 75000;
  const OVERLAY_HEARTBEAT_CHECK_MS = 5000;
  // 合成光标 / 点击高亮层：AI 空闲 900ms 后隐藏合成光标，点击涟漪 620ms 后自动回收。
  const CURSOR_IDLE_HIDE_MS = 900;
  const RIPPLE_LIFETIME_MS = 620;
  const OVERLAY_TEXT = {
    zh: {
      active: "Agent 操作中",
      taken: "你已接管",
      needsUser: "等待你操作",
      offline: "Agent 已离线",
      reconnecting: "正在重连",
      handoff: "正在交接",
      error: "操作未完成",
      returnError: "交还失败",
      takenHint: "Agent 已暂停，可自由操作网页",
      activeHint: "接管后可手动操作",
      handoffHint: "正在等待当前操作结束",
      offlineHint: "Agent 已离线，可在更多操作中结束任务",
      reconnectingHint: "正在恢复浏览器连接",
      guardStarting: "正在启用点击保护",
      guardUnavailable: "点击保护未开启，请先接管再操作网页",
      takeover: "接管",
      returnToAgent: "交还",
      stopSingle: "结束任务",
      stopAll: "结束全部",
      confirmStop: "确认结束",
      confirmHint: "再次点击结束任务；返回或按 Esc 取消",
      more: "更多操作",
      back: "返回"
    },
    en: {
      active: "Agent working",
      taken: "You're in control",
      needsUser: "Your action needed",
      offline: "Agent offline",
      reconnecting: "Reconnecting",
      handoff: "Handing over",
      error: "Action failed",
      returnError: "Return failed",
      takenHint: "Agent paused; you can use the page",
      activeHint: "Take over to interact with the page",
      handoffHint: "Waiting for the current action to finish",
      offlineHint: "Agent offline; end the task from More",
      reconnectingHint: "Restoring the browser connection",
      guardStarting: "Starting click protection",
      guardUnavailable: "Click protection is off; take over before using the page",
      // 控制权按钮遵循应用文案，不随被控网页语言改变。
      takeover: "接管",
      returnToAgent: "交还",
      stopSingle: "结束任务",
      stopAll: "结束全部",
      confirmStop: "确认结束",
      confirmHint: "Click again to end; go back or press Esc to cancel",
      more: "更多操作",
      back: "返回"
    }
  };
  const STATE_DEFAULTS = {
    locale: "",
    state: "active",
    ownership: "agent",
    inputGuardState: "starting",
    handoffPending: false,
    pendingUserAction: "",
    agentOffline: false,
    driverReconnecting: false,
    controlSince: "",
    agentTargetId: "",
    agentTargetTitle: "",
    agentTargetUrl: "",
    agentTargetDomain: "",
    agentTargetIsCurrentPage: false,
    autoFollowAgent: false,
    targetActivationPending: false,
    profileName: "",
    agent: "",
    project: "",
    branch: "",
    session: "",
    sessionTitle: "",
    currentAction: "",
    targetUrl: "",
    currentStep: "",
    nextStep: "",
    todoDone: null,
    todoTotal: null,
    lastMessage: "",
    updatedAt: "",
    startedAt: "",
    sessions: [],
    stopError: ""
  };
  const KNOWN_STATE_FIELDS = Object.keys(STATE_DEFAULTS);
  const STRING_STATE_FIELDS = new Set([
    "profileName",
    "agent",
    "project",
    "branch",
    "session",
    "sessionTitle",
    "currentAction",
    "pendingUserAction",
    "targetUrl",
    "currentStep",
    "nextStep",
    "lastMessage",
    "updatedAt",
    "startedAt",
    "controlSince",
    "agentTargetId",
    "agentTargetTitle",
    "agentTargetUrl",
    "agentTargetDomain",
    "stopError",
    "inputGuardState"
  ]);
  const state = cloneStateDefaults();
  let moreOpen = false;
  let hudCorner = readHudCorner();
  let heartbeatTimer = null;
  let lastUpdateReceivedAt = Date.now();
  let stopConfirmTimer = null;
  let stopConfirming = false;
  let tearingDown = false;
  let host = null;
  let root = null;
  let panel = null;
  let statusNode = null;
  let statusIcon = null;
  let title = null;
  let statusDescription = null;
  let takeoverButton = null;
  let stopButton = null;
  let moreButton = null;
  let backButton = null;
  let reducedMotionMediaQuery = null;
  let reducedMotionMediaListener = null;
  let themeMediaQuery = null;
  let themeMediaListener = null;
  let themeObserver = null;
  let themeUpdateTimer = null;
  let hostObserver = null;
  let hostReattachTimer = null;
  let hostReattachAttempts = 0;
  let hostReattachWindowStartedAt = 0;
  let hostReattachBlockedUntil = 0;
  // 合成光标 / 点击高亮层的节点与计时器；agentPointerListener 用于在拆除时摘掉全局监听。
  let cursorLayer = null;
  let agentCursor = null;
  let cursorHideTimer = null;
  let agentPointerListener = null;
  let outsidePointerListener = null;
  let escapeKeyListener = null;
  let hudAvoidListener = null;
  let stopConfirmKind = "";

  function mount() {
    if (tearingDown || host) {
      return;
    }
    if (!document.documentElement) {
      setTimeout(mount, 50);
      return;
    }
    host = document.createElement("div");
    host.id = "__pp-agent-overlay";
    host.setAttribute("data-pp-ui", "hud");
    // Keep the overlay hidden from agent accessibility snapshots. This also hides
    // it from screen readers, so every critical control still carries title and
    // aria-label text for the least-bad default if that policy changes later.
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("role", "presentation");
    host.classList.toggle("reduced-motion", isReducedMotionPreferred());

    root = host.attachShadow({ mode: "closed" });
    const styleText = [
      ":host{all:initial;position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;color-scheme:dark}",
      ":host(.theme-light){color-scheme:light}",
      "*{box-sizing:border-box} [hidden]{display:none!important}",
      ".wrap{--pp-bg:#242628;--pp-text:#f1f3f2;--pp-muted:#a7adaa;--pp-border:#3c4041;--pp-hover:#333738;--pp-danger:#ff8d88;--pp-focus:#91c8ac;--pp-shadow:0 6px 24px rgba(0,0,0,.18);font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei','PingFang SC',sans-serif;color:var(--pp-text);user-select:none}",
      ":host(.theme-light) .wrap{--pp-bg:#fff;--pp-text:#252827;--pp-muted:#6f7572;--pp-border:#e0e3e1;--pp-hover:#f2f4f3;--pp-danger:#bd453f;--pp-focus:#397659;--pp-shadow:0 6px 24px rgba(24,32,28,.09)}",
      ".panel{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;gap:0;width:min(340px,calc(100vw - 32px));height:44px;padding:0 8px 0 16px;border:1px solid var(--pp-border);border-radius:14px;background:var(--pp-bg);box-shadow:var(--pp-shadow);pointer-events:auto;overflow:hidden}",
      ".status{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding-right:8px;height:100%}",
      ".status-icon{display:grid;place-items:center;width:18px;height:18px;flex:none;color:var(--pp-muted)}",
      ".status-icon[data-icon=dot]::before{content:'';width:8px;height:8px;border-radius:50%;background:#20c55a}",
      ":host(.attention) .status-icon[data-icon=dot]::before{background:#e7a51a}",
      ":host(.offline) .status-icon[data-icon=dot]::before{background:var(--pp-muted)}",
      ":host(.has-error) .status-icon{color:var(--pp-danger)}",
      ".title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600;letter-spacing:0}",
      "button{appearance:none;font:inherit;color:inherit;border:0;background:none;cursor:pointer;margin:0;white-space:nowrap;touch-action:manipulation}",
      ".control{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:32px;border-radius:8px;padding:0 10px;flex:none;transition:background .14s ease,color .14s ease}",
      ".control:hover{background:var(--pp-hover)} .control:focus-visible{outline:2px solid var(--pp-focus);outline-offset:-2px}",
      ".control:disabled{opacity:.45;cursor:default;background:none}",
      ".takeover,.back{position:relative;margin-left:9px;min-width:78px}",
      ".takeover::before,.back::before{content:'';position:absolute;left:-9px;top:7px;width:1px;height:18px;background:var(--pp-border)}",
      ".more{width:32px;padding:0;color:var(--pp-muted)}",
      ".stop{flex:1;justify-content:flex-start;color:var(--pp-danger);padding-left:0;font-weight:600}",
      ".stop.confirm{background:var(--pp-hover)}",
      ".control-icon{display:grid;place-items:center;width:18px;height:18px;flex:none} svg{display:block;width:18px;height:18px}",
      ".sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}",
      ":host(.corner-top-left) .panel{left:16px;right:auto;top:16px;bottom:auto}",
      ":host(.corner-top-right) .panel{left:auto;right:16px;top:16px;bottom:auto}",
      ":host(.corner-bottom-left) .panel{left:16px;right:auto;top:auto;bottom:16px}",
      ":host(.corner-bottom-right) .panel{left:auto;right:16px;top:auto;bottom:16px}",
      ".pp-cursor-layer{position:fixed;inset:0;pointer-events:none;z-index:2}",
      ".pp-agent-cursor{position:fixed;left:0;top:0;width:22px;height:22px;opacity:0;pointer-events:none;transition:transform .12s ease,opacity .12s ease;will-change:transform}",
      ".pp-agent-cursor.show{opacity:1} .pp-agent-cursor svg{width:22px;height:22px}",
      ".pp-click-ripple{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:2px solid #38e1a0;background:rgba(56,225,160,.16);animation:ppRipple .58s ease-out forwards}",
      "@keyframes ppRipple{from{transform:scale(.5);opacity:1}to{transform:scale(2.6);opacity:0}}",
      ":host(.reduced-motion) *, :host(.reduced-motion) *::before{animation:none!important;transition:none!important}",
      "@media(max-width:360px){.panel{padding-left:12px}.status{gap:7px}.title{font-size:13px}.control{padding:0 7px}.more{padding:0;width:28px}.takeover,.back{min-width:70px}}"
    ].join("");
    buildOverlayDom(root, styleText);

    panel = root.querySelector(".panel");
    statusNode = root.querySelector(".status");
    statusIcon = root.querySelector(".status-icon");
    title = root.querySelector(".title");
    statusDescription = root.querySelector(".status-description");
    takeoverButton = root.querySelector(".takeover");
    stopButton = root.querySelector(".stop");
    moreButton = root.querySelector(".more");
    backButton = root.querySelector(".back");
    cursorLayer = root.querySelector(".pp-cursor-layer");
    agentCursor = root.querySelector(".pp-agent-cursor");

    root.addEventListener("click", (event) => event.stopPropagation());
    root.addEventListener("dblclick", (event) => event.stopPropagation());
    root.addEventListener("pointerdown", (event) => event.stopPropagation());
    takeoverButton.addEventListener("click", () => handleStopClick("takeover"));
    stopButton.addEventListener("click", () => handleStopClick("stop"));
    moreButton.addEventListener("click", () => setMoreOpen(true));
    backButton.addEventListener("click", () => setMoreOpen(false));
    for (const control of [takeoverButton, stopButton, moreButton, backButton]) {
      control.addEventListener("keydown", handleKeyboardClick);
    }
    agentPointerListener = handleAgentPointer;
    window.addEventListener("pointerdown", agentPointerListener, { capture: true, passive: true });
    outsidePointerListener = handleOutsidePointer;
    escapeKeyListener = handleEscapeKey;
    hudAvoidListener = handleHudAvoidEvent;
    window.addEventListener("pointerdown", outsidePointerListener, { capture: true, passive: true });
    window.addEventListener("keydown", escapeKeyListener, true);
    host.addEventListener(HUD_AVOID_EVENT, hudAvoidListener);

    document.documentElement.appendChild(host);
    applyHudCorner(hudCorner);
    setupHostReconnectTracking();
    setupReducedMotionTracking();
    setupThemeTracking();
    render();
  }

  function startHeartbeat() {
    if (heartbeatTimer || tearingDown) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastUpdateReceivedAt > OVERLAY_HEARTBEAT_TIMEOUT_MS) {
        // 只清理过期 UI，保留 CDP binding；若只是系统休眠或短暂卡顿，下一次
        // ProfilePilot 更新可重新注入浮层并继续使用原控制通道。
        window.__ppAgentOverlayTeardown?.(true);
      }
    }, OVERLAY_HEARTBEAT_CHECK_MS);
  }

  // Gmail 等站点通过 CSP 强制 Trusted Types，任何 innerHTML 字符串赋值都会被浏览器拒绝。
  // 1Password 等站点还会通过 style-src 禁止内联 <style>。优先采用不受该限制的
  // Constructable Stylesheet，并为不支持该能力的旧浏览器保留 <style> 回退。
  function buildOverlayDom(shadowRoot, styleText) {
    let styleInstalled = false;
    if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in shadowRoot) {
      try {
        const styleSheet = new CSSStyleSheet();
        styleSheet.replaceSync(styleText);
        shadowRoot.adoptedStyleSheets = [styleSheet];
        styleInstalled = true;
      } catch {
        // Fall through to the <style> path for older or partially compatible engines.
      }
    }
    if (!styleInstalled) {
      const styleNode = overlayNode("style");
      styleNode.textContent = styleText;
      shadowRoot.append(styleNode);
    }

    const wrapNode = overlayNode("div", "wrap");
    const panelNode = overlayNode("section", "panel", {
      id: "pp-agent-overlay-panel",
      role: "group",
      "aria-labelledby": "pp-agent-overlay-title"
    });
    const status = overlayNode("div", "status", { "aria-describedby": "pp-agent-overlay-status-description" });
    status.append(
      overlayNode("span", "status-icon", { "aria-hidden": "true" }),
      overlayNode("span", "title", { id: "pp-agent-overlay-title", "aria-live": "polite", "aria-atomic": "true" })
    );
    const takeover = controlNode("takeover");
    const more = controlNode("more");
    more.setAttribute("aria-controls", "pp-agent-overlay-panel");
    const stop = controlNode("stop");
    const back = controlNode("back");
    const description = overlayNode("span", "sr-only status-description", { id: "pp-agent-overlay-status-description" });
    panelNode.append(status, takeover, more, stop, back, description);
    wrapNode.append(panelNode);

    // 合成光标层独立于控制条，不接受鼠标事件。
    const cursorLayerNode = overlayNode("div", "pp-cursor-layer", { "aria-hidden": "true" });
    const cursorNode = overlayNode("span", "pp-agent-cursor");
    const svgNode = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgNode.setAttribute("viewBox", "0 0 24 24");
    svgNode.setAttribute("width", "22");
    svgNode.setAttribute("height", "22");
    const pathNode = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathNode.setAttribute("d", "M5 3 L10.5 18 L12.7 11.7 L19 9.5 Z");
    pathNode.setAttribute("fill", "rgba(8,19,15,.92)");
    pathNode.setAttribute("stroke", "#38e1a0");
    pathNode.setAttribute("stroke-width", "1.5");
    pathNode.setAttribute("stroke-linejoin", "round");
    svgNode.append(pathNode);
    cursorNode.append(svgNode);
    cursorLayerNode.append(cursorNode);

    shadowRoot.append(wrapNode, cursorLayerNode);
  }

  function overlayNode(tagName, className = "", attributes = {}, textValue) {
    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    for (const [name, value] of Object.entries(attributes)) {
      node.setAttribute(name, String(value));
    }
    if (textValue !== undefined) {
      node.textContent = textValue;
    }
    return node;
  }

  function controlNode(className) {
    const button = overlayNode("button", "control " + className, { type: "button" });
    button.append(
      overlayNode("span", "control-icon", { "aria-hidden": "true" }),
      overlayNode("span", "button-label")
    );
    return button;
  }

  // Inline SVG keeps icon metrics identical on Windows and macOS, including CJK fonts.
  function setIcon(container, name) {
    if (container.getAttribute("data-icon") === name) return;
    container.setAttribute("data-icon", name);
    container.replaceChildren();
    if (name === "dot") return;
    const paths = {
      hand: "M8 13V5a2 2 0 0 1 4 0v7-9a2 2 0 0 1 4 0v9-7a2 2 0 0 1 4 0v9c0 5-3 8-7 8h-1c-2 0-4-1-5-3l-4-6a2 2 0 0 1 3-2l2 2Z",
      play: "m7 4 13 8-13 8Z",
      more: "M5 12h.01M12 12h.01M19 12h.01",
      stop: "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
      back: "m11 5-7 7 7 7M4 12h16",
      alert: "M12 8v5M12 17h.01M10.3 3.8 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": name === "more" ? "4" : "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", focusable: "false" })) {
      svg.setAttribute(key, value);
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[name] || paths.alert);
    svg.append(path);
    container.append(svg);
  }

  function setControl(button, label, icon, hint = label) {
    const labelNode = button.querySelector(".button-label");
    if (labelNode.textContent !== label) labelNode.textContent = label;
    setIcon(button.querySelector(".control-icon"), icon);
    button.title = hint;
    button.setAttribute("aria-label", hint);
  }

  function signal(actionName, options) {
    const binding = window[SIGNAL_NAME];
    if (typeof binding !== "function") return;
    const payload = { action: actionName };
    if (actionName === "stop" && options?.reason) payload.reason = options.reason;
    if ((actionName === "stop" || actionName === "resume") && !options?.stopAll && !isMultiSession() && state.session) {
      payload.session = state.session;
    }
    try {
      binding(JSON.stringify(payload));
    } catch {
      // The page or CDP binding may have disconnected.
    }
  }

  function isActivationKey(event) {
    return event.key === "Enter" || event.key === " " || event.key === "Spacebar";
  }

  function handleKeyboardClick(event) {
    if (!isActivationKey(event) || event.repeat) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.disabled) {
      return;
    }
    event.currentTarget.click();
  }

  function setupReducedMotionTracking() {
    updateReducedMotion();
    reducedMotionMediaListener = () => updateReducedMotion();
    if (typeof window.matchMedia !== "function") {
      return;
    }
    reducedMotionMediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (typeof reducedMotionMediaQuery.addEventListener === "function") {
      reducedMotionMediaQuery.addEventListener("change", reducedMotionMediaListener);
    } else if (typeof reducedMotionMediaQuery.addListener === "function") {
      reducedMotionMediaQuery.addListener(reducedMotionMediaListener);
    }
  }

  function cleanupReducedMotionTracking() {
    if (reducedMotionMediaQuery && reducedMotionMediaListener) {
      if (typeof reducedMotionMediaQuery.removeEventListener === "function") {
        reducedMotionMediaQuery.removeEventListener("change", reducedMotionMediaListener);
      } else if (typeof reducedMotionMediaQuery.removeListener === "function") {
        reducedMotionMediaQuery.removeListener(reducedMotionMediaListener);
      }
    }
    reducedMotionMediaQuery = null;
    reducedMotionMediaListener = null;
  }

  function updateReducedMotion() {
    if (!host) {
      return;
    }
    host.classList.toggle("reduced-motion", isReducedMotionPreferred());
  }

  function isReducedMotionPreferred() {
    return Boolean(
      reducedMotionMediaQuery
        ? reducedMotionMediaQuery.matches
        : typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
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

  function setupHostReconnectTracking() {
    cleanupHostReconnectTracking();
    if (typeof MutationObserver !== "function" || !document.documentElement) {
      return;
    }
    hostObserver = new MutationObserver((mutations) => {
      if (!host || host.isConnected) {
        return;
      }
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node === host) {
            scheduleHostReconnect();
            return;
          }
        }
      }
      scheduleHostReconnect();
    });
    try {
      hostObserver.observe(document.documentElement, { childList: true });
    } catch {
      hostObserver = null;
    }
  }

  function cleanupHostReconnectTracking() {
    if (hostReattachTimer) {
      clearTimeout(hostReattachTimer);
      hostReattachTimer = null;
    }
    if (hostObserver) {
      hostObserver.disconnect();
      hostObserver = null;
    }
  }

  function scheduleHostReconnect() {
    if (tearingDown || hostReattachTimer) {
      return;
    }
    hostReattachTimer = setTimeout(() => {
      hostReattachTimer = null;
      ensureHostConnected();
    }, 80);
  }

  function ensureHostConnected() {
    if (tearingDown || !host || !document.documentElement || host.isConnected) {
      return Boolean(host && host.isConnected);
    }
    const now = Date.now();
    if (hostReattachBlockedUntil > now) {
      return false;
    }
    if (!hostReattachWindowStartedAt || now - hostReattachWindowStartedAt > HOST_REATTACH_WINDOW_MS) {
      hostReattachWindowStartedAt = now;
      hostReattachAttempts = 0;
    }
    hostReattachAttempts += 1;
    if (hostReattachAttempts > HOST_REATTACH_LIMIT) {
      hostReattachBlockedUntil = now + HOST_REATTACH_BACKOFF_MS;
      scheduleHostReconnect();
      return false;
    }
    try {
      document.documentElement.appendChild(host);
      applyHudCorner(hudCorner);
      return true;
    } catch {
      hostReattachBlockedUntil = now + HOST_REATTACH_BACKOFF_MS;
      scheduleHostReconnect();
      return false;
    }
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
    if (!host || !panel) return;
    ensureHostConnected();
    const copy = text();
    const taken = isDelegatedToUser();
    const offline = state.agentOffline === true;
    const reconnecting = state.driverReconnecting === true;
    const pending = state.handoffPending === true;
    const pendingUserAction = String(state.pendingUserAction || "").trim();
    const requiresUserAction = Boolean(taken && pendingUserAction);
    const error = String(state.stopError || "").trim();
    host.classList.add("locked");
    host.classList.toggle("delegated", taken);
    host.classList.toggle("offline", offline);
    host.classList.toggle("attention", requiresUserAction || pending || reconnecting || (!taken && state.inputGuardState !== "active"));
    host.classList.toggle("has-error", Boolean(error));
    applyHudCorner(hudCorner);
    const label = error ? (taken ? copy.returnError : copy.error)
      : reconnecting ? copy.reconnecting
      : offline ? copy.offline
      : pending ? copy.handoff
      : requiresUserAction ? copy.needsUser
      : taken ? copy.taken : copy.active;
    if (title.textContent !== label) title.textContent = label;
    const hint = error || (reconnecting ? copy.reconnectingHint
      : offline ? copy.offlineHint
      : pending ? copy.handoffHint
      : requiresUserAction ? pendingUserAction
      : taken ? copy.takenHint
      : state.inputGuardState === "unavailable" ? copy.guardUnavailable
      : state.inputGuardState !== "active" ? copy.guardStarting : copy.activeHint);
    statusNode.title = hint;
    statusDescription.textContent = hint;
    setIcon(statusIcon, error ? "alert" : taken && !requiresUserAction && !offline ? "hand" : "dot");
    statusNode.hidden = moreOpen;
    takeoverButton.hidden = moreOpen || offline || reconnecting;
    moreButton.hidden = moreOpen;
    stopButton.hidden = !moreOpen;
    backButton.hidden = !moreOpen;
    moreButton.setAttribute("aria-expanded", moreOpen ? "true" : "false");
    setControl(moreButton, "", "more", copy.more);
    setControl(backButton, copy.back, "back");
    updateStopButton();
  }

  function handleStopClick(kind) {
    const button = kind === "takeover" ? takeoverButton : stopButton;
    if (!button || button.disabled || button.hidden) {
      return;
    }
    if (kind === "takeover" && isDelegatedToUser()) {
      resetStopConfirm();
      signal("resume", { stopAll: false });
      return;
    }
    // “接管”只改变控制权，不关闭浏览器或任务，因此单击立即生效；“结束任务”仍保留二次确认。
    if (kind === "takeover") {
      resetStopConfirm();
      signal("stop", { stopAll: false, reason: "user_takeover" });
      return;
    }
    if (!stopConfirming || stopConfirmKind !== "stop") {
      stopConfirming = true;
      stopConfirmKind = "stop";
      stopButton.classList.add("confirm");
      updateStopButton();
      clearTimeout(stopConfirmTimer);
      stopConfirmTimer = setTimeout(resetStopConfirm, STOP_CONFIRM_MS);
      return;
    }
    try {
      // Suppress leaked/late future-document bootstraps until a later real Agent Session
      // explicitly clears this tab-scoped marker before installing its own bootstrap.
      window.sessionStorage.setItem(TERMINAL_STOP_KEY, String(Number.MAX_SAFE_INTEGER));
    } catch {
      // Main-process script removal still handles pages without sessionStorage.
    }
    signal("stop", { stopAll: true, reason: "user_stop" });
    // The binding call has been dispatched; run the full teardown so the host observer cannot
    // reattach the box while Gateway/daemon teardown settles.
    window.__ppAgentOverlayTeardown?.();
  }

  function updateStopButton() {
    if (!takeoverButton || !stopButton) return;
    const copy = text();
    const taken = isDelegatedToUser();
    const hasBinding = typeof window[SIGNAL_NAME] === "function";
    const pending = state.handoffPending === true;
    const driverUnavailable = state.agentOffline === true || state.driverReconnecting === true;
    takeoverButton.disabled = !hasBinding || pending || driverUnavailable;
    stopButton.disabled = !hasBinding || pending;
    setControl(takeoverButton, taken ? copy.returnToAgent : copy.takeover, taken ? "play" : "hand");
    const stopLabel = stopConfirming ? copy.confirmStop : isMultiSession() ? copy.stopAll : copy.stopSingle;
    setControl(stopButton, stopLabel, "stop", stopConfirming ? copy.confirmHint : stopLabel);
    stopButton.classList.toggle("confirm", stopConfirming);
  }

  function resetStopConfirm() {
    stopConfirming = false;
    stopConfirmKind = "";
    clearTimeout(stopConfirmTimer);
    stopConfirmTimer = null;
    updateStopButton();
  }

  // Input Guard 在 Windows/macOS 原生层先吞掉真实点击，再把同一次按下/抬起的全局坐标和
  // 事件发生时的原生窗口边界交回来。这里不缓存按钮屏幕坐标：每次都用当前页面
  // viewport、页面缩放和按钮 rect 即时换算；任何字段不完整或布局变化都返回 null。
  function guardProbe(payload) {
    if (
      tearingDown ||
      isDelegatedToUser() ||
      !payload ||
      typeof payload !== "object" ||
      document.visibilityState === "hidden"
    ) {
      return null;
    }
    const nativeWindow = normalizeGuardWindow(payload.window);
    const down = normalizeGuardPoint(payload.down);
    const up = normalizeGuardPoint(payload.up);
    const displayScale = positiveFiniteNumber(payload.displayScale);
    const innerWidth = positiveFiniteNumber(window.innerWidth);
    const innerHeight = positiveFiniteNumber(window.innerHeight);
    const outerWidth = positiveFiniteNumber(window.outerWidth);
    const outerHeight = positiveFiniteNumber(window.outerHeight);
    const devicePixelRatio = positiveFiniteNumber(window.devicePixelRatio || 1);
    if (
      !nativeWindow ||
      !down ||
      !up ||
      !displayScale ||
      !innerWidth ||
      !innerHeight ||
      !outerWidth ||
      !outerHeight ||
      !devicePixelRatio
    ) {
      return null;
    }

    const downClient = guardClientPoint(
      down,
      nativeWindow,
      displayScale,
      devicePixelRatio,
      innerWidth,
      innerHeight
    );
    const upClient = guardClientPoint(
      up,
      nativeWindow,
      displayScale,
      devicePixelRatio,
      innerWidth,
      innerHeight
    );
    if (!downClient || !upClient) {
      return null;
    }
    const downAction = guardActionAtClientPoint(downClient);
    const upAction = guardActionAtClientPoint(upClient);
    if (!downAction || downAction !== upAction) {
      return null;
    }

    const button = guardButtonForAction(downAction);
    if (!button || button.disabled || button.hidden) {
      return null;
    }
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const signature = JSON.stringify([
      downAction,
      stopConfirming,
      stopConfirmKind,
      roundGuardMetric(innerWidth),
      roundGuardMetric(innerHeight),
      roundGuardMetric(outerWidth),
      roundGuardMetric(outerHeight),
      roundGuardMetric(devicePixelRatio),
      roundGuardMetric(displayScale),
      roundGuardMetric(viewport ? viewport.scale : 1),
      roundGuardMetric(viewport ? viewport.offsetLeft : 0),
      roundGuardMetric(viewport ? viewport.offsetTop : 0),
      roundGuardMetric(rect.left),
      roundGuardMetric(rect.top),
      roundGuardMetric(rect.right),
      roundGuardMetric(rect.bottom)
    ]);
    return { action: downAction, signature };
  }

  function guardActivate(payload, expectedSignature) {
    const probe = guardProbe(payload);
    if (!probe || probe.signature !== expectedSignature) {
      return false;
    }
    if (probe.action === "more") {
      setMoreOpen(true);
    } else if (probe.action === "back") {
      setMoreOpen(false);
    } else {
      handleStopClick(probe.action);
    }
    return true;
  }

  function guardClientPoint(point, nativeWindow, displayScale, devicePixelRatio, innerWidth, innerHeight) {
    const localOuterX = point.x - nativeWindow.x;
    const localOuterY = point.y - nativeWindow.y;
    const viewport = window.visualViewport;
    const viewportScale = viewport && positiveFiniteNumber(viewport.scale) ? viewport.scale : 1;
    const offsetLeft = viewport && Number.isFinite(viewport.offsetLeft) ? viewport.offsetLeft : 0;
    const offsetTop = viewport && Number.isFinite(viewport.offsetTop) ? viewport.offsetTop : 0;
    const browserZoom = devicePixelRatio / displayScale;
    if (!Number.isFinite(browserZoom) || browserZoom < 0.25 || browserZoom > 5) {
      return null;
    }
    const contentWidth = innerWidth * browserZoom;
    const topChrome = nativeWindow.height - innerHeight * browserZoom;
    const geometryTolerance = Math.max(4, browserZoom * 2);
    if (
      Math.abs(contentWidth - nativeWindow.width) > geometryTolerance ||
      topChrome < -geometryTolerance ||
      topChrome > nativeWindow.height
    ) {
      return null;
    }
    const pointScale = browserZoom * viewportScale;
    const clientX = offsetLeft + localOuterX / pointScale;
    const clientY = offsetTop + (localOuterY - Math.max(0, topChrome)) / pointScale;
    if (
      !Number.isFinite(clientX) ||
      !Number.isFinite(clientY) ||
      clientX < 0 ||
      clientY < 0 ||
      clientX > innerWidth ||
      clientY > innerHeight
    ) {
      return null;
    }
    return { x: clientX, y: clientY };
  }

  function guardActionAtClientPoint(point) {
    const entries = [
      ["more", moreButton],
      ["back", backButton],
      ["takeover", takeoverButton],
      ["stop", stopButton]
    ];
    for (const [kind, button] of entries) {
      if (!button || button.disabled || button.hidden) {
        continue;
      }
      const rect = button.getBoundingClientRect();
      // 边缘留 4px 安全区，避免混合缩放或小数舍入把边界点击误判成控制按钮。
      const inset = Math.min(4, rect.width / 4, rect.height / 4);
      if (
        point.x >= rect.left + inset &&
        point.x <= rect.right - inset &&
        point.y >= rect.top + inset &&
        point.y <= rect.bottom - inset
      ) {
        return kind;
      }
    }
    return null;
  }

  function guardButtonForAction(actionName) {
    if (actionName === "more") return moreButton;
    if (actionName === "back") return backButton;
    if (actionName === "takeover") return takeoverButton;
    if (actionName === "stop") return stopButton;
    return null;
  }

  function normalizeGuardWindow(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const x = finiteNumber(value.x);
    const y = finiteNumber(value.y);
    const width = positiveFiniteNumber(value.width);
    const height = positiveFiniteNumber(value.height);
    return x === null || y === null || !width || !height ? null : { x, y, width, height };
  }

  function normalizeGuardPoint(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const x = finiteNumber(value.x);
    const y = finiteNumber(value.y);
    return x === null || y === null ? null : { x, y };
  }

  function positiveFiniteNumber(value) {
    const number = finiteNumber(value);
    return number !== null && number > 0 ? number : null;
  }

  function roundGuardMetric(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  }

  function setMoreOpen(open, moveFocus = true) {
    const hadFocus = Boolean(root && root.activeElement);
    moreOpen = open;
    resetStopConfirm();
    render();
    if (moveFocus && hadFocus) (open ? backButton : moreButton)?.focus({ preventScroll: true });
  }

  function handleOutsidePointer(event) {
    if (!moreOpen || tearingDown || !host) return;
    const inside = typeof event.composedPath === "function" && event.composedPath().includes(host);
    if (!inside) setMoreOpen(false, false);
  }

  function handleEscapeKey(event) {
    if (event.key === "Escape" && moreOpen) setMoreOpen(false);
  }

  function handleHudAvoidEvent(event) {
    try {
      avoidHudForRect(event && event.detail);
    } catch {
      // The click must proceed even if a page supplies malformed event detail.
    }
  }

  function readHudCorner() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      return parsed && HUD_CORNERS.includes(parsed.corner) ? parsed.corner : "bottom-right";
    } catch {
      return "bottom-right";
    }
  }

  function applyHudCorner(corner) {
    if (!host) {
      return false;
    }
    const next = HUD_CORNERS.includes(corner) ? corner : "bottom-right";
    for (const candidate of HUD_CORNERS) {
      host.classList.toggle("corner-" + candidate, candidate === next);
    }
    hudCorner = next;
    return true;
  }

  function persistHudCorner() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ corner: hudCorner }));
    } catch {
      // sessionStorage may be disabled.
    }
  }

  function avoidHudForRect(input) {
    if (!host || !panel || tearingDown) {
      return false;
    }
    const targetRect = normalizeAvoidRect(input);
    if (!targetRect) {
      return false;
    }
    const controlRect = panel.getBoundingClientRect();
    if (!rectsIntersect(expandRect(targetRect, HUD_COLLISION_MARGIN_PX), controlRect)) {
      return false;
    }
    const candidates = HUD_CORNERS.map((corner) => hudCornerCandidate(corner, controlRect.width, controlRect.height));
    const targetCenterX = (targetRect.left + targetRect.right) / 2;
    const targetCenterY = (targetRect.top + targetRect.bottom) / 2;
    let best = null;
    for (const candidate of candidates) {
      const overlap = intersectionArea(expandRect(targetRect, HUD_COLLISION_MARGIN_PX), candidate.rect);
      const density = interactionDensityAt(candidate.rect);
      const centerX = (candidate.rect.left + candidate.rect.right) / 2;
      const centerY = (candidate.rect.top + candidate.rect.bottom) / 2;
      const distance = Math.hypot(centerX - targetCenterX, centerY - targetCenterY);
      const score = overlap * 100000 + density * 1000 - distance;
      if (!best || score < best.score) {
        best = { corner: candidate.corner, score };
      }
    }
    if (!best || best.corner === hudCorner) {
      return false;
    }
    applyHudCorner(best.corner);
    persistHudCorner();
    return true;
  }

  function normalizeAvoidRect(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const left = finiteNumber(value.left ?? value.x);
    const top = finiteNumber(value.top ?? value.y);
    const width = positiveFiniteNumber(value.width) || 1;
    const height = positiveFiniteNumber(value.height) || 1;
    const right = finiteNumber(value.right);
    const bottom = finiteNumber(value.bottom);
    if (left === null || top === null) {
      return null;
    }
    return {
      left,
      top,
      right: right === null ? left + width : right,
      bottom: bottom === null ? top + height : bottom
    };
  }

  function expandRect(rect, margin) {
    return {
      left: rect.left - margin,
      top: rect.top - margin,
      right: rect.right + margin,
      bottom: rect.bottom + margin
    };
  }

  function hudCornerCandidate(corner, width, height) {
    const safeWidth = Math.max(32, width || 32);
    const safeHeight = Math.max(32, height || 32);
    const left = corner.endsWith("left") ? HUD_INSET_PX : Math.max(HUD_INSET_PX, window.innerWidth - HUD_INSET_PX - safeWidth);
    const top = corner.startsWith("top") ? HUD_INSET_PX : Math.max(HUD_INSET_PX, window.innerHeight - HUD_INSET_PX - safeHeight);
    return {
      corner,
      rect: { left, top, right: left + safeWidth, bottom: top + safeHeight }
    };
  }

  function rectsIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function intersectionArea(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
  }

  function interactionDensityAt(rect) {
    if (typeof document.elementFromPoint !== "function") {
      return 0;
    }
    const x = Math.max(0, Math.min(window.innerWidth - 1, (rect.left + rect.right) / 2));
    const y = Math.max(0, Math.min(window.innerHeight - 1, (rect.top + rect.bottom) / 2));
    const element = document.elementFromPoint(x, y);
    if (!element || element === host || (typeof element.closest === "function" && element.closest("#__pp-agent-overlay,[data-pp-ui]"))) {
      return 0;
    }
    return typeof element.closest === "function" && element.closest("a,button,input,select,textarea,[role='button'],[tabindex]")
      ? 1
      : 0;
  }

  function handleAgentPointer(event) {
    if (!shouldAutoHighlight(event)) {
      return;
    }
    highlightAt(event.clientX, event.clientY);
  }

  function shouldAutoHighlight(event) {
    // 只在 AI 操作态（active）且 overlay 存活时画；接管或拆除后停画。
    if (tearingDown || !host || state.state === "takenOver") {
      return false;
    }
    // 仅高亮浏览器真实派发的事件（CDP Input.dispatchMouseEvent 也是 isTrusted），过滤脚本合成点击。
    if (!event || event.isTrusted !== true) {
      return false;
    }
    // 命中 overlay 自身（拖动条 / 停止按钮等）不算 AI 页面点击。
    if (typeof event.composedPath === "function" && event.composedPath().includes(host)) {
      return false;
    }
    return true;
  }

  // 在视口坐标 (x, y) 处画一次高亮：合成光标滑过去 + 一圈点击涟漪。
  function highlightAt(x, y) {
    const px = Number(x);
    const py = Number(y);
    if (tearingDown || !cursorLayer || !Number.isFinite(px) || !Number.isFinite(py)) {
      return;
    }
    ensureHostConnected();
    moveAgentCursor(px, py);
    spawnRipple(px, py);
  }

  function moveAgentCursor(x, y) {
    if (!agentCursor) {
      return;
    }
    agentCursor.style.transform = "translate(" + x + "px," + y + "px)";
    agentCursor.classList.add("show");
    clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(hideAgentCursor, CURSOR_IDLE_HIDE_MS);
  }

  function hideAgentCursor() {
    clearTimeout(cursorHideTimer);
    cursorHideTimer = null;
    if (agentCursor) {
      agentCursor.classList.remove("show");
    }
  }

  function spawnRipple(x, y) {
    const ripple = document.createElement("span");
    ripple.className = "pp-click-ripple";
    ripple.style.left = x + "px";
    ripple.style.top = y + "px";
    const remove = () => {
      clearTimeout(fallback);
      try {
        ripple.remove();
      } catch {
        // 节点可能已被页面移除。
      }
    };
    // 动画正常时靠 animationend 回收；reduced-motion 下无动画则靠兜底定时器移除。
    const fallback = setTimeout(remove, RIPPLE_LIFETIME_MS);
    ripple.addEventListener("animationend", remove);
    cursorLayer.appendChild(ripple);
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

  // 归属交给用户（用户接管保留窗口内）：以三值枚举 ownership 为准，兼容仍只发 state 的旧 payload。
  function isDelegatedToUser() {
    return state.ownership === "agentDelegatedToUser" || state.state === "takenOver";
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
    if (key === "ownership") {
      return value === "agentDelegatedToUser" || value === "user" ? value : "agent";
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
    if (
      key === "handoffPending" ||
      key === "agentOffline" ||
      key === "driverReconnecting" ||
      key === "agentTargetIsCurrentPage" ||
      key === "autoFollowAgent" ||
      key === "targetActivationPending"
    ) {
      return value === true;
    }
    if (STRING_STATE_FIELDS.has(key)) {
      return typeof value === "string" ? value : String(value);
    }
    return value;
  }

  window.__ppAgentOverlayUpdate = (payload) => {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    lastUpdateReceivedAt = Date.now();
    const wasDelegatedToUser = isDelegatedToUser();
    const previousStopError = String(state.stopError || "").trim();
    const wasPending = state.handoffPending === true;
    const previousAttention = [state.agentOffline, state.driverReconnecting, state.pendingUserAction].join("|");
    for (const key of KNOWN_STATE_FIELDS) {
      state[key] = normalizeKnownStateValue(key, payload[key]);
    }
    // A control transition or new failure must leave the status visible and cancel
    // any armed destructive action, without changing the strip's geometry.
    const attention = [state.agentOffline, state.driverReconnecting, state.pendingUserAction].join("|");
    if (wasDelegatedToUser !== isDelegatedToUser() || wasPending !== state.handoffPending || previousStopError !== state.stopError || previousAttention !== attention) {
      moreOpen = false;
      resetStopConfirm();
    }
    if (!host) {
      // bootstrap 可能是旧 CDP Session 遗留的 future-document script。只有收到
      // ProfilePilot 当前实例发来的有效 payload 后才挂载，不能用默认值伪造 Agent 状态。
      mount();
    } else {
      ensureHostConnected();
      render();
    }
    return true;
  };

  // 供 CDP Runtime.evaluate 直接驱动的接线点：拿到 AI 点击坐标即可触发高亮。
  // 兼容 highlightAt(x, y)、highlightAt({x, y}) 与 highlightAt('{"x":..,"y":..}') 三种调用形式。
  window.__ppAgentOverlayHighlightAt = (x, y) => {
    try {
      let px = x;
      let py = y;
      if (typeof x === "string") {
        const parsed = JSON.parse(x);
        px = parsed && parsed.x;
        py = parsed && parsed.y;
      } else if (x && typeof x === "object") {
        px = x.x;
        py = x.y;
      }
      highlightAt(px, py);
    } catch {
      // 忽略非法坐标输入。
    }
  };

  window.__ppAgentOverlayAvoidRect = (rect) => {
    try {
      return avoidHudForRect(rect);
    } catch {
      return false;
    }
  };

  window.__ppAgentOverlayGuardProbe = (payload) => {
    try {
      return guardProbe(payload);
    } catch {
      return null;
    }
  };

  window.__ppAgentOverlayGuardActivate = (payload, expectedSignature) => {
    try {
      return guardActivate(payload, expectedSignature);
    } catch {
      return false;
    }
  };

  window.__ppAgentOverlayTeardown = (preserveSignalBinding = false) => {
    if (tearingDown) {
      return;
    }
    tearingDown = true;
    clearInterval(heartbeatTimer);
    clearTimeout(cursorHideTimer);
    clearTimeout(stopConfirmTimer);
    stopConfirmTimer = null;
    if (agentPointerListener) {
      window.removeEventListener("pointerdown", agentPointerListener, true);
      agentPointerListener = null;
    }
    if (outsidePointerListener) {
      window.removeEventListener("pointerdown", outsidePointerListener, true);
      outsidePointerListener = null;
    }
    if (escapeKeyListener) {
      window.removeEventListener("keydown", escapeKeyListener, true);
      escapeKeyListener = null;
    }
    if (host && hudAvoidListener) {
      host.removeEventListener(HUD_AVOID_EVENT, hudAvoidListener);
      hudAvoidListener = null;
    }
    cleanupHostReconnectTracking();
    cleanupReducedMotionTracking();
    cleanupThemeTracking();
    // 必须在 Runtime.evaluate 返回前同步移除节点。若等待离场动画，紧接着发生的
    // Target.detachFromTarget 会销毁 isolated world，180ms cleanup 将永远没有机会执行。
    try {
      host && host.remove();
    } catch {
      // The node may have already been removed by the page.
    }
    delete window.__ppAgentOverlayInstalled;
    delete window.__ppAgentOverlayUpdate;
    delete window.__ppAgentOverlayHighlightAt;
    delete window.__ppAgentOverlayAvoidRect;
    delete window.__ppAgentOverlayGuardProbe;
    delete window.__ppAgentOverlayGuardActivate;
    delete window.__ppAgentOverlayTeardown;
    if (!preserveSignalBinding) {
      delete window[SIGNAL_NAME];
    }
  };

  // 不在 bootstrap 阶段直接 mount。孤立的 future-document script 只暴露更新入口，
  // 超时后自行清理；真实 Agent 状态会通过 __ppAgentOverlayUpdate 触发首次挂载。
  startHeartbeat();
})();`;
}
