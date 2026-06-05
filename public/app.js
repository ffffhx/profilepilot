const app = document.querySelector("#app");

let state = null;
let selectedId = null;
let modal = null;
let busy = false;
let toast = null;
let toastKind = "normal";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
}

async function loadState() {
  state = await api("/api/state");
  const profiles = state.profiles || [];

  if (!profiles.some((profile) => profile.id === selectedId)) {
    selectedId = state.currentProfile?.id || profiles[0]?.id || null;
  }

  render();
}

function setToast(message, kind = "normal") {
  toast = message;
  toastKind = kind;
  render();

  window.clearTimeout(setToast.timer);
  setToast.timer = window.setTimeout(() => {
    toast = null;
    render();
  }, 3200);
}

async function withBusy(work, successMessage) {
  if (busy) {
    return;
  }

  busy = true;
  render();

  try {
    await work();
    if (successMessage) {
      setToast(successMessage);
    }
  } catch (error) {
    setToast(error.message, "error");
  } finally {
    busy = false;
    await loadState().catch((error) => setToast(error.message, "error"));
  }
}

function render() {
  if (!state) {
    app.innerHTML = '<div class="app-loading">Loading...</div>';
    return;
  }

  const profiles = state.profiles || [];
  const selected = profiles.find((profile) => profile.id === selectedId) || null;
  const runningNames = state.runningProfiles.map((profile) => profile.name).join(", ");
  const currentLabel = state.runningProfiles.length ? runningNames : state.currentProfile?.name || "未启动";
  const currentNote = state.runningProfiles.length
    ? `${state.runningProfiles.length} 个运行中`
    : state.currentProfile?.lastLaunchedAt
      ? `最近启动 ${formatDate(state.currentProfile.lastLaunchedAt)}`
      : "暂无记录";

  app.className = "";
  app.innerHTML = `
    <div class="shell">
      <header class="app-header">
        <div>
          <p class="eyebrow">Local Chrome Tool</p>
          <h1>Chrome Profile Manager</h1>
        </div>
        <div class="header-actions">
          <button type="button" data-action="refresh" ${busy ? "disabled" : ""}>刷新</button>
          <button type="button" class="primary" data-action="new-profile" ${busy ? "disabled" : ""}>新建 Profile</button>
        </div>
      </header>

      <section class="status-grid" aria-label="Profile status">
        <div class="status-item current">
          <span class="status-label">当前</span>
          <strong class="status-value">${escapeHtml(currentLabel)}</strong>
          <span class="status-note">${escapeHtml(currentNote)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Profile 数据</span>
          <strong class="status-value">${profiles.length}</strong>
          <span class="status-note">${escapeHtml(state.profilesDir)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Chrome</span>
          <strong class="status-value">${escapeHtml(state.chromeLauncher)}</strong>
          <span class="status-note">${escapeHtml(state.dataDir)}</span>
        </div>
      </section>

      <main class="layout">
        <section>
          <div class="section-head">
            <h2>Profiles</h2>
            <span class="count">${profiles.length}</span>
          </div>
          ${profiles.length ? renderTable(profiles) : renderEmpty()}
        </section>
        ${renderDetails(selected)}
      </main>
    </div>
    ${modal === "new" ? renderNewModal() : ""}
    ${toast ? `<div class="toast ${toastKind === "error" ? "error" : ""}" role="status">${escapeHtml(toast)}</div>` : ""}
  `;
}

