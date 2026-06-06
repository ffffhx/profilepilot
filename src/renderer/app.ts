interface StoredProfile {
  id: string;
  name: string;
  dirName: string;
  createdAt: string;
  lastLaunchedAt: string | null;
  lastCdpPort?: number | null;
}

interface PublicProfile {
  id: string;
  source: ProfileSource;
  name: string;
  dirName: string;
  path: string;
  createdAt: string | null;
  lastLaunchedAt: string | null;
  userName: string | null;
  isDefault: boolean;
  deletable: boolean;
  running: boolean;
  pids: number[];
  cdpPort: number | null;
  cdpUrl: string | null;
  listeningPorts: number[];
}

type ProfileSource = "native" | "isolated";

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
  nativeProfileCount: number;
  isolatedProfileCount: number;
  nativeChromeProfiles: NativeChromeProfile[];
  runningProfiles: PublicProfile[];
  currentProfile: PublicProfile | null;
  chromeLauncher: string;
}

interface DeleteProfileResult {
  deletedProfile: PublicProfile;
  trashPath: string | null;
  state: AppState;
}

interface ProfileManagerApi {
  getState(): Promise<AppState>;
  createProfile(name: string): Promise<AppState>;
  launchProfile(id: string): Promise<AppState>;
  launchProfileWithCdp(id: string, port?: number | null): Promise<AppState>;
  focusProfile(id: string): Promise<AppState>;
  closeProfile(id: string): Promise<AppState>;
  openProfileFolder(id: string): Promise<AppState>;
  deleteProfile(id: string): Promise<DeleteProfileResult>;
}

interface Window {
  profileManager: ProfileManagerApi;
}

type ConfirmAction = "close" | "delete";
type ModalState =
  | { kind: "new" }
  | { kind: "cdp"; profileId: string }
  | {
      kind: "confirm";
      action: ConfirmAction;
      profileId: string;
    }
  | null;
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
  const selected = profiles.find((profile) => profile.id === selectedId) || null;
  const runningNames = state.runningProfiles.map((profile) => profile.name).join("、");
  const currentLabel = state.runningProfiles.length ? runningNames : "无";
  const currentNote = state.runningProfiles.length
    ? `${state.runningProfiles.length} 个 Profile 正在运行`
    : "当前没有正在运行的 Profile";

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
          <button type="button" class="primary" data-action="new-profile" ${busy ? "disabled" : ""}>新建独立 Profile</button>
        </div>
      </header>

      <section class="status-grid" aria-label="Profile status">
        <div class="status-item current">
          <span class="status-label">当前运行</span>
          <strong class="status-value">${escapeHtml(currentLabel)}</strong>
          <span class="status-note">${escapeHtml(currentNote)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Profiles</span>
          <strong class="status-value">${profiles.length}</strong>
          <span class="status-note">本机所有可管理的 Chrome Profile</span>
        </div>
        <div class="status-item">
          <span class="status-label">运行中</span>
          <strong class="status-value">${state.runningProfiles.length}</strong>
          <span class="status-note">可以点击“显示”拉到屏幕最前面</span>
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
    ${modal?.kind === "new" ? renderNewModal() : ""}
    ${modal?.kind === "cdp" ? renderCdpModal(modal.profileId) : ""}
    ${modal?.kind === "confirm" ? renderConfirmModal(modal) : ""}
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
            <th>类型</th>
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
  const launchDisabled = busy || profile.running;
  const cdpLaunchDisabled = busy || profile.running || profile.source !== "isolated";
  const focusDisabled = busy || !profile.running;
  const closeDisabled = busy || !profile.running;
  const deleteDisabled = busy || profile.running || !profile.deletable;
  return `
    <tr class="${selected ? "selected" : ""}" data-action="select" data-id="${profile.id}" data-profile-row tabindex="0" aria-selected="${selected ? "true" : "false"}">
      <td>
        <div class="profile-pick">
          <span class="profile-name-line">
            <span class="status-dot ${profile.running ? "running" : profile.source === "native" ? "native" : ""}"></span>
            <span class="profile-name">${escapeHtml(profile.name)}</span>
            ${profile.isDefault ? '<span class="native-badge">Default</span>' : ""}
          </span>
          <span class="profile-dir">${escapeHtml(profile.userName || profile.dirName)}</span>
        </div>
      </td>
      <td>
        <span class="source-pill ${profile.source}">${sourceLabel(profile)}</span>
      </td>
      <td>
        <span class="state-pill ${profile.running ? "running" : ""}">
          ${profileStatusLabel(profile)}
        </span>
      </td>
      <td class="date-cell">${formatDate(profile.lastLaunchedAt)}</td>
      <td>
        <div class="row-actions">
          <button type="button" class="action-button" data-action="launch" data-id="${profile.id}" title="${escapeHtml(launchButtonTitle(profile))}" ${launchDisabled ? "disabled" : ""}>启动</button>
          <span class="action-tooltip" data-tooltip="${escapeHtml(cdpLaunchButtonTitle(profile))}">
            <button type="button" class="action-button cdp" data-action="launch-cdp" data-id="${profile.id}" ${cdpLaunchDisabled ? "disabled" : ""}>CDP启动</button>
          </span>
          <button type="button" class="action-button accent" data-action="focus-profile" data-id="${profile.id}" title="${escapeHtml(focusButtonTitle(profile))}" ${focusDisabled ? "disabled" : ""}>显示</button>
          <button type="button" class="action-button warn" data-action="close-profile" data-id="${profile.id}" title="${escapeHtml(closeButtonTitle(profile))}" ${closeDisabled ? "disabled" : ""}>关闭</button>
          <button type="button" class="action-button" data-action="open-folder" data-id="${profile.id}" ${busy ? "disabled" : ""}>目录</button>
          <button type="button" class="action-button danger" data-action="delete" data-id="${profile.id}" title="${escapeHtml(deleteButtonTitle(profile))}" ${deleteDisabled ? "disabled" : ""}>删除</button>
        </div>
      </td>
    </tr>
  `;
}

