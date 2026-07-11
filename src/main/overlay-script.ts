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
  const COLLAPSED_KEY = "__ppAgentOverlayCollapsed";
  const EXPANDED_KEY = "__ppAgentOverlayExpanded";
  const STOP_CONFIRM_MS = 3000;
  const HOST_REATTACH_LIMIT = 8;
  const HOST_REATTACH_WINDOW_MS = 10000;
  const HOST_REATTACH_BACKOFF_MS = 3000;
  // 合成光标 / 点击高亮层：AI 空闲 900ms 后隐藏合成光标，点击涟漪 620ms 后自动回收。
  const CURSOR_IDLE_HIDE_MS = 900;
  const RIPPLE_LIFETIME_MS = 620;
  const OVERLAY_TEXT = {
    zh: {
      revealTitle: "在 ProfilePilot 中查看",
      hideTitle: "隐藏",
      expandTitle: "展开 AI 操作状态",
      sessionHeading: "会话",
      recentSummary: "AI 最近说",
      takenTitle: "✋ 已接管，AI 已暂停操作",
      offlineTitle: "Agent 已离线",
      handoffTitle: "正在安全交接…",
      operatingPrefix: "AI 正在控制 · ",
      sessionsSuffix: " 个会话",
      actionPrefix: "▸ ",
      targetPrefix: "目标：",
      takenAction: "浏览器控制权已交还给你",
      offlineAction: "原 Agent 已不再等待；请释放 Profile 后再开始新的 Agent 会话",
      handoffAction: "正在等待当前浏览器操作结束，完成前仍禁止手动点击",
      defaultAction: "AI 正在控制浏览器",
      lockedTitle: "Agent 调试中",
      lockedHint: "暂时无法手动点击",
      guardStarting: "正在启用点击保护…",
      guardUnavailable: "需要给“ProfilePilot Input Guard”开启辅助功能权限，当前尚未禁止点击",
      defaultTask: "Agent 任务",
      multiTaskTitle: (count) => count + " 个 Agent 任务正在控制",
      detailsTitle: "查看控制详情",
      collapseDetailsTitle: "收起控制详情",
      ownerAgent: "Agent",
      ownerUser: "User",
      taskSpacePrefix: "任务空间",
      projectPrefix: "项目",
      sessionPrefix: "Session",
      hardStopSent: "已发送 hard-stop notice",
      takeoverHint: "你可以随时接管；接管后 Agent 会收到硬停止通知",
      nextPrefix: "下一步：",
      stepLabel: (index) => "第 " + index + " 步：",
      progressDone: (done, total) => done + "/" + total + " 已完成",
      unnamedSession: "未命名会话",
      unknownActivity: "活动未知",
      elapsedPrefix: "已运行 ",
      takenElapsedPrefix: "已接管 ",
      returnToAgent: "交还 Agent",
      offlineButton: "Agent 已离线",
      releaseProfile: "释放 Profile",
      confirmRelease: "再点一次释放",
      takeover: "接管",
      stopSingle: "结束任务",
      stopAll: "结束全部",
      confirmStop: "再点一次结束",
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
      takenTitle: "✋ Taken over — AI paused",
      offlineTitle: "Agent offline",
      handoffTitle: "Handing over safely…",
      operatingPrefix: "AI is controlling · ",
      sessionsSuffix: " sessions",
      actionPrefix: "▸ ",
      targetPrefix: "Target: ",
      takenAction: "browser control returned to you",
      offlineAction: "The original agent is no longer waiting; release this Profile before starting another agent session",
      handoffAction: "Waiting for the current browser action to settle; manual clicks remain disabled",
      defaultAction: "AI is controlling this browser",
      lockedTitle: "Agent debugging",
      lockedHint: "Manual clicks are temporarily disabled",
      guardStarting: "正在启用点击保护…",
      guardUnavailable: "需要给“ProfilePilot Input Guard”开启辅助功能权限，当前尚未禁止点击",
      defaultTask: "Agent task",
      multiTaskTitle: (count) => count + " Agent tasks are controlling",
      detailsTitle: "Show control details",
      collapseDetailsTitle: "Hide control details",
      ownerAgent: "Agent",
      ownerUser: "User",
      taskSpacePrefix: "Task space",
      projectPrefix: "项目",
      sessionPrefix: "Session",
      hardStopSent: "Hard-stop notice sent",
      takeoverHint: "You can take over anytime; the agent receives a hard-stop notice",
      nextPrefix: "Next: ",
      stepLabel: (index) => "Step " + index + ": ",
      progressDone: (done, total) => done + "/" + total + " completed",
      unnamedSession: "Untitled session",
      unknownActivity: "Activity unknown",
      elapsedPrefix: "Running for ",
      takenElapsedPrefix: "Taken over for ",
      // 控制权按钮是操作协议的一部分，不跟随网页语言，避免中文应用里被页面语言切成英文。
      returnToAgent: "交还 Agent",
      offlineButton: "Agent 已离线",
      releaseProfile: "释放 Profile",
      confirmRelease: "再点一次释放",
      takeover: "接管",
      stopSingle: "结束任务",
      stopAll: "结束全部",
      confirmStop: "再点一次结束",
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
    ownership: "agent",
    inputGuardState: "starting",
    handoffPending: false,
    agentOffline: false,
    controlSince: "",
    profileName: "",
    agent: "",
    project: "",
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
    "session",
    "sessionTitle",
    "currentAction",
    "targetUrl",
    "currentStep",
    "nextStep",
    "lastMessage",
    "updatedAt",
    "startedAt",
    "controlSince",
    "stopError",
    "inputGuardState"
  ]);
  const state = cloneStateDefaults();
  let collapsed = readCollapsed();
  let expanded = readExpanded();
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
  let target = null;
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
  let lockHint = null;
  let stateChip = null;
  let spaceChip = null;
  let controlNote = null;
  let takeoverButton = null;
  let stopButton = null;
  let revealButton = null;
  let hideButton = null;
  let detailToggleButton = null;
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
  let stopConfirmKind = "";

  function mount() {
    if (!document.documentElement) {
      setTimeout(mount, 50);
      return;
    }
    host = document.createElement("div");
    host.id = "__pp-agent-overlay";
    // Keep the overlay hidden from agent accessibility snapshots. This also hides
    // it from screen readers, so every critical control still carries title and
    // aria-label text for the least-bad default if that policy changes later.
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("role", "presentation");
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.width = "100vw";
    host.style.height = "100vh";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";
    host.style.colorScheme = "dark";
    host.classList.toggle("reduced-motion", isReducedMotionPreferred());

    root = host.attachShadow({ mode: "closed" });
    const styleText = [
      ":host{all:initial}",
      "*{box-sizing:border-box}",
      ".wrap{--pp-text:#f4fff9;--pp-title:#f1fff8;--pp-muted:#a6c1b8;--pp-muted-soft:#7fa89a;--pp-panel-bg:rgba(8,13,16,.88);--pp-panel-border:rgba(148,255,213,.30);--pp-panel-shadow:0 18px 50px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.04) inset;--pp-panel-hover-shadow:0 20px 56px rgba(0,0,0,.46),0 0 0 1px rgba(255,255,255,.06) inset;--pp-taken-bg:rgba(6,27,19,.90);--pp-taken-border:rgba(86,240,170,.58);--pp-control-bg:rgba(255,255,255,.07);--pp-control-hover-bg:rgba(255,255,255,.14);--pp-control-text:#d7fff1;--pp-control-hover-text:#ffffff;--pp-action-bg:rgba(255,255,255,.06);--pp-action-text:#f7fffb;--pp-progress-text:#effff8;--pp-progress-bg:rgba(148,255,213,.13);--pp-progress-fill-start:#35d892;--pp-progress-fill-end:#86ffd2;--pp-progress-glow:rgba(56,225,160,.55);--pp-next:#9bb7ad;--pp-sessions-bg:rgba(255,255,255,.045);--pp-sessions-border:rgba(255,255,255,.055);--pp-session-heading:#c8fff0;--pp-session-row:#afcac1;--pp-session-agent:#eafff8;--pp-session-name:#bdd7cf;--pp-session-time:#78a292;--pp-details:#a9c7bd;--pp-summary:#c9fff0;--pp-summary-hover:#ffffff;--pp-dot-bg:rgba(8,13,16,.90);--pp-dot-hover-bg:rgba(12,22,24,.94);--pp-dot-border:rgba(148,255,213,.36);--pp-dot-hover-border:rgba(148,255,213,.55);--pp-dot-shadow:0 12px 34px rgba(0,0,0,.42);--pp-stop-text:#ffe2de;--pp-stop-hover-text:#fff2ef;--pp-stop-confirm-text:#fff1dc;--pp-focus-ring:#ffffff;--pp-motion-duration:.16s;--pp-motion-ease:cubic-bezier(.2,0,0,1);--pp-hover-duration:.14s;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--pp-text);user-select:none;opacity:0;transform:translateY(-4px) scale(.985);animation:ppIn var(--pp-motion-duration) var(--pp-motion-ease) forwards}",
      ":host(.theme-light) .wrap{--pp-text:#173128;--pp-title:#0d241c;--pp-muted:#49635a;--pp-muted-soft:#5b7369;--pp-panel-bg:rgba(255,255,255,.92);--pp-panel-border:rgba(22,115,80,.34);--pp-panel-shadow:0 18px 50px rgba(20,41,34,.20),0 0 0 1px rgba(255,255,255,.70) inset;--pp-panel-hover-shadow:0 20px 56px rgba(20,41,34,.24),0 0 0 1px rgba(255,255,255,.78) inset;--pp-taken-bg:rgba(240,255,249,.94);--pp-taken-border:rgba(31,139,96,.52);--pp-control-bg:rgba(13,48,36,.08);--pp-control-hover-bg:rgba(13,48,36,.14);--pp-control-text:#14583d;--pp-control-hover-text:#083624;--pp-action-bg:rgba(22,92,67,.08);--pp-action-text:#102f25;--pp-progress-text:#173128;--pp-progress-bg:#d4e3dd;--pp-progress-fill-start:#0d7f54;--pp-progress-fill-end:#145f45;--pp-progress-glow:rgba(17,115,79,.24);--pp-next:#506b61;--pp-sessions-bg:rgba(20,91,66,.06);--pp-sessions-border:rgba(20,91,66,.14);--pp-session-heading:#135a3e;--pp-session-row:#516b62;--pp-session-agent:#123f2d;--pp-session-name:#39594e;--pp-session-time:#586e65;--pp-details:#536d63;--pp-summary:#145a40;--pp-summary-hover:#06351f;--pp-dot-bg:rgba(255,255,255,.92);--pp-dot-hover-bg:rgba(244,255,250,.96);--pp-dot-border:rgba(22,115,80,.36);--pp-dot-hover-border:rgba(22,115,80,.56);--pp-dot-shadow:0 12px 34px rgba(20,41,34,.20);--pp-stop-text:#8f2119;--pp-stop-hover-text:#68140f;--pp-stop-confirm-text:#74420d;--pp-focus-ring:#073f2b}",
      ".panel{width:min(336px,calc(100vw - 24px));border:1px solid var(--pp-panel-border);border-radius:14px;background:var(--pp-panel-bg);backdrop-filter:blur(18px) saturate(1.35);box-shadow:var(--pp-panel-shadow);overflow:hidden;transition:border-color var(--pp-motion-duration) var(--pp-motion-ease),background var(--pp-motion-duration) var(--pp-motion-ease),box-shadow var(--pp-motion-duration) var(--pp-motion-ease),transform var(--pp-motion-duration) var(--pp-motion-ease)}",
      ".panel:hover{box-shadow:var(--pp-panel-hover-shadow)}",
      ".panel.taken{border-color:var(--pp-taken-border);background:var(--pp-taken-bg);transform:translateY(1px)}",
      ".head{display:flex;align-items:center;gap:9px;min-height:40px;padding:10px 10px 8px 12px;cursor:grab}",
      ".head:active{cursor:grabbing}",
      ".pulse{width:9px;height:9px;border-radius:99px;background:#38e1a0;box-shadow:0 0 0 0 rgba(56,225,160,.55);animation:ppPulse 1.45s ease-out infinite;flex:0 0 auto}",
      ".taken .pulse{background:#66f0b2}",
      ".title{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:760;letter-spacing:0;color:var(--pp-title)}",
      ".icon-btn{width:26px;height:24px;border:0;border-radius:7px;background:var(--pp-control-bg);color:var(--pp-control-text);font-size:16px;line-height:20px;cursor:pointer;transition:background var(--pp-hover-duration) var(--pp-motion-ease),color var(--pp-hover-duration) var(--pp-motion-ease),transform var(--pp-hover-duration) var(--pp-motion-ease)}",
      ".icon-btn:hover{background:var(--pp-control-hover-bg);color:var(--pp-control-hover-text)}",
      ".icon-btn:active{transform:translateY(1px)}",
      ".hide{font-size:18px}",
      ".body{padding:0 12px 12px}",
      ".meta{margin:0 0 4px 18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pp-muted);font-size:11px;line-height:1.3}",
      ".elapsed{margin:0 0 8px 18px;color:var(--pp-muted-soft);font-size:10.5px;line-height:1.2;font-variant-numeric:tabular-nums}",
      ".action{margin:0 0 9px;padding:8px 9px;border-radius:8px;background:var(--pp-action-bg);font-size:12.5px;line-height:1.35;overflow-wrap:anywhere;color:var(--pp-action-text)}",
      ".target{margin:-4px 0 8px;color:var(--pp-next);font-size:11.5px;line-height:1.3;overflow-wrap:anywhere}",
      ".progress-text{margin:0 0 5px;color:var(--pp-progress-text);font-size:12px;font-weight:680;line-height:1.35;overflow-wrap:anywhere}",
      ".progress-bar{height:3px;margin:0 0 8px;border-radius:99px;background:var(--pp-progress-bg);overflow:hidden}",
      ".progress-fill{display:block;width:0;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--pp-progress-fill-start),var(--pp-progress-fill-end));box-shadow:0 0 12px var(--pp-progress-glow);transition:width .32s var(--pp-motion-ease)}",
      ".next{margin:0 0 9px;color:var(--pp-next);font-size:11.5px;line-height:1.35;overflow-wrap:anywhere}",
      ".sessions{margin:0 0 10px;padding:7px 8px;border-radius:8px;background:var(--pp-sessions-bg);border:1px solid var(--pp-sessions-border)}",
      ".session-heading{margin:0 0 5px;color:var(--pp-session-heading);font-size:11px;font-weight:700}",
      ".session-list{display:grid;gap:5px}",
      ".session-row{display:grid;grid-template-columns:minmax(52px,.55fr) minmax(0,1fr) auto;gap:6px;align-items:center;min-height:20px;color:var(--pp-session-row);font-size:10.5px;line-height:1.25}",
      ".session-agent{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pp-session-agent);font-weight:680}",
      ".session-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pp-session-name)}",
      ".session-time{white-space:nowrap;color:var(--pp-session-time);font-variant-numeric:tabular-nums}",
      "details{margin:0 0 10px;color:var(--pp-details);font-size:11.5px;line-height:1.4}",
      "summary{cursor:pointer;color:var(--pp-summary);font-weight:650;outline:none;transition:color var(--pp-hover-duration) var(--pp-motion-ease)}",
      "summary:hover{color:var(--pp-summary-hover)}",
      ".icon-btn:focus-visible,.stop:focus-visible,.dot:focus-visible,summary:focus-visible{outline:2px solid var(--pp-focus-ring);outline-offset:2px}",
      ".recent-text{display:block;margin-top:4px;overflow-wrap:anywhere}",
      ".stop{width:100%;min-height:34px;border:1px solid rgba(255,113,100,.58);border-radius:9px;background:linear-gradient(180deg,rgba(255,113,100,.24),rgba(255,113,100,.11));color:var(--pp-stop-text);font-size:12px;font-weight:780;cursor:pointer;transition:background var(--pp-hover-duration) var(--pp-motion-ease),border-color var(--pp-hover-duration) var(--pp-motion-ease),color var(--pp-hover-duration) var(--pp-motion-ease),transform var(--pp-hover-duration) var(--pp-motion-ease)}",
      ".stop:hover:not(:disabled){background:rgba(255,113,100,.28);border-color:rgba(255,135,123,.70);color:var(--pp-stop-hover-text)}",
      ".stop:active:not(:disabled){transform:translateY(1px)}",
      ".stop.confirm{background:linear-gradient(180deg,rgba(255,171,92,.27),rgba(255,171,92,.13));border-color:rgba(255,188,112,.68);color:var(--pp-stop-confirm-text)}",
      ".stop:disabled{opacity:.56;cursor:default;transform:none}",
      ".dot{display:none;width:36px;height:36px;border:1px solid var(--pp-dot-border);border-radius:99px;background:var(--pp-dot-bg);backdrop-filter:blur(14px);box-shadow:var(--pp-dot-shadow);cursor:pointer;place-items:center;transition:background var(--pp-hover-duration) var(--pp-motion-ease),border-color var(--pp-hover-duration) var(--pp-motion-ease),transform var(--pp-hover-duration) var(--pp-motion-ease)}",
      ".dot:hover{background:var(--pp-dot-hover-bg);border-color:var(--pp-dot-hover-border);transform:translateY(-1px)}",
      ".dot .pulse{width:11px;height:11px}",
      ":host(.collapsed) .panel{display:none}",
      ":host(.collapsed) .dot{display:grid}",
      ":host(.leaving) .wrap{animation:ppOut var(--pp-motion-duration) var(--pp-motion-ease) forwards}",
      ":host(.reduced-motion) .wrap{opacity:1;transform:none;animation:none}",
      ":host(.leaving.reduced-motion) .wrap{opacity:0;transform:none;animation:none}",
      ":host(.reduced-motion) .pulse{animation:none;box-shadow:none}",
      ":host(.reduced-motion) .panel,:host(.reduced-motion) .icon-btn,:host(.reduced-motion) .progress-fill,:host(.reduced-motion) summary,:host(.reduced-motion) .stop,:host(.reduced-motion) .dot{transition:none}",
      ":host(.reduced-motion) .panel.taken,:host(.reduced-motion) .icon-btn:active,:host(.reduced-motion) .stop:active:not(:disabled),:host(.reduced-motion) .dot:hover{transform:none}",
      "@keyframes ppIn{to{opacity:1;transform:translateY(0) scale(1)}}",
      "@keyframes ppOut{to{opacity:0;transform:translateY(-3px) scale(.985)}}",
      "@keyframes ppPulse{0%{box-shadow:0 0 0 0 rgba(56,225,160,.58)}70%{box-shadow:0 0 0 9px rgba(56,225,160,0)}100%{box-shadow:0 0 0 0 rgba(56,225,160,0)}}",
      "@keyframes ppSpin{to{transform:rotate(360deg)}}",
      // 合成光标 / 点击高亮层：满屏 fixed 叠加、pointer-events:none，坐标即视口 CSS 像素，不抢真实指针。
      ".pp-cursor-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:visible}",
      ".pp-agent-cursor{position:fixed;left:0;top:0;width:22px;height:22px;opacity:0;transform:translate(-120px,-120px);transition:transform .24s cubic-bezier(.2,0,0,1),opacity .18s ease;filter:drop-shadow(0 2px 5px rgba(0,0,0,.45));will-change:transform,opacity}",
      ".pp-agent-cursor.show{opacity:1}",
      ".pp-agent-cursor svg{display:block;width:100%;height:100%}",
      ".pp-click-ripple{position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:99px;border:2px solid rgba(56,225,160,.92);background:rgba(56,225,160,.20);box-shadow:0 0 14px rgba(56,225,160,.55);animation:ppRipple .58s cubic-bezier(.2,0,0,1) forwards}",
      "@keyframes ppRipple{0%{opacity:.9;transform:scale(.32)}70%{opacity:.5}100%{opacity:0;transform:scale(2.7)}}",
      ":host(.reduced-motion) .pp-agent-cursor{transition:none}",
      ":host(.reduced-motion) .pp-click-ripple{animation:none;opacity:.5}",
      ".wrap{position:fixed;inset:0;z-index:1;pointer-events:none}",
      ".panel{position:absolute;left:50%;right:auto;top:auto;bottom:28px;width:min(560px,calc(100vw - 32px));border-radius:18px;border-color:rgba(197,214,255,.34);background:rgba(31,38,53,.88);box-shadow:0 24px 70px rgba(28,42,88,.34),0 0 0 1px rgba(255,255,255,.08) inset;pointer-events:auto;transform:translateX(-50%);overflow:hidden}",
      ".panel:hover{box-shadow:0 26px 76px rgba(28,42,88,.38),0 0 0 1px rgba(255,255,255,.10) inset}",
      ".panel.taken{border-color:rgba(103,240,177,.55);background:rgba(14,39,32,.90);transform:translateX(-50%)}",
      ".head{min-height:42px;padding:10px 12px 7px;cursor:default}",
      ".head:active{cursor:default}",
      ".title{font-size:15px;font-weight:780;color:#f8fbff}",
      ".body{display:grid;gap:7px;padding:0 12px 12px}",
      ".details{display:grid;gap:7px}",
      ".meta,.elapsed{margin-left:18px}",
      ".action{margin:0;border:1px solid rgba(255,255,255,.06);background:rgba(12,18,30,.26)}",
      ".status-line{display:none;align-items:center;gap:7px;min-width:0;color:rgba(234,241,255,.74);font-size:12px;font-weight:720;line-height:1.25}",
      ".status-dot{width:7px;height:7px;border-radius:99px;background:#7fa2ff;box-shadow:0 0 13px rgba(127,162,255,.92);flex:0 0 auto}",
      ".lock-hint{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".status-stack{display:none;min-width:0}",
      ".state-row{display:flex;align-items:center;gap:6px;min-width:0;margin-top:5px}",
      ".state-chip,.space-chip{display:inline-flex;align-items:center;min-width:0;max-width:100%;height:20px;border-radius:999px;border:1px solid rgba(218,228,255,.17);background:rgba(244,248,255,.08);padding:0 8px;color:rgba(241,246,255,.82);font-size:10.5px;font-weight:740;line-height:20px;white-space:nowrap}",
      ".state-chip{color:#dbe8ff;border-color:rgba(127,162,255,.34);background:rgba(127,162,255,.14)}",
      ".space-chip{overflow:hidden;text-overflow:ellipsis}",
      ".control-note{display:none;margin-top:5px;color:rgba(224,234,255,.58);font-size:10.5px;font-weight:650;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".controls{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
      ".takeover,.stop{width:100%;min-height:36px;border-radius:10px;font-size:12.5px;font-weight:780;cursor:pointer;transition:background var(--pp-hover-duration) var(--pp-motion-ease),border-color var(--pp-hover-duration) var(--pp-motion-ease),color var(--pp-hover-duration) var(--pp-motion-ease),transform var(--pp-hover-duration) var(--pp-motion-ease)}",
      ".takeover{border:1px solid rgba(202,218,255,.58);background:rgba(244,248,255,.13);color:#f8fbff}",
      ".takeover:hover:not(:disabled){background:rgba(244,248,255,.22);border-color:rgba(232,238,255,.78)}",
      ".takeover.confirm{background:linear-gradient(180deg,rgba(255,171,92,.27),rgba(255,171,92,.13));border-color:rgba(255,188,112,.68);color:var(--pp-stop-confirm-text)}",
      ".stop{border:1px solid rgba(255,93,96,.62);background:linear-gradient(180deg,rgba(255,93,96,.28),rgba(255,93,96,.13));color:#ffe4e2}",
      ".stop:hover:not(:disabled){background:rgba(255,93,96,.32);border-color:rgba(255,128,130,.82);color:#fff6f5}",
      ".takeover:active:not(:disabled),.stop:active:not(:disabled){transform:translateY(1px)}",
      ".takeover:disabled,.stop:disabled{opacity:.58;cursor:default;transform:none}",
      ".hide{display:none}",
      ".detail-toggle{display:none}",
      ":host(.delegated) .hide{display:inline-block}",
      ":host(.locked) .panel{bottom:24px;width:min(548px,calc(100vw - 32px));min-height:72px;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;align-items:center;column-gap:16px;row-gap:1px;padding:10px 11px 10px 15px;border-radius:16px;border-color:rgba(189,203,236,.27);background:linear-gradient(135deg,rgba(27,34,49,.96),rgba(35,42,57,.93));box-shadow:0 18px 48px rgba(9,17,40,.34),0 1px 0 rgba(255,255,255,.08) inset;backdrop-filter:blur(20px) saturate(1.12)}",
      ":host(.locked) .panel::before{content:\"\";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 4px 4px 0;background:linear-gradient(180deg,#9bb8ff 0%,#6f92ef 55%,rgba(111,146,239,.20) 100%);box-shadow:0 0 16px rgba(111,146,239,.52)}",
      ":host(.locked) .head{grid-column:1;grid-row:1;min-height:28px;padding:0;display:grid;grid-template-columns:29px minmax(0,1fr) 27px;gap:9px;align-items:center}",
      ":host(.locked) .pulse{position:relative;width:28px;height:28px;border-radius:99px;background:rgba(10,17,31,.44);box-shadow:0 0 0 1px rgba(255,255,255,.09) inset;animation:none}",
      ":host(.locked) .pulse::before{content:\"\";position:absolute;inset:6px;border:1.5px solid rgba(236,242,255,.88);border-top-color:#82a6ff;border-radius:99px;animation:ppSpin 1.2s linear infinite}",
      ":host(.locked) .pulse::after{content:\"\";position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:99px;background:#f8fbff;box-shadow:0 -9px 0 rgba(151,179,244,.72),0 9px 0 rgba(151,179,244,.72),9px 0 0 rgba(151,179,244,.72),-9px 0 0 rgba(151,179,244,.72)}",
      ":host(.locked) .title{font-size:14px;font-weight:740;letter-spacing:-.01em;color:#f8fbff}",
      ":host(.locked) .reveal,:host(.locked) .hide{display:none}",
      ":host(.locked) .detail-toggle{display:inline-grid;place-items:center;width:27px;height:27px;border-radius:8px;font-size:14px;line-height:1;background:rgba(244,248,255,.065);border:1px solid rgba(218,228,255,.13);color:rgba(226,234,250,.78)}",
      ":host(.locked) .detail-toggle:hover{background:rgba(244,248,255,.13);border-color:rgba(232,238,255,.26);color:#ffffff}",
      ":host(.locked.expanded) .detail-toggle{transform:rotate(180deg)}",
      ":host(.locked) .body{display:contents;padding:0}",
      ":host(.locked) .details{display:none}",
      ":host(.locked) .status-stack{grid-column:1;grid-row:2;display:block;min-width:0;margin-left:38px}",
      ":host(.locked) .status-line{display:flex;gap:6px;color:rgba(226,234,250,.72);font-size:11px;font-weight:650}",
      ":host(.locked) .status-dot{width:6px;height:6px;background:#82a6ff;box-shadow:0 0 10px rgba(130,166,255,.78)}",
      ":host(.locked) .state-row{margin-top:2px;min-width:0}",
      ":host(.locked) .state-chip{display:none}",
      ":host(.locked) .space-chip{display:block;width:100%;height:auto;padding:0;border:0;border-radius:0;background:transparent;color:rgba(205,215,235,.62);font-size:10.25px;font-weight:590;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ":host(.locked) .controls{grid-column:2;grid-row:1 / span 2;display:grid;grid-template-columns:100px 110px;gap:8px;align-self:center}",
      ":host(.locked) .takeover,:host(.locked) .stop{min-height:36px;border-radius:10px;font-size:12px;font-weight:730}",
      ":host(.locked) .takeover{border-color:rgba(157,181,235,.48);background:linear-gradient(180deg,rgba(139,165,225,.18),rgba(118,143,202,.11));color:#f5f8ff}",
      ":host(.locked) .takeover:hover:not(:disabled){background:rgba(139,165,225,.25);border-color:rgba(188,205,244,.68)}",
      ":host(.locked) .stop{border-color:rgba(255,106,109,.48);background:rgba(255,92,96,.10);color:#ffd9d8}",
      ":host(.locked) .stop:hover:not(:disabled){background:rgba(255,92,96,.18);border-color:rgba(255,132,134,.68);color:#fff1f0}",
      ":host(.offline.locked) .panel{border-color:rgba(255,188,112,.42)}",
      ":host(.offline.locked) .panel::before{background:linear-gradient(180deg,#ffc36f 0%,#d7953d 55%,rgba(215,149,61,.20) 100%);box-shadow:0 0 16px rgba(255,188,112,.42)}",
      ":host(.offline.locked) .status-dot{background:#ffc36f;box-shadow:0 0 10px rgba(255,188,112,.70)}",
      ":host(.locked) .takeover:focus-visible,:host(.locked) .stop:focus-visible,:host(.locked) .detail-toggle:focus-visible{outline:2px solid rgba(167,190,246,.92);outline-offset:2px}",
      ":host(.locked.expanded) .panel{min-height:0;grid-template-rows:auto auto auto;border-color:rgba(166,188,239,.34);background:linear-gradient(135deg,#192131 0%,#222c3e 100%);box-shadow:0 24px 64px rgba(6,12,28,.52),0 1px 0 rgba(255,255,255,.08) inset;backdrop-filter:none}",
      ":host(.locked.expanded) .control-note{display:block;margin-top:4px;color:#aebbd2;font-size:10.5px;font-weight:620}",
      ":host(.locked.expanded) .details{grid-column:1 / -1;grid-row:3;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 16px;margin-top:11px;padding:13px 14px 14px;border:1px solid rgba(157,183,239,.20);border-radius:12px;background:linear-gradient(145deg,#171e2b 0%,#1c2637 100%);box-shadow:inset 3px 0 0 rgba(126,158,239,.72),0 10px 24px rgba(5,10,24,.22);color:#f7faff}",
      ":host(.locked.expanded) .details::before{content:\"控制详情\";grid-column:1 / -1;color:#9db7ff;font-size:10px;font-weight:780;line-height:1;letter-spacing:.12em}",
      ":host(.locked.expanded) .meta{grid-column:1;min-width:0;margin:0;color:#e9effc;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11.5px;font-weight:650;line-height:1.45}",
      ":host(.locked.expanded) .elapsed{grid-column:2;justify-self:end;margin:0;color:#c2cee5;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;font-weight:620;line-height:1.45;white-space:nowrap}",
      ":host(.locked.expanded) .action,:host(.locked.expanded) .target,:host(.locked.expanded) .progress-text,:host(.locked.expanded) .progress-bar,:host(.locked.expanded) .next,:host(.locked.expanded) .sessions,:host(.locked.expanded) .recent{grid-column:1 / -1}",
      ":host(.locked.expanded) .action{margin:0;padding:10px 11px;border:1px solid rgba(157,183,239,.16);border-radius:9px;background:#202a3d;color:#f7faff;font-size:12.5px;font-weight:650;line-height:1.45;box-shadow:0 1px 0 rgba(255,255,255,.04) inset}",
      ":host(.locked.expanded) .target,:host(.locked.expanded) .next{margin:0;color:#c2cee5;font-size:11.5px;line-height:1.45}",
      ":host(.locked.expanded) .progress-text{margin:0;color:#e8eefb;font-size:11.5px;font-weight:680}",
      ":host(.locked.expanded) .progress-bar{margin:-4px 0 0;background:#303c52}",
      ":host(.locked.expanded) .sessions{margin:0;padding:9px 10px;border:1px solid rgba(157,183,239,.14);border-radius:9px;background:#1d2638}",
      ":host(.locked.expanded) .session-heading{color:#dbe6fb;font-size:11px;font-weight:720}",
      ":host(.locked.expanded) .session-row{color:#c2cee5}",
      ":host(.locked.expanded) .session-agent{color:#f3f7ff}",
      ":host(.locked.expanded) .session-name{color:#d6e0f2}",
      ":host(.locked.expanded) .session-time{color:#aebbd2}",
      ":host(.locked.expanded) .recent{margin:0;color:#c2cee5}",
      ":host(.locked.expanded) summary{color:#eaf1ff;font-size:11.5px;font-weight:720}",
      ":host(.locked.expanded) summary:hover{color:#ffffff}",
      ":host(.locked.expanded) .recent-text{color:#c2cee5;line-height:1.5}",
      "@media (max-width:640px){:host(.locked) .panel{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto;gap:6px;padding:11px 11px 11px 15px;width:min(420px,calc(100vw - 24px));bottom:14px}:host(.locked) .controls{grid-column:1;grid-row:3;width:100%;grid-template-columns:1fr 1fr;margin-top:2px}:host(.locked) .status-stack{grid-column:1;grid-row:2;margin-left:38px}:host(.locked) .takeover,:host(.locked) .stop{min-height:38px}:host(.locked.expanded) .details{grid-column:1;grid-row:4;grid-template-columns:1fr}:host(.locked.expanded) .elapsed{grid-column:1;justify-self:start}}",
      ":host(.collapsed) .panel{display:none}",
      ":host(.locked.collapsed) .panel{display:grid}",
      ":host(.reduced-motion.locked) .pulse::before{animation:none}"
    ].join("");
    buildOverlayDom(root, styleText);

    panel = root.querySelector(".panel");
    dot = root.querySelector(".dot");
    title = root.querySelector(".title");
    meta = root.querySelector(".meta");
    elapsed = root.querySelector(".elapsed");
    action = root.querySelector(".action");
    target = root.querySelector(".target");
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
    lockHint = root.querySelector(".lock-hint");
    stateChip = root.querySelector(".state-chip");
    spaceChip = root.querySelector(".space-chip");
    controlNote = root.querySelector(".control-note");
    takeoverButton = root.querySelector(".takeover");
    stopButton = root.querySelector(".stop");
    revealButton = root.querySelector(".reveal");
    hideButton = root.querySelector(".hide");
    detailToggleButton = root.querySelector(".detail-toggle");
    cursorLayer = root.querySelector(".pp-cursor-layer");
    agentCursor = root.querySelector(".pp-agent-cursor");
    recentSummary.tabIndex = 0;

    root.addEventListener("click", (event) => event.stopPropagation());
    root.addEventListener("dblclick", (event) => event.stopPropagation());
    root.addEventListener("pointerdown", (event) => event.stopPropagation());
    hideButton.addEventListener("click", () => {
      collapse();
      signal("hide");
    });
    revealButton.addEventListener("click", () => signal("reveal"));
    dot.addEventListener("click", () => expand());
    detailToggleButton.addEventListener("click", toggleDetails);
    takeoverButton.addEventListener("click", () => handleStopClick("takeover"));
    stopButton.addEventListener("click", () => handleStopClick("stop"));
    for (const control of [hideButton, revealButton, dot, detailToggleButton, takeoverButton, stopButton]) {
      control.addEventListener("keydown", handleKeyboardClick);
    }
    recent.addEventListener("toggle", updateInteractiveAria);
    recentSummary.addEventListener("keydown", handleRecentSummaryKeydown);
    // 捕获阶段监听页面上被 AI 派发（isTrusted）的按下事件，作为高亮触发源。
    agentPointerListener = handleAgentPointer;
    window.addEventListener("pointerdown", agentPointerListener, { capture: true, passive: true });

    document.documentElement.appendChild(host);
    setupHostReconnectTracking();
    setupReducedMotionTracking();
    setupThemeTracking();
    elapsedTimer = setInterval(() => {
      ensureHostConnected();
      updateElapsed();
      renderSessionList();
    }, 1000);
    render();
    requestAnimationFrame(clampHostIntoViewport);
  }

  // Gmail 等站点通过 CSP 强制 Trusted Types，任何 innerHTML 字符串赋值都会被浏览器拒绝。
  // 这里仅使用结构化 DOM API；样式写入 textContent，不申请站点的 Trusted Types policy。
  function buildOverlayDom(shadowRoot, styleText) {
    const styleNode = overlayNode("style");
    styleNode.textContent = styleText;

    const wrapNode = overlayNode("div", "wrap");
    const panelNode = overlayNode("section", "panel", {
      id: "pp-agent-overlay-panel",
      role: "group",
      "aria-labelledby": "pp-agent-overlay-title"
    });
    const headNode = overlayNode("div", "head");
    headNode.append(
      overlayNode("span", "pulse", { "aria-hidden": "true" }),
      overlayNode("span", "title", { id: "pp-agent-overlay-title" }),
      overlayNode("button", "icon-btn reveal", { type: "button", title: "", "aria-label": "" }, "⧉"),
      overlayNode("button", "icon-btn hide", {
        type: "button",
        title: "",
        "aria-label": "",
        "aria-controls": "pp-agent-overlay-panel"
      }, "−"),
      overlayNode("button", "icon-btn detail-toggle", {
        type: "button",
        title: "",
        "aria-label": "",
        "aria-controls": "pp-agent-overlay-details",
        "aria-expanded": "false"
      }, "⌄")
    );

    const bodyNode = overlayNode("div", "body");
    const statusStackNode = overlayNode("div", "status-stack");
    const statusLineNode = overlayNode("div", "status-line");
    statusLineNode.append(
      overlayNode("span", "status-dot", { "aria-hidden": "true" }),
      overlayNode("span", "lock-hint")
    );
    const stateRowNode = overlayNode("div", "state-row");
    stateRowNode.append(
      overlayNode("span", "state-chip"),
      overlayNode("span", "space-chip")
    );
    statusStackNode.append(statusLineNode, stateRowNode, overlayNode("div", "control-note"));

    const detailsNode = overlayNode("div", "details", { id: "pp-agent-overlay-details" });
    const progressBarNode = overlayNode("div", "progress-bar", {
      role: "progressbar",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-labelledby": "pp-agent-overlay-progress-text"
    });
    progressBarNode.append(overlayNode("span", "progress-fill"));
    const sessionsNode = overlayNode("div", "sessions");
    sessionsNode.append(
      overlayNode("div", "session-heading"),
      overlayNode("div", "session-list")
    );
    const recentNode = overlayNode("details", "recent");
    recentNode.append(
      overlayNode("summary", "", {
        "aria-controls": "pp-agent-overlay-recent-text",
        "aria-expanded": "false"
      }),
      overlayNode("span", "recent-text", { id: "pp-agent-overlay-recent-text" })
    );
    detailsNode.append(
      overlayNode("div", "meta"),
      overlayNode("div", "elapsed"),
      overlayNode("div", "action"),
      overlayNode("div", "target"),
      overlayNode("div", "progress-text", { id: "pp-agent-overlay-progress-text" }),
      progressBarNode,
      overlayNode("div", "next"),
      sessionsNode,
      recentNode
    );

    const controlsNode = overlayNode("div", "controls");
    controlsNode.append(
      overlayNode("button", "takeover", { type: "button" }),
      overlayNode("button", "stop", { type: "button" })
    );
    bodyNode.append(statusStackNode, detailsNode, controlsNode);
    panelNode.append(headNode, bodyNode);

    const dotNode = overlayNode("button", "dot", {
      type: "button",
      title: "",
      "aria-label": "",
      "aria-controls": "pp-agent-overlay-panel",
      "aria-expanded": "false"
    });
    dotNode.append(overlayNode("span", "pulse", { "aria-hidden": "true" }));
    wrapNode.append(panelNode, dotNode);

    // 合成光标层放在 .wrap 之外：.wrap 带 transform，会成为 fixed 定位的包含块。
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

    shadowRoot.append(styleNode, wrapNode, cursorLayerNode);
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

  function signal(actionName, options) {
    const binding = window[SIGNAL_NAME];
    if (typeof binding !== "function") {
      return;
    }
    const payload = { action: actionName };
    if (actionName === "stop" && options?.reason) {
      payload.reason = options.reason;
    }
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
      requestAnimationFrame(clampHostIntoViewport);
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
    ensureHostConnected();
    const copy = text();
    const taken = isDelegatedToUser();
    const offline = taken && state.agentOffline === true;
    const pending = state.handoffPending === true && !taken;
    const sessions = normalizedSessions();
    applyStaticText(copy);
    // 接管前后共用同一套紧凑状态条；delegated 只改变内容和控制权，不切回旧的大卡片。
    host.classList.add("locked");
    host.classList.toggle("delegated", taken);
    host.classList.toggle("offline", offline);
    host.classList.toggle("expanded", expanded);
    panel.classList.toggle("taken", taken);
    title.textContent = offline ? copy.offlineTitle : taken ? copy.takenTitle : pending ? copy.handoffTitle : copy.lockedTitle;
    const metaText = primarySessionIdentity(sessions, copy, false);
    meta.textContent = metaText;
    meta.title = metaText;
    meta.style.display = metaText ? "block" : "none";
    action.textContent = copy.actionPrefix + (offline ? copy.offlineAction : taken ? copy.takenAction : pending ? copy.handoffAction : state.stopError || currentActionText(copy));
    target.textContent = state.targetUrl ? copy.targetPrefix + state.targetUrl : "";
    target.style.display = state.targetUrl ? "block" : "none";

    renderProgress();
    next.textContent = state.nextStep ? copy.nextPrefix + state.nextStep : "";
    next.style.display = state.nextStep ? "block" : "none";
    renderSessionList();
    recent.style.display = state.lastMessage ? "block" : "none";
    recentText.textContent = state.lastMessage || "";
    lockHint.textContent = offline ? copy.offlineAction : taken ? copy.takenAction : pending ? copy.handoffAction : compactStatusText(sessions, copy);
    stateChip.textContent = taken ? copy.ownerUser : copy.ownerAgent;
    spaceChip.textContent = compactTaskSpaceText(sessions, copy);
    spaceChip.title = fullTaskSpaceText(sessions, copy);
    controlNote.textContent = offline ? copy.offlineAction : taken ? copy.hardStopSent : pending ? copy.handoffAction : copy.takeoverHint;
    updateElapsed();
    updateStopButton();
    host.classList.toggle("collapsed", taken && collapsed && !offline);
    updateInteractiveAria();
    requestAnimationFrame(clampHostIntoViewport);
  }

  function applyStaticText(copy) {
    revealButton.title = copy.revealTitle;
    revealButton.setAttribute("aria-label", copy.revealTitle);
    hideButton.title = copy.hideTitle;
    hideButton.setAttribute("aria-label", copy.hideTitle);
    dot.title = copy.expandTitle;
    dot.setAttribute("aria-label", copy.expandTitle);
    const detailsTitle = expanded ? copy.collapseDetailsTitle : copy.detailsTitle;
    detailToggleButton.title = detailsTitle;
    detailToggleButton.setAttribute("aria-label", detailsTitle);
    sessionHeading.textContent = copy.sessionHeading;
    recentSummary.textContent = copy.recentSummary;
  }

  function updateInteractiveAria() {
    if (hideButton) {
      hideButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    if (dot) {
      dot.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    if (recentSummary && recent) {
      recentSummary.setAttribute("aria-expanded", recent.open ? "true" : "false");
    }
    if (detailToggleButton) {
      detailToggleButton.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
  }

  function handleRecentSummaryKeydown(event) {
    if (!isActivationKey(event) || event.repeat) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    recent.open = !recent.open;
    updateInteractiveAria();
  }

  function titleText(sessions, copy) {
    if (sessions.length >= 2) {
      return copy.operatingPrefix + sessions.length + copy.sessionsSuffix;
    }
    return copy.operatingPrefix + (state.agent || sessions[0]?.agent || "Agent");
  }

  function compactTitleText(sessions, copy) {
    if (sessions.length >= 2) {
      return copy.multiTaskTitle(sessions.length);
    }
    const session = sessions[0] || {};
    return (
      state.sessionTitle ||
      session.sessionTitle ||
      meaningfulActionText() ||
      state.project ||
      session.project ||
      state.agent ||
      session.agent ||
      copy.defaultTask
    );
  }

  function compactStatusText(sessions, copy) {
    if (state.inputGuardState === "unavailable") {
      return copy.guardUnavailable;
    }
    if (state.inputGuardState !== "active") {
      return copy.guardStarting;
    }
    return copy.lockedHint;
  }

  function compactTaskSpaceText(sessions, copy) {
    const label = primarySessionIdentity(sessions, copy, true);
    const remaining = Math.max(0, sessions.length - 1);
    return label + (remaining ? " · +" + remaining : "");
  }

  function fullTaskSpaceText(sessions, copy) {
    if (!sessions.length) {
      return primarySessionIdentity(sessions, copy, false);
    }
    return sessions.map((session, index) => {
      const identity = index === 0 ? primarySessionIdentity(sessions, copy, false) : sessionIdentity(session, copy, false);
      return (session.agent || "Agent") + " · " + identity;
    }).join("\n");
  }

  function primarySessionIdentity(sessions, copy, compact) {
    const session = sessions[0] || {};
    return sessionIdentity({
      project: state.project || session.project,
      session: state.session || session.session,
      sessionTitle: state.sessionTitle || session.sessionTitle
    }, copy, compact);
  }

  function sessionIdentity(session, copy, compact) {
    const parts = [];
    if (session.project) {
      parts.push(copy.projectPrefix + " " + session.project);
    }
    if (session.session) {
      parts.push(copy.sessionPrefix + " " + (compact ? compactSessionId(session.session) : session.session));
    }
    if (parts.length) {
      return parts.join(" · ");
    }
    return session.sessionTitle || copy.taskSpacePrefix + " · " + copy.defaultTask;
  }

  function compactSessionId(value) {
    const session = String(value || "");
    if (session.length <= 22) {
      return session;
    }
    return session.slice(0, 13) + "…" + session.slice(-4);
  }

  function currentActionText(copy) {
    if (!state.currentAction || state.currentAction === OVERLAY_TEXT.zh.defaultAction || state.currentAction === OVERLAY_TEXT.en.defaultAction) {
      return copy.defaultAction;
    }
    return state.currentAction;
  }

  function meaningfulActionText() {
    if (!state.currentAction || state.currentAction === OVERLAY_TEXT.zh.defaultAction || state.currentAction === OVERLAY_TEXT.en.defaultAction) {
      return "";
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
      progressBar.setAttribute("aria-valuenow", String(percent));
      progressBar.setAttribute("aria-valuetext", copy.progressDone(Math.max(0, done), total));
      progressFill.style.width = percent + "%";
    } else {
      progressBar.style.display = "none";
      progressBar.removeAttribute("aria-valuenow");
      progressBar.removeAttribute("aria-valuetext");
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
    const copy = text();
    for (const item of sessions) {
      const row = document.createElement("div");
      row.className = "session-row";
      const agent = document.createElement("div");
      agent.className = "session-agent";
      agent.textContent = item.agent || "Agent";
      const name = document.createElement("div");
      name.className = "session-name";
      name.textContent = sessionIdentity(item, copy, true) || copy.unnamedSession;
      name.title = sessionIdentity(item, copy, false);
      const time = document.createElement("div");
      time.className = "session-time";
      time.textContent = item.lastActive ? formatRelativeTime(item.lastActive) : copy.unknownActivity;
      row.append(agent, name, time);
      sessionList.appendChild(row);
    }
  }

  function updateElapsed() {
    if (!elapsed) {
      return;
    }
    const taken = isDelegatedToUser();
    const startedAt = taken && state.controlSince
      ? state.controlSince
      : state.startedAt || normalizedSessions()[0]?.startedAt || "";
    const startedTs = Date.parse(startedAt);
    if (!Number.isFinite(startedTs)) {
      elapsed.textContent = "";
      elapsed.style.display = "none";
      return;
    }
    elapsed.textContent = (taken ? text().takenElapsedPrefix : text().elapsedPrefix) + formatDuration(Date.now() - startedTs);
    elapsed.style.display = "block";
  }

  function handleStopClick(kind) {
    const button = kind === "takeover" ? takeoverButton : stopButton;
    if (!button || button.disabled) {
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
    resetStopConfirm();
    try {
      // Suppress leaked/late future-document bootstraps during the terminal stop window.
      // A later Agent Session clears this tab-scoped marker before installing its own bootstrap.
      window.sessionStorage.setItem(TERMINAL_STOP_KEY, String(Date.now() + 120000));
    } catch {
      // Main-process script removal still handles pages without sessionStorage.
    }
    signal("stop", { stopAll: true, reason: "user_stop" });
    // The binding call has been dispatched; run the full teardown so the host observer cannot
    // reattach the box while Gateway/daemon teardown settles.
    window.__ppAgentOverlayTeardown?.();
  }

  function updateStopButton() {
    const taken = isDelegatedToUser();
    const offline = taken && state.agentOffline === true;
    const hasBinding = typeof window[SIGNAL_NAME] === "function";
    const pending = state.handoffPending === true;
    takeoverButton.disabled = !hasBinding || pending || offline;
    stopButton.disabled = !hasBinding || pending;
    if (offline) {
      takeoverButton.textContent = text().offlineButton;
      takeoverButton.title = text().offlineButton;
      takeoverButton.setAttribute("aria-label", text().offlineButton);
      const stopLabel = stopConfirming && stopConfirmKind === "stop" ? text().confirmRelease : text().releaseProfile;
      stopButton.textContent = stopLabel;
      stopButton.title = stopLabel;
      stopButton.setAttribute("aria-label", stopLabel);
      return;
    }
    if (taken) {
      takeoverButton.textContent = text().returnToAgent;
      takeoverButton.title = text().returnToAgent;
      takeoverButton.setAttribute("aria-label", text().returnToAgent);
      const stopLabel = stopConfirming && stopConfirmKind === "stop" ? text().confirmStop : isMultiSession() ? text().stopAll : text().stopSingle;
      stopButton.textContent = stopLabel;
      stopButton.title = stopLabel;
      stopButton.setAttribute("aria-label", stopLabel);
      return;
    }
    const takeoverLabel = text().takeover;
    const stopLabel = stopConfirming && stopConfirmKind === "stop" ? text().confirmStop : isMultiSession() ? text().stopAll : text().stopSingle;
    takeoverButton.textContent = takeoverLabel;
    takeoverButton.title = takeoverLabel;
    takeoverButton.setAttribute("aria-label", takeoverLabel);
    stopButton.textContent = stopLabel;
    stopButton.title = stopLabel;
    stopButton.setAttribute("aria-label", stopLabel);
  }

  function resetStopConfirm() {
    stopConfirming = false;
    stopConfirmKind = "";
    clearTimeout(stopConfirmTimer);
    stopConfirmTimer = null;
    if (takeoverButton) {
      takeoverButton.classList.remove("confirm");
      if (isDelegatedToUser()) {
        const takeoverLabel = state.agentOffline === true ? text().offlineButton : text().returnToAgent;
        takeoverButton.textContent = takeoverLabel;
        takeoverButton.title = takeoverLabel;
        takeoverButton.setAttribute("aria-label", takeoverLabel);
      } else {
        takeoverButton.textContent = text().takeover;
        takeoverButton.title = text().takeover;
        takeoverButton.setAttribute("aria-label", text().takeover);
      }
    }
    if (stopButton) {
      stopButton.classList.remove("confirm");
      const label = isDelegatedToUser() && state.agentOffline === true
        ? text().releaseProfile
        : isMultiSession() ? text().stopAll : text().stopSingle;
      stopButton.textContent = label;
      stopButton.title = label;
      stopButton.setAttribute("aria-label", label);
    }
  }

  // Input Guard 在 macOS 原生层先吞掉真实点击，再把同一次按下/抬起的全局坐标和
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

    const button = downAction === "takeover" ? takeoverButton : stopButton;
    if (!button || button.disabled) {
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
    handleStopClick(probe.action);
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
      ["takeover", takeoverButton],
      ["stop", stopButton]
    ];
    for (const [kind, button] of entries) {
      if (!button || button.disabled) {
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

  function collapse() {
    if (!isDelegatedToUser()) {
      return;
    }
    collapsed = true;
    persistCollapsed();
    render();
  }

  function expand() {
    collapsed = false;
    persistCollapsed();
    render();
  }

  function toggleDetails() {
    expanded = !expanded;
    persistExpanded();
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

  function persistExpanded() {
    try {
      sessionStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0");
    } catch {
      // sessionStorage may be disabled.
    }
  }

  function readExpanded() {
    try {
      return sessionStorage.getItem(EXPANDED_KEY) === "1";
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
    if (key === "handoffPending" || key === "agentOffline") {
      return value === true;
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
    const wasDelegatedToUser = isDelegatedToUser();
    for (const key of KNOWN_STATE_FIELDS) {
      state[key] = normalizeKnownStateValue(key, payload[key]);
    }
    if (isDelegatedToUser()) {
      if (!wasDelegatedToUser) {
        resetStopConfirm();
      }
      clearTimeout(takenOverTimer);
      if (state.agentOffline === true) {
        collapsed = false;
      } else {
        takenOverTimer = setTimeout(() => collapse(), 5000);
      }
    }
    ensureHostConnected();
    render();
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

  window.__ppAgentOverlayTeardown = () => {
    if (tearingDown) {
      return;
    }
    tearingDown = true;
    clearTimeout(takenOverTimer);
    clearInterval(elapsedTimer);
    clearTimeout(cursorHideTimer);
    if (agentPointerListener) {
      window.removeEventListener("pointerdown", agentPointerListener, true);
      agentPointerListener = null;
    }
    cleanupHostReconnectTracking();
    cleanupReducedMotionTracking();
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
      delete window.__ppAgentOverlayHighlightAt;
      delete window.__ppAgentOverlayGuardProbe;
      delete window.__ppAgentOverlayGuardActivate;
      delete window.__ppAgentOverlayTeardown;
      delete window[SIGNAL_NAME];
    };
    if (host) {
      host.classList.add("leaving");
      setTimeout(cleanup, isReducedMotionPreferred() ? 0 : 180);
    } else {
      cleanup();
    }
  };

  mount();
})();`;
}
