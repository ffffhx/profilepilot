interface StoredProfile {
  id: string;
  name: string;
  dirName: string;
  createdAt: string;
  lastLaunchedAt: string | null;
}

interface PublicProfile extends StoredProfile {
  path: string;
  running: boolean;
  pids: number[];
}

interface NativeChromeProfile {
  dirName: string;
  name: string;
  userName: string | null;
  path: string;
  isDefault: boolean;
}

interface AppState {
  appTitle: string;
  dataDir: string;
  profilesDir: string;
  profiles: PublicProfile[];
  nativeChromeProfiles: NativeChromeProfile[];
  runningProfiles: PublicProfile[];
  currentProfile: PublicProfile | null;
  chromeLauncher: string;
}

interface DeleteProfileResult {
  deletedProfile: StoredProfile;
  trashPath: string | null;
  state: AppState;
}

interface ProfileManagerApi {
  getState(): Promise<AppState>;
  createProfile(name: string): Promise<AppState>;
  launchProfile(id: string): Promise<AppState>;
  openProfileFolder(id: string): Promise<AppState>;
  deleteProfile(id: string): Promise<DeleteProfileResult>;
}

interface Window {
  profileManager: ProfileManagerApi;
}

type ModalState = "new" | null;
type ToastKind = "normal" | "error";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Missing #app root.");
}

const appRoot: HTMLDivElement = root;

let state: AppState | null = null;
let selectedId: string | null = null;
let modal: ModalState = null;
let busy = false;
let toast: string | null = null;
let toastKind: ToastKind = "normal";
let toastTimer: number | undefined;

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

function profileApi(): ProfileManagerApi {
  if (!window.profileManager) {
    throw new Error("Desktop bridge is not available.");
  }

  return window.profileManager;
}

async function loadState(): Promise<void> {
  state = await profileApi().getState();
  const profiles = state.profiles || [];

  if (!profiles.some((profile) => profile.id === selectedId)) {
    selectedId = state.currentProfile?.id || profiles[0]?.id || null;
  }

  render();
}

function setToast(message: string, kind: ToastKind = "normal"): void {
  toast = message;
  toastKind = kind;
  render();

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast = null;
    render();
  }, 3200);
}

async function withBusy(work: () => Promise<unknown>, successMessage?: string): Promise<void> {
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
    setToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    busy = false;
    await loadState().catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error), "error"));
  }
}

function render(): void {
  if (!state) {
    appRoot.innerHTML = '<div class="app-loading">Loading...</div>';
    return;
  }

  const profiles = state.profiles || [];
  const nativeProfiles = state.nativeChromeProfiles || [];
  const selected = profiles.find((profile) => profile.id === selectedId) || null;
  const runningNames = state.runningProfiles.map((profile) => profile.name).join(", ");
  const currentLabel = state.runningProfiles.length ? runningNames : state.currentProfile?.name || "未启动";
  const currentNote = state.runningProfiles.length
    ? `${state.runningProfiles.length} 个运行中`
    : state.currentProfile?.lastLaunchedAt
      ? `最近启动 ${formatDate(state.currentProfile.lastLaunchedAt)}`
      : "暂无记录";

  appRoot.className = "";
  appRoot.innerHTML = `
    <div class="shell">
      <header class="app-header">
        <div>
          <p class="eyebrow">Desktop Chrome Tool</p>
          <h1>Chrome Profile Manager</h1>
        </div>
        <div class="header-actions">
          <button type="button" data-action="refresh" ${busy ? "disabled" : ""}>刷新</button>
          <button type="button" class="primary" data-action="new-profile" ${busy ? "disabled" : ""}>新建 Profile</button>
        </div>
      </header>

      <section class="status-grid" aria-label="Profile status">
        <div class="status-item current">
          <span class="status-label">当前托管</span>
          <strong class="status-value">${escapeHtml(currentLabel)}</strong>
          <span class="status-note">${escapeHtml(currentNote)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">托管 Profiles</span>
          <strong class="status-value">${profiles.length}</strong>
          <span class="status-note">${escapeHtml(state.profilesDir)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Chrome 原生</span>
          <strong class="status-value">${nativeProfiles.length}</strong>
          <span class="status-note">只读显示，不参与新建/删除</span>
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
            <h2>托管 Profiles</h2>
            <span class="count">${profiles.length}</span>
          </div>
          ${profiles.length ? renderTable(profiles) : renderEmpty()}
          <div class="native-section">
            <div class="section-head">
              <h2>Chrome 原生 Profiles</h2>
              <span class="count">${nativeProfiles.length}</span>
            </div>
            ${nativeProfiles.length ? renderNativeTable(nativeProfiles) : renderNativeEmpty()}
          </div>
        </section>
        ${renderDetails(selected)}
      </main>
    </div>
    ${modal === "new" ? renderNewModal() : ""}
    ${toast ? `<div class="toast ${toastKind === "error" ? "error" : ""}" role="status">${escapeHtml(toast)}</div>` : ""}
  `;
}