function renderTable(profiles) {
  return `
    <div class="profiles-table-wrap">
      <table class="profiles-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>状态</th>
            <th>最近启动</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${profiles.map(renderProfileRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderProfileRow(profile) {
  const selected = profile.id === selectedId;
  return `
    <tr class="${selected ? "selected" : ""}">
      <td>
        <button type="button" class="profile-pick" data-action="select" data-id="${profile.id}">
          <span class="profile-name-line">
            <span class="status-dot ${profile.running ? "running" : ""}"></span>
            <span class="profile-name">${escapeHtml(profile.name)}</span>
          </span>
          <span class="profile-dir">${escapeHtml(profile.dirName)}</span>
        </button>
      </td>
      <td>
        <span class="state-pill ${profile.running ? "running" : ""}">
          ${profile.running ? "运行中" : "已停止"}
        </span>
      </td>
      <td class="date-cell">${formatDate(profile.lastLaunchedAt)}</td>
      <td>
        <div class="row-actions">
          <button type="button" data-action="launch" data-id="${profile.id}" ${busy ? "disabled" : ""}>启动</button>
          <button type="button" data-action="open-folder" data-id="${profile.id}" ${busy ? "disabled" : ""}>目录</button>
          <button type="button" class="danger" data-action="delete" data-id="${profile.id}" ${busy || profile.running ? "disabled" : ""}>删除</button>
        </div>
      </td>
    </tr>
  `;
}

function renderEmpty() {
  return `
    <div class="empty-state">
      <strong>还没有 Profile</strong>
      <button type="button" class="primary" data-action="new-profile">新建 Profile</button>
    </div>
  `;
}

function renderDetails(profile) {
  if (!profile) {
    return `
      <aside class="details">
        <div class="detail-title">
          <h2>详情</h2>
        </div>
        <div class="detail-list">
          <div class="detail-row">
            <span>状态</span>
            <strong>未选择</strong>
          </div>
        </div>
      </aside>
    `;
  }

  return `
    <aside class="details">
      <div class="detail-title">
        <h2>${escapeHtml(profile.name)}</h2>
        <span class="detail-status ${profile.running ? "running" : ""}">
          ${profile.running ? "运行中" : "已停止"}
        </span>
      </div>
      <div class="detail-list">
        <div class="detail-row">
          <span>ID</span>
          <strong>${escapeHtml(profile.id)}</strong>
        </div>
        <div class="detail-row">
          <span>创建时间</span>
          <strong>${formatDate(profile.createdAt)}</strong>
        </div>
        <div class="detail-row">
          <span>最近启动</span>
          <strong>${formatDate(profile.lastLaunchedAt)}</strong>
        </div>
        <div class="detail-row">
          <span>进程</span>
          <strong>${profile.pids.length ? profile.pids.join(", ") : "无"}</strong>
        </div>
        <div class="detail-row">
          <span>目录</span>
          <code class="path-box">${escapeHtml(profile.path)}</code>
        </div>
      </div>
    </aside>
  `;
}

function renderNewModal() {
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" data-create-form>
        <h2>新建 Profile</h2>
        <div class="field">
          <label for="profile-name">名称</label>
          <input id="profile-name" name="name" type="text" maxlength="80" autocomplete="off" required />
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="primary" ${busy ? "disabled" : ""}>创建</button>
        </div>
      </form>
    </div>
  `;
}

function formatDate(value) {
  if (!value) {
    return "从未";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }

  return dateFormatter.format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

app.addEventListener("click", (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }

  const action = actionTarget.dataset.action;
  const id = actionTarget.dataset.id;

  if (action === "new-profile") {
    modal = "new";
    render();
    window.setTimeout(() => document.querySelector("#profile-name")?.focus(), 0);
    return;
  }

  if (action === "close-modal") {
    if (event.target === actionTarget || actionTarget.tagName === "BUTTON") {
      modal = null;
      render();
    }
    return;
  }

  if (action === "refresh") {
    withBusy(() => loadState(), "已刷新");
    return;
  }

  if (action === "select") {
    selectedId = id;
    render();
    return;
  }

  if (action === "launch") {
    const profile = state.profiles.find((item) => item.id === id);
    withBusy(
      () =>
        api(`/api/profiles/${encodeURIComponent(id)}/launch`, {
          method: "POST",
          body: "{}"
        }),
      `已启动 ${profile?.name || "Profile"}`
    );
    return;
  }

  if (action === "open-folder") {
    withBusy(
      () =>
        api(`/api/profiles/${encodeURIComponent(id)}/open-folder`, {
          method: "POST",
          body: "{}"
        }),
      "已打开目录"
    );
    return;
  }

  if (action === "delete") {
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }

    const confirmed = window.confirm(`删除 "${profile.name}"？目录会先移到废纸篓。`);
    if (!confirmed) {
      return;
    }

    withBusy(
      () =>
        api(`/api/profiles/${encodeURIComponent(id)}`, {
          method: "DELETE"
        }),
      `已删除 ${profile.name}`
    );
  }
});

app.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-create-form]");
  if (!form) {
    return;
  }

  event.preventDefault();
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();

  withBusy(async () => {
    const nextState = await api("/api/profiles", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    state = nextState;
    selectedId = state.profiles[0]?.id || null;
    modal = null;
  }, `已创建 ${name}`);
});

loadState().catch((error) => {
  app.innerHTML = `<div class="app-loading">${escapeHtml(error.message)}</div>`;
});
