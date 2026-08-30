import { isBusyAction, profileBusyKind, profileBusyStatusLabel } from "../busy";
import { store } from "../state";
import { PublicProfile } from "../types";
import { cdpPortLabel, escapeHtml, formatDate, isWindowsNativeAgentTemplate, profileStatusLabel, renderButtonLabel, renderOperationProgress, sourceLabel } from "../util";

const CLONE_COUNT_MIN = 1;
const CLONE_COUNT_MAX = 20;

export function clampCloneCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 3;
  }
  return Math.min(CLONE_COUNT_MAX, Math.max(CLONE_COUNT_MIN, Math.round(value)));
}

// 副本池弹窗：从「⚡ 一键造 Agent 浏览器」按钮打开。批量创建 N 份隔离 Profile，
// 并对副本做批量刷新 / 启动 / 重置 / 回收；可选把第一份写入全局 AGENTS.md 作为 Agent 固定端点。
export function renderClonePoolModal(profiles: PublicProfile[]): string {
  const allClones = profiles.filter((profile) => profile.source === "isolated" && profile.clonedFromProfileId);
  const runningClones = allClones.filter((profile) => profile.running).length;
  const idleClones = allClones.length - runningClones;

  const sourceId =
    store.clonePoolSourceId && profiles.some((profile) => profile.id === store.clonePoolSourceId)
      ? store.clonePoolSourceId
      : profiles[0]?.id || "";
  const sourceProfile = profiles.find((profile) => profile.id === sourceId) || null;
  const clones = profiles.filter((profile) => profile.source === "isolated" && profile.clonedFromProfileId === sourceId);
  const windowsNativeTemplate = isWindowsNativeAgentTemplate(store.state?.platform, sourceProfile);

  const cloning = isBusyAction("clone-profiles");
  const refreshing = isBusyAction("refresh-clones");
  const launchingClones = isBusyAction("launch-clones");
  const recycling = isBusyAction("recycle-clones");
  const busyHere = cloning || refreshing || launchingClones || recycling;

  const count = clampCloneCount(store.clonePoolCount);
  const days = Number.isFinite(store.clonePoolRecycleDays) ? Math.max(0, Math.round(store.clonePoolRecycleDays)) : 7;
  const canClone = Boolean(sourceProfile) && !store.busy;

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal max-h-[calc(100vh-36px)] overflow-auto overflow-x-hidden border-solid border border-line-strong rounded-xl bg-[linear-gradient(180deg,var(--panel-raise),var(--panel))] p-5 [box-shadow:0_30px_90px_rgba(2,6,9,0.8),0_0_0_1px_rgba(56,225,160,0.06)] clone-pool-modal" data-clone-pool role="dialog" aria-modal="true" aria-labelledby="clone-pool-title" aria-busy="${busyHere ? "true" : "false"}">
        <div class="clone-pool-modal-head">
          <div>
            <span class="modal-kicker inline-flex mb-2 text-accent font-mono text-[11px] font-semibold tracking-[0.18em] uppercase">Clone pool · 并行隔离</span>
            <h2 id="clone-pool-title">副本池</h2>
          </div>
          <div class="clone-pool-overview">
            <span class="clone-pool-stat"><strong>${allClones.length}</strong> 副本</span>
            <span class="clone-pool-stat running"><strong>${runningClones}</strong> 运行中</span>
            <span class="clone-pool-stat"><strong>${idleClones}</strong> 空闲</span>
          </div>
        </div>

        <p class="modal-copy mt-[10px] mb-3 mx-0 text-muted text-[13px] leading-[1.6] [overflow-wrap:anywhere]">
          ${
            windowsNativeTemplate
              ? "Windows 原生 Chrome 的 App-Bound Cookie 不能在独立目录中复用。这里会创建轻量 Agent 浏览器，只复制书签与可选插件；首次启动后分别登录一次即可长期复用。"
              : "把可迁移的 Profile 数据复制成 N 份隔离副本，每份使用独立 CDP 端口。登录状态仍需在目标网站实际验证；份数填 1 即创建一个 Agent 浏览器。"
          }
        </p>

        <div class="clone-pool-create">
          <div class="field grid gap-2 min-w-0">
            <span class="picker-label" id="clone-pool-source-label">源 Profile（模板 / 副本来源）</span>
            ${renderClonePoolPicker(profiles, sourceId)}
          </div>
          <label class="field clone-pool-count-field grid gap-2">
            <span class="picker-label">份数</span>
            <input type="number" min="${CLONE_COUNT_MIN}" max="${CLONE_COUNT_MAX}" step="1" class="clone-pool-input" data-clone-pool-count value="${count}" ${store.busy ? "disabled" : ""} />
          </label>
          <div class="clone-pool-create-options">
            <label class="check-control">
              <input type="checkbox" data-clone-pool-include-ext ${store.clonePoolIncludeExtensions ? "checked" : ""} ${store.busy ? "disabled" : ""} />
              <span>含插件</span>
            </label>
            <label class="check-control">
              <input type="checkbox" data-clone-pool-launch ${store.clonePoolLaunchAfter ? "checked" : ""} ${store.busy ? "disabled" : ""} />
              <span>创建后以 CDP 启动</span>
            </label>
          </div>
          <button type="button" class="primary ${cloning ? "loading" : ""}" data-action="clone-profiles" ${!canClone ? "disabled" : ""}>
            ${renderButtonLabel(cloning, `${windowsNativeTemplate ? "创建" : "克隆"} ${count} 份`, windowsNativeTemplate ? "创建中…" : "克隆中…")}
          </button>
        </div>

        ${busyHere ? renderOperationProgress(activeCloneOpKey(), cloneOpTitle(sourceProfile)) : ""}

        ${clones.length ? renderCloneGroup(sourceProfile, clones, refreshing, launchingClones, windowsNativeTemplate) : renderCloneEmpty(sourceProfile, windowsNativeTemplate)}

        <div class="clone-pool-recycle">
          <span class="clone-pool-recycle-copy">回收 <input type="number" min="0" step="1" class="clone-pool-input clone-pool-days" data-clone-pool-recycle-days value="${days}" ${store.busy ? "disabled" : ""} /> 天未使用的空闲副本</span>
          <button type="button" class="action-button warn ${recycling ? "loading" : ""}" data-action="recycle-clones" ${store.busy || !allClones.length ? "disabled" : ""}>
            ${renderButtonLabel(recycling, "清理闲置副本", "清理中…")}
          </button>
        </div>

        <div class="modal-actions">
          <button type="button" data-action="close-modal" ${store.busy ? "disabled" : ""}>关闭</button>
        </div>
      </section>
    </div>
  `;
}

function activeCloneOpKey(): string {
  if (isBusyAction("clone-profiles")) {
    return "clone-profiles";
  }
  if (isBusyAction("refresh-clones")) {
    return "refresh-clones";
  }
  if (isBusyAction("launch-clones")) {
    return "launch-clones";
  }
  return "recycle-clones";
}

function cloneOpTitle(sourceProfile: PublicProfile | null): string {
  const name = sourceProfile?.name || "源 Profile";
  const windowsNativeTemplate = isWindowsNativeAgentTemplate(store.state?.platform, sourceProfile);
  if (isBusyAction("clone-profiles")) {
    return windowsNativeTemplate ? `正在从 ${name} 创建轻量 Agent 浏览器` : `正在克隆 ${name} 的副本`;
  }
  if (isBusyAction("refresh-clones")) {
    return windowsNativeTemplate ? `正在更新 ${name} 的所有书签模板` : `正在刷新 ${name} 的所有副本数据`;
  }
  if (isBusyAction("launch-clones")) {
    return `正在批量启动 ${name} 的副本`;
  }
  return "正在清理闲置副本";
}

function renderCloneEmpty(sourceProfile: PublicProfile | null, windowsNativeTemplate: boolean): string {
  const name = sourceProfile?.name || "这个 Profile";
  return `
    <div class="clone-pool-empty">
      ${escapeHtml(
        windowsNativeTemplate
          ? `${name} 还没有 Agent 浏览器。设好份数后点「创建 N 份」，会生成带独立 CDP 端口的轻量 Profile；首次启动后需要分别登录。`
          : `${name} 还没有副本。设好份数后点「克隆 N 份」，会生成各带独立 CDP 端口的隔离副本；登录状态需在目标网站验证。`
      )}
    </div>
  `;
}

function renderCloneGroup(
  sourceProfile: PublicProfile | null,
  clones: PublicProfile[],
  refreshing: boolean,
  launchingClones: boolean,
  windowsNativeTemplate: boolean
): string {
  const sourceId = sourceProfile?.id || "";
  const idleCount = clones.filter((clone) => !clone.running).length;

  return `
    <div class="clone-group">
      <div class="clone-group-head">
        <span class="clone-group-title">${escapeHtml(sourceProfile?.name || "源")} 的副本 · ${clones.length}</span>
        <div class="clone-group-actions">
          <button type="button" class="action-button cdp ${refreshing ? "loading" : ""}" data-action="refresh-clones" data-id="${escapeHtml(sourceId)}" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(refreshing, windowsNativeTemplate ? "更新全部模板" : "刷新全部数据", "刷新中…")}
          </button>
          <button type="button" class="action-button accent ${launchingClones ? "loading" : ""}" data-action="launch-clones" data-id="${escapeHtml(sourceId)}" ${store.busy || !idleCount ? "disabled" : ""}>
            ${renderButtonLabel(launchingClones, "批量启动副本", "启动中…")}
          </button>
        </div>
      </div>
      <div class="clone-list">
        ${clones.map((clone) => renderCloneRow(clone, windowsNativeTemplate)).join("")}
      </div>
    </div>
  `;
}

function renderCloneRow(clone: PublicProfile, windowsNativeTemplate: boolean): string {
  const launching = isBusyAction("launch-cdp", { profileId: clone.id }) || isBusyAction("launch-profile", { profileId: clone.id });
  const closing = isBusyAction("close-profile", { profileId: clone.id });
  const resetting = isBusyAction("reset-clone", { profileId: clone.id });
  const busyKind = profileBusyKind(clone.id);
  const statusLabel = busyKind ? profileBusyStatusLabel(busyKind) : profileStatusLabel(clone);
  const portLabel = clone.cdpUrl
    ? cdpPortLabel(clone.cdpUrl)
    : clone.fixedCdpPort
      ? `:${clone.fixedCdpPort}`
      : "无端口";

  return `
    <div class="clone-row ${clone.running ? "running" : ""} ${busyKind ? "busy" : ""}" aria-busy="${busyKind ? "true" : "false"}">
      <span class="clone-row-dot status-dot ${busyKind ? "loading" : clone.running ? "running" : ""}" aria-hidden="true"></span>
      <span class="clone-row-name">${escapeHtml(clone.name)}</span>
      ${clone.projectTag ? `<span class="clone-tag-pill">${escapeHtml(clone.projectTag)}</span>` : ""}
      <span class="clone-row-port ${clone.cdpUrl ? "live" : ""}">${escapeHtml(portLabel)}</span>
      <span class="clone-row-state ${busyKind ? "loading" : ""}">${busyKind ? '<span class="inline-spinner" aria-hidden="true"></span>' : ""}${escapeHtml(statusLabel)}</span>
      <div class="clone-row-actions">
        ${
          clone.running
            ? `<button type="button" class="action-button warn ${closing ? "loading" : ""}" data-action="close-profile" data-id="${clone.id}" ${store.busy ? "disabled" : ""}>${renderButtonLabel(closing, "关闭", "关闭中…")}</button>`
            : `<button type="button" class="action-button accent ${launching ? "loading" : ""}" data-action="launch-cdp" data-id="${clone.id}" ${store.busy ? "disabled" : ""}>${renderButtonLabel(launching, "启动", "启动中…")}</button>`
        }
        <button type="button" class="action-button cdp ${resetting ? "loading" : ""}" data-action="reset-clone" data-id="${clone.id}" ${store.busy ? "disabled" : ""}>${renderButtonLabel(resetting, windowsNativeTemplate ? "更新模板" : "重置", windowsNativeTemplate ? "更新中…" : "重置中…")}</button>
        <button type="button" class="action-button" data-action="set-clone-tag" data-id="${clone.id}" ${store.busy ? "disabled" : ""}>标签</button>
      </div>
    </div>
  `;
}

// 源 Profile 选择器，沿用账号同步面板的自定义下拉版式（.profile-select）。
function renderClonePoolPicker(profiles: PublicProfile[], selectedProfileId: string): string {
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) || null;
  const disabled = store.busy || !profiles.length;
  const expanded = store.clonePoolMenuOpen && profiles.length > 0 && !disabled;

  return `
    <div class="profile-select ${expanded ? "open" : ""}" data-clone-pool-select>
      <button
        type="button"
        class="profile-select-trigger"
        data-action="toggle-clone-pool-menu"
        aria-haspopup="listbox"
        aria-expanded="${expanded ? "true" : "false"}"
        aria-labelledby="clone-pool-source-label"
        ${disabled ? "disabled" : ""}
      >
        <span class="profile-select-trigger-copy">
          <strong>${escapeHtml(selectedProfile?.name || "无可用 Profile")}</strong>
          <span>${selectedProfile ? `${sourceLabel(selectedProfile)} · ${profileStatusLabel(selectedProfile)}` : "先创建 Profile"}</span>
        </span>
        <span class="profile-select-caret" aria-hidden="true"></span>
      </button>
      ${expanded ? renderClonePoolMenu(profiles, selectedProfileId) : ""}
    </div>
  `;
}

function renderClonePoolMenu(profiles: PublicProfile[], selectedProfileId: string): string {
  return `
    <div class="profile-select-menu" role="listbox" aria-labelledby="clone-pool-source-label">
      ${profiles
        .map((profile) => {
          const selected = profile.id === selectedProfileId;
          return `
            <button
              type="button"
              class="profile-select-option ${selected ? "selected" : ""}"
              data-action="select-clone-pool-source"
              data-id="${escapeHtml(profile.id)}"
              role="option"
              aria-selected="${selected ? "true" : "false"}"
              ${store.busy ? "disabled" : ""}
            >
              <span class="profile-select-option-main">
                <span class="status-dot ${profile.running ? "running" : profile.source === "native" ? "native" : ""}"></span>
                <strong>${escapeHtml(profile.name)}</strong>
                ${profile.isDefault ? '<span class="native-badge">Default</span>' : ""}
              </span>
              <span class="profile-select-option-meta">
                ${sourceLabel(profile)} · ${profileStatusLabel(profile)} · ${profile.cloneCount ? `${profile.cloneCount} 副本` : formatDate(profile.lastLaunchedAt)}
              </span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}