function renderEmpty(): string {
  return `
    <div class="empty-state">
      <strong>还没有 Profile</strong>
      <button type="button" class="primary" data-action="new-profile">新建独立 Profile</button>
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
          ${profileStatusLabel(profile)}
        </span>
      </div>
      <div class="detail-list">
        <div class="detail-row">
          <span>来源</span>
          <strong>${sourceDetail(profile)}</strong>
        </div>
        <div class="detail-row">
          <span>ID</span>
          <strong>${escapeHtml(profile.id)}</strong>
        </div>
        <div class="detail-row">
          <span>账号</span>
          <strong>${escapeHtml(profile.userName || "未登录")}</strong>
        </div>
        <div class="detail-row">
          <span>创建时间</span>
          <strong>${profile.createdAt ? formatDate(profile.createdAt) : "由 Chrome 管理"}</strong>
        </div>
        <div class="detail-row">
          <span>最近启动</span>
          <strong>${formatDate(profile.lastLaunchedAt)}</strong>
        </div>
        <div class="detail-row">
          <span>${processLabel(profile)}</span>
          <strong>${profile.pids.length ? profile.pids.join(", ") : "无"}</strong>
          <small class="detail-note">${processNote(profile)}</small>
        </div>
        <div class="detail-row">
          <span>本机监听端口</span>
          <strong>${profile.listeningPorts.length ? profile.listeningPorts.join(", ") : "无"}</strong>
          <small class="detail-note">${listeningPortsNote(profile)}</small>
        </div>
        ${profile.source === "isolated" ? renderCdpDetail(profile) : ""}
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
        <h2>新建独立 Profile</h2>
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

function renderCdpModal(profileId: string): string {
  const profile = state?.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" data-cdp-form data-profile-id="${escapeHtml(profile.id)}">
        <span class="modal-kicker">Chrome DevTools Protocol</span>
        <h2>启动 ${escapeHtml(profile.name)} 的 CDP</h2>
        <p class="modal-copy">留空会从 9222 开始自动选择可用端口；填写端口则按你指定的端口启动。</p>
        <div class="field">
          <label for="cdp-port">监听端口</label>
          <input id="cdp-port" name="port" type="number" min="1024" max="65535" inputmode="numeric" placeholder="自动选择（默认从 9222 起）" />
          <span class="field-note">启动后会监听在 127.0.0.1，仅供本机 CDP / Agent Browser 工具连接。</span>
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="solid" ${busy ? "disabled" : ""}>启动 CDP</button>
        </div>
      </form>
    </div>
  `;
}

function renderCdpDetail(profile: PublicProfile): string {
  if (profile.cdpUrl) {
    return `
      <div class="detail-row">
        <span>CDP 地址</span>
        <code class="path-box compact">${escapeHtml(profile.cdpUrl)}</code>
        <small class="detail-note">AI/browser agent 工具可以通过这个本机地址连接该 Profile。</small>
      </div>
    `;
  }

  return `
    <div class="detail-row">
      <span>CDP 地址</span>
      <strong>未开启</strong>
      <small class="detail-note">点击“CDP启动”后会显示本机连接地址。</small>
    </div>
  `;
}

