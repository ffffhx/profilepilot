import type { ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

const esc = (value: string) =>
  value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <rect x="28" y="24" width="72" height="52" rx="10" fill="none" stroke="#ffffff" stroke-width="7"/>
  <path d="M46 94h36M64 76v18" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
  <circle cx="52" cy="50" r="5" fill="#93c5fd"/>
  <path d="M64 50h18" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>
</svg>`;

const SERVICE_WORKER_JS = `"use strict";
const CACHE_NAME = "ppilot-mobile-pwa-v1";
const SHELL_ASSETS = ["/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/v1/")) return;
  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(req).then(cached => cached || fetch(req)));
  }
});
`;

export function buildMobileManifest(computerName: string): string {
  return JSON.stringify({
    name: `ProfilePilot · ${computerName}`,
    short_name: "ProfilePilot",
    description: "在手机浏览器中远程查看、创建与审批电脑 ProfilePilot 任务",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b1120",
    theme_color: "#2563eb",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any maskable"
      }
    ]
  }, null, 2);
}

export function buildMobilePwaHtml(computerName: string, nonce: string): string {
  const safeComputer = esc(computerName);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#2563eb" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0b1120" media="(prefers-color-scheme: dark)">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="ProfilePilot">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon.svg">
  <title>ProfilePilot 移动工作台 · ${safeComputer}</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --bg: #f4f6fb;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --primary: #2563eb;
      --primary-fg: #ffffff;
      --success: #16a34a;
      --warn: #d97706;
      --danger: #dc2626;
      --chip: #eff6ff;
      --chip-fg: #1d4ed8;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1120;
        --card: #131c31;
        --text: #f1f5f9;
        --muted: #94a3b8;
        --line: #1e293b;
        --primary: #3b82f6;
        --primary-fg: #ffffff;
        --success: #22c55e;
        --warn: #f59e0b;
        --danger: #ef4444;
        --chip: #1e293b;
        --chip-fg: #93c5fd;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) calc(24px + env(safe-area-inset-bottom, 0px)) env(safe-area-inset-left, 0px);
    }
    .shell { max-width: 680px; margin: 0 auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
    .topbar {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 12px 14px;
    }
    .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .brand img { width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0; }
    .brand h1 { font-size: 16px; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .brand small { display: block; font-size: 12px; color: var(--muted); }
    .top-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    .card h2 { margin: 0; font-size: 15px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .muted { color: var(--muted); font-size: 13px; margin: 0; }
    .banner { border-radius: 12px; padding: 10px 12px; font-size: 13px; border: 1px solid var(--line); background: var(--chip); color: var(--chip-fg); }
    .banner[data-error="true"] { background: rgba(220, 38, 38, 0.12); color: var(--danger); border-color: rgba(220, 38, 38, 0.35); }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 500; }
    select, textarea, input {
      width: 100%; border-radius: 10px; border: 1px solid var(--line); background: var(--bg);
      color: var(--text); font: inherit; font-size: 15px; padding: 10px 12px;
    }
    textarea { min-height: 84px; resize: vertical; }
    button {
      appearance: none; border: 1px solid var(--line); background: var(--card); color: var(--text);
      border-radius: 10px; min-height: 40px; padding: 8px 14px; font: inherit; font-size: 14px; font-weight: 500;
      cursor: pointer; touch-action: manipulation;
    }
    button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-fg); }
    button.warn { background: var(--warn); border-color: var(--warn); color: #fff; }
    button.danger { color: var(--danger); border-color: rgba(220, 38, 38, 0.35); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .task-list { display: flex; flex-direction: column; gap: 8px; }
    .task-item {
      text-align: left; width: 100%; display: flex; flex-direction: column; gap: 4px;
      padding: 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg);
    }
    .task-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; width: 100%; }
    .task-title { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--chip); color: var(--chip-fg); flex-shrink: 0; }
    .badge[data-tone="warn"] { background: rgba(217, 119, 6, 0.16); color: var(--warn); }
    .badge[data-tone="ok"] { background: rgba(22, 163, 74, 0.16); color: var(--success); }
    .badge[data-tone="danger"] { background: rgba(220, 38, 38, 0.16); color: var(--danger); }
    .pending-box {
      border: 1px solid rgba(217, 119, 6, 0.5); background: rgba(217, 119, 6, 0.1);
      border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px;
    }
    .pending-box strong { font-size: 14px; }
    .pending-box pre, .event-item pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 13px; }
    .timeline { display: flex; flex-direction: column; gap: 8px; max-height: 360px; overflow-y: auto; }
    .event-item { padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); font-size: 13px; }
    .event-meta { font-size: 11px; color: var(--muted); margin-bottom: 3px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <img src="/icon.svg" alt="">
        <div>
          <h1 id="pc-name">${safeComputer}</h1>
          <small id="conn-status">正在检查配对状态…</small>
        </div>
      </div>
      <div class="top-actions">
        <button type="button" id="btn-a2hs" hidden>添加到主屏幕</button>
        <button type="button" id="btn-disconnect" class="danger" hidden>断开此手机</button>
      </div>
    </header>

    <div id="notice" class="banner" role="status" hidden></div>

    <section id="unpaired-view" class="card" hidden>
      <h2>扫码连接电脑工作台</h2>
      <p class="muted">无需安装手机 App。请在电脑 ProfilePilot 打开「手机 → 用手机管理电脑任务」，点击「生成配对二维码」，再用 iPhone 相机 / Safari 或 Android 浏览器扫描打开。</p>
      <label>或在此粘贴一次性配对链接
        <input id="manual-pair-input" type="url" placeholder="https://电脑IP:端口/#pair=..." autocomplete="off">
      </label>
      <div class="row">
        <button type="button" id="btn-manual-pair" class="primary">立即配对</button>
      </div>
    </section>

    <main id="paired-view" hidden>
      <section id="composer-card" class="card">
        <h2>新建电脑任务 <span id="perm-badge" class="badge">可操作</span></h2>
        <label>执行环境
          <select id="task-profile">
            <option value="__device__">不绑定浏览器（电脑桌面 / 设备模式）</option>
          </select>
        </label>
        <label>执行方式
          <select id="task-mode">
            <option value="acceptEdits">自动执行（关键操作询问）</option>
            <option value="plan">先出方案再执行</option>
            <option value="manual">逐步确认</option>
          </select>
        </label>
        <label>任务内容
          <textarea id="task-prompt" maxlength="30000" placeholder="输入要让电脑执行的任务，例如：整理今天收到的待办并汇总结果…"></textarea>
        </label>
        <div class="row">
          <button type="button" id="btn-create-task" class="primary">发送到电脑执行</button>
          <button type="button" id="btn-refresh">刷新列表</button>
        </div>
      </section>

      <section id="detail-card" class="card" hidden>
        <h2>
          <span id="detail-title">任务详情</span>
          <button type="button" id="btn-close-detail">返回列表</button>
        </h2>
        <p class="muted" id="detail-meta"></p>
        <div id="pending-panel" class="pending-box" hidden>
          <strong id="pending-title">等待你的确认</strong>
          <pre id="pending-details"></pre>
          <div class="row" id="pending-buttons">
            <button type="button" id="btn-approve" class="primary">批准继续</button>
            <button type="button" id="btn-approve-session">本会话允许</button>
            <button type="button" id="btn-reject" class="danger">拒绝</button>
          </div>
        </div>
        <div class="row" id="control-buttons">
          <button type="button" id="btn-pause">暂停</button>
          <button type="button" id="btn-resume">继续</button>
          <button type="button" id="btn-cancel" class="danger">取消任务</button>
        </div>
        <div id="result-box" class="banner" hidden></div>
        <div id="timeline" class="timeline" aria-live="polite"></div>
        <form id="reply-form">
          <label id="reply-label">补充指令 / 回复问题
            <textarea id="reply-input" maxlength="30000" placeholder="发送补充说明，或回答当前问题…"></textarea>
          </label>
          <div class="row" style="margin-top:8px;">
            <button type="submit" id="btn-send-reply" class="primary">发送回复</button>
          </div>
        </form>
      </section>

      <section class="card">
        <h2>电脑任务列表 <span class="badge" id="task-count">0</span></h2>
        <div id="task-list" class="task-list"></div>
      </section>
    </main>
  </div>

  <script nonce="${nonce}">
  (() => {
    const SESSION_KEY = "ppilot_mobile_session";
    const CLIENT_ID_KEY = "ppilot_mobile_client_id";
    const DEVICE_PROFILE = "__device__";
    const $ = id => document.getElementById(id);

    const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
    function getClientId() {
      let id = localStorage.getItem(CLIENT_ID_KEY);
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
        id = uuid();
        localStorage.setItem(CLIENT_ID_KEY, id);
      }
      return id;
    }
    function detectPhoneName() {
      const ua = navigator.userAgent || "";
      if (/iPhone/i.test(ua)) return "iPhone Safari";
      if (/iPad/i.test(ua)) return "iPad Safari";
      if (/Android/i.test(ua)) return "Android 浏览器";
      return "手机网页工作台";
    }
    function readSession() {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && /^[a-f0-9]{64}$/.test(parsed.token) ? parsed : null;
      } catch { return null; }
    }
    function saveSession(value) {
      if (!value) localStorage.removeItem(SESSION_KEY);
      else localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    }

    let session = readSession();
    let syncState = null;
    let tasks = [];
    let selectedTaskId = "";
    let activeDetail = null;
    let busy = false;
    let deferredInstallPrompt = null;

    function showNotice(text, isError = false) {
      const el = $("notice");
      if (!text) { el.hidden = true; el.textContent = ""; return; }
      el.textContent = text;
      el.dataset.error = String(isError);
      el.hidden = false;
    }

    function consumePairHash(hashString) {
      const raw = (hashString || "").replace(/^#/, "");
      if (!raw) return null;
      const params = new URLSearchParams(raw);
      const pairToken = params.get("pair");
      if (!pairToken) return null;
      // Immediately clear #pair=... from URL bar and history before network activity.
      history.replaceState(null, "", location.pathname + location.search);
      return { token: pairToken.trim(), computerName: params.get("name") || "" };
    }

    async function exchangePairToken(pairToken, hintedName) {
      if (!/^[a-f0-9]{64}$/.test(pairToken)) {
        showNotice("配对链接格式无效，请在电脑重新生成配对二维码。", true);
        return;
      }
      showNotice("正在与电脑完成安全配对…");
      try {
        const res = await fetch("/v1/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: pairToken, clientId: getClientId(), name: detectPhoneName() })
        });
        const payload = await res.json();
        if (!payload.ok) throw new Error(payload.error?.message || "配对失败");
        session = {
          token: payload.data.token,
          deviceId: payload.data.deviceId,
          computerId: payload.data.computerId,
          computerName: payload.data.computerName || hintedName || ""
        };
        saveSession(session);
        showNotice("已成功连接电脑工作台！");
        await refreshAll();
      } catch (err) {
        showNotice(err.message || "配对失败，请在电脑重新生成二维码。", true);
        renderShell();
      }
    }

    async function rpc(command, requestId = uuid()) {
      if (!session?.token) throw new Error("尚未配对");
      const res = await fetch("/v1/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session.token
        },
        body: JSON.stringify({ requestId, issuedAt: Date.now(), command })
      });
      const payload = await res.json();
      if (!payload.ok) {
        if (payload.error?.code === "MOBILE_UNAUTHORIZED" || res.status === 401) {
          session = null;
          saveSession(null);
          renderShell();
        }
        const error = new Error(payload.error?.message || "请求失败");
        error.code = payload.error?.code;
        throw error;
      }
      return payload.data;
    }

    function statusLabel(status) {
      return ({
        running: ["执行中", "ok"],
        queued: ["排队中", ""],
        waiting_user: ["待确认", "warn"],
        paused: ["已暂停", "warn"],
        completed: ["已完成", "ok"],
        partial: ["部分完成", "warn"],
        failed: ["失败", "danger"],
        cancelled: ["已取消", ""]
      })[status] || [status || "未知", ""];
    }

    function renderProfiles(profiles) {
      const select = $("task-profile");
      const previous = select.value || DEVICE_PROFILE;
      select.textContent = "";
      const devOpt = document.createElement("option");
      devOpt.value = DEVICE_PROFILE;
      devOpt.textContent = "不绑定浏览器（电脑桌面 / 设备模式）";
      select.appendChild(devOpt);
      for (const p of profiles || []) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.disabled = !p.ready;
        opt.textContent = p.ready ? p.name : (p.name + "（" + (p.reason || "暂不可用") + "）");
        select.appendChild(opt);
      }
      if ([...select.options].some(o => o.value === previous && !o.disabled)) {
        select.value = previous;
      } else {
        const firstReady = (profiles || []).find(p => p.ready);
        select.value = firstReady ? firstReady.id : DEVICE_PROFILE;
      }
    }

    function renderTasks() {
      $("task-count").textContent = String(tasks.length);
      const list = $("task-list");
      list.textContent = "";
      if (!tasks.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "暂无任务。可在上方直接创建新任务。";
        list.appendChild(empty);
        return;
      }
      for (const item of tasks) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "task-item";
        const head = document.createElement("div");
        head.className = "task-head";
        const title = document.createElement("span");
        title.className = "task-title";
        title.textContent = item.title || "未命名任务";
        const [label, tone] = statusLabel(item.status);
        const badge = document.createElement("span");
        badge.className = "badge";
        if (tone) badge.dataset.tone = tone;
        badge.textContent = item.pending ? "待你确认" : label;
        head.append(title, badge);
        const sub = document.createElement("span");
        sub.className = "muted";
        sub.textContent = (item.profileName || "不绑定浏览器") + " · " + new Date(item.updatedAt).toLocaleTimeString();
        btn.append(head, sub);
        btn.addEventListener("click", () => {
          selectedTaskId = item.id;
          void refreshDetail();
        });
        list.appendChild(btn);
      }
    }

    function renderDetail() {
      const card = $("detail-card");
      if (!selectedTaskId || !activeDetail?.task) {
        card.hidden = true;
        return;
      }
      card.hidden = false;
      const task = activeDetail.task;
      const canControl = syncState?.canControl !== false;
      const [label] = statusLabel(task.status);
      $("detail-title").textContent = task.title || "任务详情";
      $("detail-meta").textContent = (task.profileName || "不绑定浏览器") + " · 状态：" + label;

      const pending = task.pending;
      const pendingPanel = $("pending-panel");
      if (pending) {
        pendingPanel.hidden = false;
        $("pending-title").textContent = pending.title || "等待确认";
        $("pending-details").textContent = pending.details || pending.action?.summary || "";
        const isQuestion = pending.kind === "question";
        $("pending-buttons").hidden = isQuestion;
        $("btn-approve").textContent = pending.kind === "handoff" ? "已完成操作，继续" : "批准继续";
        $("btn-approve").disabled = busy || !canControl;
        $("btn-approve-session").hidden = !pending.permissionScope || pending.kind !== "confirmation";
        $("btn-approve-session").disabled = busy || !canControl;
        $("btn-reject").hidden = pending.kind === "handoff";
        $("btn-reject").disabled = busy || !canControl;
      } else {
        pendingPanel.hidden = true;
      }

      const active = ["running", "queued", "waiting_user"].includes(task.status);
      $("btn-pause").disabled = busy || !canControl || !["running", "queued"].includes(task.status);
      $("btn-resume").disabled = busy || !canControl || task.status !== "paused";
      $("btn-cancel").disabled = busy || !canControl || (!active && task.status !== "paused");
      $("btn-send-reply").disabled = busy || !canControl;

      const resultBox = $("result-box");
      if (task.result?.summary) {
        resultBox.hidden = false;
        resultBox.dataset.error = String(task.status === "failed");
        resultBox.textContent = "结果：" + task.result.summary;
      } else {
        resultBox.hidden = true;
      }

      const timeline = $("timeline");
      timeline.textContent = "";
      const events = activeDetail.events || [];
      for (const ev of events.slice(-40)) {
        const div = document.createElement("div");
        div.className = "event-item";
        const meta = document.createElement("div");
        meta.className = "event-meta";
        meta.textContent = ev.kind + " · " + new Date(ev.at).toLocaleTimeString();
        const pre = document.createElement("pre");
        pre.textContent = ev.text;
        div.append(meta, pre);
        timeline.appendChild(div);
      }
      if (activeDetail.stream?.text) {
        const div = document.createElement("div");
        div.className = "event-item";
        const pre = document.createElement("pre");
        pre.textContent = activeDetail.stream.text;
        div.appendChild(pre);
        timeline.appendChild(div);
      }
    }

    function renderShell() {
      const paired = !!session?.token;
      $("unpaired-view").hidden = paired;
      $("paired-view").hidden = !paired;
      $("btn-disconnect").hidden = !paired;
      if (!paired) {
        $("conn-status").textContent = "未连接 · 扫码即用";
        return;
      }
      if (session.computerName) $("pc-name").textContent = session.computerName;
      const canControl = syncState?.canControl !== false;
      $("conn-status").textContent = syncState ? ("已连接 · " + (canControl ? "可创建与控制任务" : "仅查看模式")) : "正在同步电脑状态…";
      $("perm-badge").textContent = canControl ? "可操作" : "仅查看";
      $("perm-badge").dataset.tone = canControl ? "ok" : "warn";
      $("btn-create-task").disabled = busy || !canControl;
    }

    async function refreshDetail() {
      if (!selectedTaskId || !session?.token) { renderDetail(); return; }
      try {
        activeDetail = await rpc({ action: "task.detail", id: selectedTaskId, limit: 80 });
        renderDetail();
      } catch (err) {
        showNotice(err.message, true);
      }
    }

    async function refreshAll() {
      if (!session?.token) { renderShell(); return; }
      try {
        const [sync, listResult] = await Promise.all([
          rpc({ action: "sync" }),
          rpc({ action: "task.list", limit: 50 }).catch(() => null)
        ]);
        syncState = sync;
        if (sync.computerName) {
          session.computerName = sync.computerName;
          saveSession(session);
        }
        const pendingById = new Map((sync.tasks || []).map(t => [t.id, t.pending]));
        tasks = ((listResult && listResult.tasks) || sync.tasks || []).map(t => ({
          ...t,
          ...(pendingById.get(t.id) ? { pending: pendingById.get(t.id) } : {})
        }));
        renderProfiles(sync.profiles || []);
        renderShell();
        renderTasks();
        if (selectedTaskId) await refreshDetail();
      } catch (err) {
        if (session) showNotice(err.message, true);
      }
    }

    async function withBusy(fn) {
      if (busy) return;
      busy = true;
      renderShell();
      renderDetail();
      try { await fn(); }
      catch (err) { showNotice(err.message || "操作失败", true); }
      finally { busy = false; renderShell(); renderDetail(); }
    }

    $("btn-manual-pair").addEventListener("click", () => {
      const val = $("manual-pair-input").value.trim();
      try {
        const parsed = val.startsWith("#") ? consumePairHash(val) : consumePairHash(new URL(val).hash);
        if (!parsed) throw new Error("未找到 #pair= 配对参数");
        $("manual-pair-input").value = "";
        void exchangePairToken(parsed.token, parsed.computerName);
      } catch (err) {
        showNotice(err.message || "请输入完整的网页配对链接", true);
      }
    });

    $("btn-refresh").addEventListener("click", () => void refreshAll());

    $("btn-create-task").addEventListener("click", () => void withBusy(async () => {
      const prompt = $("task-prompt").value.trim();
      if (!prompt) { showNotice("请输入任务内容。", true); return; }
      const profile = $("task-profile").value || DEVICE_PROFILE;
      const mode = $("task-mode").value || "acceptEdits";
      const res = await rpc({ action: "task.create", profile, input: { prompt, mode } });
      $("task-prompt").value = "";
      showNotice("任务已发送到电脑执行。");
      if (res?.task?.id) selectedTaskId = res.task.id;
      await refreshAll();
    }));

    $("btn-close-detail").addEventListener("click", () => {
      selectedTaskId = "";
      activeDetail = null;
      renderDetail();
    });

    async function sendPendingDecision(approved, scope) {
      const pending = activeDetail?.task?.pending;
      if (!pending || !selectedTaskId) return;
      await withBusy(async () => {
        const answer = $("reply-input").value.trim();
        await rpc({
          action: "task.reply",
          id: selectedTaskId,
          decisionId: pending.id,
          answer,
          approved,
          ...(scope ? { scope } : {})
        });
        $("reply-input").value = "";
        showNotice(approved ? "已批准继续执行。" : "已拒绝该操作。");
        await refreshAll();
      });
    }

    $("btn-approve").addEventListener("click", () => void sendPendingDecision(true));
    $("btn-approve-session").addEventListener("click", () => void sendPendingDecision(true, "session"));
    $("btn-reject").addEventListener("click", () => void sendPendingDecision(false));

    for (const [btnId, control] of [["btn-pause", "pause"], ["btn-resume", "resume"], ["btn-cancel", "cancel"]]) {
      $(btnId).addEventListener("click", () => void withBusy(async () => {
        if (!selectedTaskId) return;
        await rpc({ action: "task.control", id: selectedTaskId, control });
        await refreshAll();
      }));
    }

    $("reply-form").addEventListener("submit", event => {
      event.preventDefault();
      void withBusy(async () => {
        const message = $("reply-input").value.trim();
        if (!message || !selectedTaskId || !activeDetail?.task) return;
        const task = activeDetail.task;
        if (task.pending?.kind === "question") {
          await rpc({ action: "task.reply", id: selectedTaskId, decisionId: task.pending.id, answer: message, approved: false });
        } else if (["running", "queued", "waiting_user"].includes(task.status)) {
          await rpc({ action: "task.control", id: selectedTaskId, control: "steer", message, requestId: uuid() });
        } else {
          await rpc({ action: "task.control", id: selectedTaskId, control: "resume", message, requestId: uuid() });
        }
        $("reply-input").value = "";
        showNotice("已发送回复。");
        await refreshAll();
      });
    });

    $("btn-disconnect").addEventListener("click", () => void withBusy(async () => {
      try { await rpc({ action: "device.disconnect" }); } catch { /* Already revoked or offline */ }
      session = null;
      syncState = null;
      activeDetail = null;
      selectedTaskId = "";
      saveSession(null);
      showNotice("已断开此手机的远程授权。");
      renderShell();
    }));

    // Add to Home Screen support (Android beforeinstallprompt + iOS Safari instruction)
    const isStandalone = window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
    const isIosSafari = /iPhone|iPad/i.test(navigator.userAgent || "") && !isStandalone;
    if (isIosSafari) {
      $("btn-a2hs").hidden = false;
    }
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      deferredInstallPrompt = event;
      $("btn-a2hs").hidden = false;
    });
    $("btn-a2hs").addEventListener("click", async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice.catch(() => {});
        deferredInstallPrompt = null;
        $("btn-a2hs").hidden = true;
      } else {
        showNotice("在 Safari 底部点击「分享」图标，选择「添加到主屏幕」，即可像原生 App 一样全屏使用。");
      }
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    const fromHash = consumePairHash(location.hash);
    renderShell();
    if (fromHash) {
      void exchangePairToken(fromHash.token, fromHash.computerName);
    } else if (session) {
      void refreshAll();
    }

    setInterval(() => {
      if (!document.hidden && session?.token && !busy) {
        void refreshAll();
      }
    }, 3500);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && session?.token) void refreshAll();
    });
  })();
  </script>
</body>
</html>`;
}

export function serveMobilePwaAsset(
  pathname: string,
  method: string,
  response: ServerResponse,
  computerName: string
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const commonHeaders: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY"
  };

  if (pathname === "/" || pathname === "/index.html") {
    const nonce = randomBytes(16).toString("base64");
    const html = buildMobilePwaHtml(computerName, nonce);
    response.writeHead(200, {
      ...commonHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    });
    response.end(method === "HEAD" ? undefined : html);
    return true;
  }

  if (pathname === "/manifest.webmanifest") {
    const manifest = buildMobileManifest(computerName);
    response.writeHead(200, {
      ...commonHeaders,
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-cache"
    });
    response.end(method === "HEAD" ? undefined : manifest);
    return true;
  }

  if (pathname === "/sw.js") {
    response.writeHead(200, {
      ...commonHeaders,
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
      "Cache-Control": "no-cache"
    });
    response.end(method === "HEAD" ? undefined : SERVICE_WORKER_JS);
    return true;
  }

  if (pathname === "/icon.svg") {
    response.writeHead(200, {
      ...commonHeaders,
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    });
    response.end(method === "HEAD" ? undefined : ICON_SVG);
    return true;
  }

  return false;
}