function renderTable(profiles: PublicProfile[]): string {
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

function renderProfileRow(profile: PublicProfile): string {
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

function renderEmpty(): string {
  return `
    <div class="empty-state">
      <strong>还没有托管 Profile</strong>
      <button type="button" class="primary" data-action="new-profile">新建 Profile</button>
    </div>
  `;
}

function renderNativeTable(profiles: NativeChromeProfile[]): string {
  return `
    <div class="profiles-table-wrap native-table-wrap">
      <table class="profiles-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>目录</th>
            <th>账号</th>
          </tr>
        </thead>
        <tbody>
          ${profiles.map(renderNativeProfileRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderNativeProfileRow(profile: NativeChromeProfile): string {
  return `
    <tr>
      <td>
        <span class="profile-name-line">
          <span class="status-dot native"></span>
          <span class="profile-name">${escapeHtml(profile.name)}</span>
          ${profile.isDefault ? '<span class="native-badge">Default</span>' : ""}
        </span>
      </td>
      <td>
        <span class="profile-dir">${escapeHtml(profile.dirName)}</span>
      </td>
      <td class="date-cell">${escapeHtml(profile.userName || "未登录")}</td>
    </tr>
  `;
}

function renderNativeEmpty(): string {
  return `
    <div class="empty-state compact">
      <strong>未发现 Chrome 原生 Profile</strong>
    </div>
  `;
}

function renderDetails(profile: PublicProfile | null): string {
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

function renderNewModal(): string {
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

function formatDate(value: string | null): string {
  if (!value) {
    return "从未";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }

  return dateFormatter.format(date);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

appRoot.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const actionTarget = target?.closest<HTMLElement>("[data-action]");
  if (!actionTarget || !state) {
    return;
  }

  const action = actionTarget.dataset.action;
  const id = actionTarget.dataset.id || null;

  if (action === "new-profile") {
    modal = "new";
    render();
    window.setTimeout(() => document.querySelector<HTMLInputElement>("#profile-name")?.focus(), 0);
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
    void withBusy(() => loadState(), "已刷新");
    return;
  }

  if (action === "select" && id) {
    selectedId = id;
    render();
    return;
  }

  if (action === "launch" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    void withBusy(() => profileApi().launchProfile(id), `已启动 ${profile?.name || "Profile"}`);
    return;
  }

  if (action === "open-folder" && id) {
    void withBusy(() => profileApi().openProfileFolder(id), "已打开目录");
    return;
  }

  if (action === "delete" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }

    const confirmed = window.confirm(`删除 "${profile.name}"？目录会先移到废纸篓。`);
    if (!confirmed) {
      return;
    }

    void withBusy(() => profileApi().deleteProfile(id), `已删除 ${profile.name}`);
  }
});

appRoot.addEventListener("submit", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const form = target?.closest<HTMLFormElement>("[data-create-form]");
  if (!form) {
    return;
  }

  event.preventDefault();
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();

  void withBusy(async () => {
    const nextState = await profileApi().createProfile(name);
    state = nextState;
    selectedId = state.profiles[0]?.id || null;
    modal = null;
  }, `已创建 ${name}`);
});

loadState().catch((error: unknown) => {
  appRoot.innerHTML = `<div class="app-loading">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
});