function renderConfirmModal(confirm: Extract<ModalState, { kind: "confirm" }>): string {
  const profile = state?.profiles.find((item) => item.id === confirm.profileId);
  if (!profile) {
    return "";
  }

  const copy = confirm.action === "close" ? closeConfirmCopy(profile) : deleteConfirmCopy(profile);
  const confirmClass = confirm.action === "delete" ? "danger solid" : "warn solid";

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <span class="modal-kicker">二次确认</span>
        <h2 id="confirm-title">${escapeHtml(copy.title)}</h2>
        <p class="modal-copy">${escapeHtml(copy.body)}</p>
        <div class="confirm-summary">
          <div>
            <span>Profile</span>
            <strong>${escapeHtml(profile.name)}</strong>
          </div>
          <div>
            <span>来源</span>
            <strong>${sourceDetail(profile)}</strong>
          </div>
          <div>
            <span>状态</span>
            <strong>${profileStatusLabel(profile)}</strong>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="button" class="${confirmClass}" data-action="confirm-profile-action">
            ${escapeHtml(copy.confirmLabel)}
          </button>
        </div>
      </section>
    </div>
  `;
}

function profileStatusLabel(profile: PublicProfile): string {
  return profile.running ? "运行中" : "未运行";
}

function sourceLabel(profile: PublicProfile): string {
  return profile.source === "native" ? "系统" : "独立";
}

function sourceDetail(profile: PublicProfile): string {
  return profile.source === "native" ? "系统 Profile（由 Google Chrome 管理）" : "工具独立 Profile（由本工具创建）";
}

function processLabel(profile: PublicProfile): string {
  return profile.source === "native" ? "主进程 PID" : "关联进程 PID";
}

function processNote(profile: PublicProfile): string {
  if (profile.source === "native") {
    return "系统 Profile 仅展示可安全确认的 Chrome 主进程；Chrome Helper 子进程可能由多个系统 Profile 共享。";
  }

  return "这些是带有同一独立目录标记的 Chrome 主进程和 Helper 进程，不是端口号。";
}

function listeningPortsNote(profile: PublicProfile): string {
  if (!profile.running) {
    return "Profile 未运行时不会占用本机监听端口。";
  }

  if (!profile.listeningPorts.length) {
    return "未发现该 Profile 关联进程正在监听本机 TCP 端口。";
  }

  if (profile.cdpPort && profile.listeningPorts.includes(profile.cdpPort)) {
    return `其中 ${profile.cdpPort} 是当前可用于 CDP 连接的调试端口。`;
  }

  return "这些端口由该 Profile 关联的 Chrome 进程占用；它们不一定是可用的 CDP 调试端口。";
}

function launchButtonTitle(profile: PublicProfile): string {
  return profile.running ? "这个 Profile 已经在运行中" : "启动这个 Profile";
}

function cdpLaunchButtonTitle(profile: PublicProfile): string {
  if (profile.source !== "isolated") {
    return "CDP 启动仅支持工具独立 Profile；系统 Profile 请先新建独立 Profile";
  }
  if (profile.running) {
    return profile.cdpUrl
      ? `CDP 已开启：${profile.cdpUrl}`
      : "需要先关闭这个 Profile，再用 CDP 模式重新启动；CDP 端口只能在启动 Chrome 时指定";
  }

  return "启动这个 Profile，并开启本机 CDP 监听端口";
}

function focusButtonTitle(profile: PublicProfile): string {
  return profile.running ? "把这个 Profile 的 Chrome 窗口显示到最前面" : "这个 Profile 当前未运行";
}

function closeButtonTitle(profile: PublicProfile): string {
  return profile.running ? "关闭这个 Profile 的 Chrome 实例" : "这个 Profile 当前未运行";
}

function deleteButtonTitle(profile: PublicProfile): string {
  if (profile.running) {
    return "先关闭这个 Profile 的 Chrome 窗口，再刷新后删除";
  }
  if (profile.isDefault) {
    return "Default 本机 Chrome Profile 受保护，不能删除";
  }
  if (!profile.deletable) {
    return "这个 Profile 不能删除";
  }

  return "删除这个 Profile";
}

function closeConfirmCopy(profile: PublicProfile): { title: string; body: string; confirmLabel: string } {
  if (profile.source === "native" && profile.isDefault) {
    return {
      title: `关闭 ${profile.name}`,
      body: "这会退出当前本机 Google Chrome 实例。未保存的网页内容可能会丢失。",
      confirmLabel: "确认关闭"
    };
  }

  return {
    title: `关闭 ${profile.name}`,
    body: "这会结束这个 Profile 对应的 Chrome 实例。未保存的网页内容可能会丢失。",
    confirmLabel: "确认关闭"
  };
}

function deleteConfirmCopy(profile: PublicProfile): { title: string; body: string; confirmLabel: string } {
  return {
    title: `删除 ${profile.name}`,
    body: "这个 Profile 的目录会先移到废纸篓。删除前请确认它没有正在运行的 Chrome 窗口。",
    confirmLabel: "确认删除"
  };
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
    modal = { kind: "new" };
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

  if (action === "confirm-profile-action" && modal?.kind === "confirm") {
    const profileId = modal.profileId;
    const confirmAction = modal.action;
    const profile = state.profiles.find((item) => item.id === profileId);
    modal = null;

    if (!profile) {
      render();
      return;
    }

    if (confirmAction === "close") {
      void withBusy(() => profileApi().closeProfile(profile.id), `已请求关闭 ${profile.name}`);
      return;
    }

    void withBusy(() => profileApi().deleteProfile(profile.id), `已删除 ${profile.name}`);
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
    if (profile?.running) {
      setToast(`${profile.name} 已经在运行中`);
      return;
    }
    void withBusy(() => profileApi().launchProfile(id), `已启动 ${profile?.name || "Profile"}`);
    return;
  }

  if (action === "launch-cdp" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (profile.source !== "isolated") {
      setToast("CDP 启动仅支持工具独立 Profile", "error");
      return;
    }
    if (profile.running) {
      setToast(profile.cdpUrl ? `${profile.name} 已开启 CDP：${profile.cdpUrl}` : `先关闭 ${profile.name}，再以 CDP 模式启动`, profile.cdpUrl ? "normal" : "error");
      return;
    }

    modal = { kind: "cdp", profileId: id };
    render();
    window.setTimeout(() => document.querySelector<HTMLInputElement>("#cdp-port")?.focus(), 0);
    return;
  }

  if (action === "focus-profile" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (!profile.running) {
      setToast(`${profile.name} 当前未运行`);
      return;
    }

    void withBusy(() => profileApi().focusProfile(id), `已显示 ${profile.name}`);
    return;
  }

  if (action === "close-profile" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (!profile.running) {
      setToast(`${profile.name} 当前未运行`);
      return;
    }

    modal = { kind: "confirm", action: "close", profileId: id };
    render();
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
    if (profile.running) {
      setToast(`先关闭 ${profile.name} 的 Chrome 窗口，再刷新后删除`, "error");
      return;
    }
    if (!profile.deletable) {
      setToast(deleteButtonTitle(profile), "error");
      return;
    }

    modal = { kind: "confirm", action: "delete", profileId: id };
    render();
  }
});

appRoot.addEventListener("keydown", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest<HTMLElement>("[data-profile-row]");
  if (!row || !state || (event.key !== "Enter" && event.key !== " ")) {
    return;
  }

  event.preventDefault();
  const id = row.dataset.id;
  if (id) {
    selectedId = id;
    render();
  }
});

appRoot.addEventListener("submit", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const createForm = target?.closest<HTMLFormElement>("[data-create-form]");
  const cdpForm = target?.closest<HTMLFormElement>("[data-cdp-form]");
  if (!createForm && !cdpForm) {
    return;
  }

  event.preventDefault();

  if (cdpForm) {
    const profileId = cdpForm.dataset.profileId;
    if (!profileId) {
      return;
    }

    const profile = state?.profiles.find((item) => item.id === profileId);
    const data = new FormData(cdpForm);
    const rawPort = String(data.get("port") || "").trim();
    let port: number | null = null;
    if (rawPort) {
      const parsedPort = Number(rawPort);
      if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
        setToast("CDP 端口必须是 1024-65535 之间的整数", "error");
        return;
      }
      port = parsedPort;
    }

    modal = null;
    void withBusy(() => profileApi().launchProfileWithCdp(profileId, port), `已以 CDP 启动 ${profile?.name || "Profile"}`);
    return;
  }

  const data = new FormData(createForm as HTMLFormElement);
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
