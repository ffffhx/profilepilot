import { isBusyAction } from "../busy";
import { plannedExtensionMigrationExtensions, renderExtensionMigrationDiffPreview, renderMigrationTargetPicker } from "./extensions";
import { store } from "../state";
import { CdpPortSuggestion, PublicProfile } from "../types";
import { escapeHtml, formatCdpPortSuggestionNote, renderButtonLabel } from "../util";

export function renderNewModal(): string {
  const creating = isBusyAction("create-profile");

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
          <button type="submit" class="primary ${creating ? "loading" : ""}" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(creating, "创建", "创建中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

export function renderRenameModal(profileId: string): string {
  const profile = store.state?.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return "";
  }
  const renaming = isBusyAction("rename-profile", { profileId });

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" data-rename-form data-profile-id="${escapeHtml(profile.id)}">
        <h2>修改 Profile 名称</h2>
        <div class="field">
          <label for="profile-rename">名称</label>
          <input id="profile-rename" name="name" type="text" maxlength="80" autocomplete="off" required value="${escapeHtml(profile.name)}" />
          <span class="field-note">只修改本工具里的显示名称，不改变 Profile 目录。</span>
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="primary ${renaming ? "loading" : ""}" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(renaming, "保存", "保存中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

export function renderCdpModal(profileId: string): string {
  const profile = store.state?.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return "";
  }
  const launching = isBusyAction("launch-cdp", { profileId });

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
          <button type="submit" class="solid ${launching ? "loading" : ""}" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(launching, "启动 CDP", "启动中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

export function renderAgentBrowserSetupModal(portSuggestion: CdpPortSuggestion): string {
  const profiles = store.state?.profiles || [];
  // 登录态来源默认取系统默认 Profile，否则第一个有登录账号的 Profile。
  const source =
    profiles.find((item) => item.source === "native" && item.isDefault) ||
    profiles.find((item) => item.userName) ||
    profiles[0];
  if (!source) {
    return "";
  }
  const settingUp = isBusyAction("setup-agent-browser");
  const defaultName = `agent-${source.name}`;
  const portNote = formatCdpPortSuggestionNote(portSuggestion);

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal agent-browser-modal" data-agent-browser-form data-source-id="${escapeHtml(source.id)}">
        <span class="modal-kicker">Agent 浏览器</span>
        <h2>创建 Agent 浏览器</h2>
        <p class="modal-copy">新建独立 Profile，复制登录态，绑定固定 CDP 端口，并写入全局 <code>~/.claude/CLAUDE.md</code>。完成后可直接用 <code>agent-browser connect</code> 接入。</p>
        <div class="field">
          <label>登录态来源</label>
          <strong class="agent-source-name">${escapeHtml(source.name)}</strong>
          <span class="field-note">只读复制它的登录态，不会改动来源 Profile。</span>
        </div>
        <div class="field">
          <label for="agent-name">Agent Profile 名称</label>
          <input id="agent-name" name="name" type="text" value="${escapeHtml(defaultName)}" maxlength="80" />
        </div>
        <div class="field">
          <label for="agent-setup-port">固定调试端口</label>
          <input id="agent-setup-port" name="port" type="number" min="1024" max="65535" inputmode="numeric" value="${portSuggestion.port}" />
          <span class="field-note">${escapeHtml(portNote)} 以后对该 Profile「CDP启动」会固定用这个端口。</span>
        </div>
        <div class="field">
          <label class="check-control">
            <input type="checkbox" name="includeExtensions" data-agent-include-extensions checked ${store.busy ? "disabled" : ""} />
            <span>同时同步插件</span>
          </label>
          <span class="field-note">默认带上可迁移插件的安装和启停状态；取消后只同步登录态。无法静默处理的插件可之后用「插件同步」补齐。</span>
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="primary ${settingUp ? "loading" : ""}" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(settingUp, "开始", "进行中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

export function renderAgentConfigModal(profileId: string, portSuggestion: CdpPortSuggestion | null): string {
  const profile = store.state?.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return "";
  }
  const saving = isBusyAction("agent-config", { profileId });
  const defaultPort = profile.cdpPort ?? portSuggestion?.port ?? profile.fixedCdpPort ?? 9223;
  const portNote = profile.cdpPort
    ? `当前 Profile 已在端口 ${profile.cdpPort} 提供 CDP，直接沿用这个端口。`
    : portSuggestion
      ? formatCdpPortSuggestionNote(portSuggestion)
      : `沿用已绑定端口 ${defaultPort}。`;

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" data-agent-config-form data-profile-id="${escapeHtml(profile.id)}">
        <span class="modal-kicker">Agent 调试端点</span>
        <h2>把 ${escapeHtml(profile.name)} 设为 Agent 默认调试浏览器</h2>
        <p class="modal-copy">会给这个 Profile 绑定一个固定调试端口，并写入全局 <code>~/.claude/CLAUDE.md</code>，让 Claude Code 调试浏览器时优先用 <code>agent-browser connect</code> 接入它。</p>
        <div class="field">
          <label for="agent-port">固定调试端口</label>
          <input id="agent-port" name="port" type="number" min="1024" max="65535" inputmode="numeric" value="${defaultPort}" />
          <span class="field-note">${escapeHtml(portNote)} 以后对该 Profile「CDP启动」会固定使用这个端口。</span>
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="solid ${saving ? "loading" : ""}" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(saving, "写入配置", "写入中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

export function renderExtensionMigrationModal(profiles: PublicProfile[]): string {
  const sourceId = store.migrationSourceId || profiles[0]?.id || "";
  const activeScan = store.extensionScan?.profileId === sourceId ? store.extensionScan : null;
  const sourceProfile = profiles.find((profile) => profile.id === sourceId) || null;
  const targetId =
    store.migrationTargetId && store.migrationTargetId !== sourceId
      ? store.migrationTargetId
      : profiles.find((profile) => profile.id !== sourceId)?.id || "";
  const targetProfile = profiles.find((profile) => profile.id === targetId) || null;
  const selectedExtensions = activeScan?.extensions.filter((extension) => store.selectedExtensionIds.has(extension.id)) || [];
  const plannedExtensions = plannedExtensionMigrationExtensions(selectedExtensions);
  const plannedCount = plannedExtensions?.length ?? 0;
  const hasUsableDiff = !store.extensionSyncOnlyChanged || Boolean(plannedExtensions);
  const submitDisabled = store.busy || !targetId || !hasUsableDiff || (store.extensionSyncOnlyChanged && plannedCount === 0);
  const migrating = isBusyAction("migrate-extensions");

  if (!sourceProfile || !activeScan || !selectedExtensions.length) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal migration-modal" data-extension-migration-form>
        <span class="modal-kicker">插件同步</span>
        <h2>选择目标 Profile</h2>
        <p class="modal-copy">
          ${
            store.extensionSyncOnlyChanged
              ? `从 ${escapeHtml(sourceProfile.name)} 同步 ${plannedExtensions ? plannedCount : "正在检查"} 个变更插件。已选 ${selectedExtensions.length} 个，已一致插件会跳过。`
              : `从 ${escapeHtml(sourceProfile.name)} 同步 ${selectedExtensions.length} 个已选插件。目标 Profile 的同名插件信息会被覆盖。`
          }
        </p>
        <div class="migration-modal-summary">
          <div>
            <span>源 Profile</span>
            <strong>${escapeHtml(sourceProfile.name)}</strong>
          </div>
          <div>
            <span>已选插件</span>
            <strong>${selectedExtensions.length}</strong>
          </div>
          <div>
            <span>${store.extensionSyncOnlyChanged ? "待同步" : "含本地数据"}</span>
            <strong>${store.extensionSyncOnlyChanged ? (plannedExtensions ? plannedCount : "检查中") : selectedExtensions.filter((extension) => extension.hasLocalData).length}</strong>
          </div>
        </div>
        <div class="field">
          <span class="picker-label" id="migration-target-label">目标 Profile</span>
          ${renderMigrationTargetPicker(profiles, targetId, sourceId)}
          ${
            targetProfile?.running
              ? `<p class="modal-note warn">目标 ${escapeHtml(targetProfile.name)} 正在运行。开始同步后会先关闭目标 Profile；若能读取到 CDP 页签列表，完成后会恢复原标签页。</p>`
              : ""
          }
        </div>
        <div class="migration-modal-options">
          <label class="check-control">
            <input type="checkbox" name="onlyChanged" data-extension-only-changed ${store.extensionSyncOnlyChanged ? "checked" : ""} ${store.busy ? "disabled" : ""} />
            <span>仅同步变更插件</span>
          </label>
          <label class="check-control">
            <input type="checkbox" name="includeData" data-include-extension-data ${store.includeExtensionData ? "checked" : ""} ${store.busy ? "disabled" : ""} />
            <span>同时同步插件数据</span>
          </label>
          <label class="check-control">
            <input type="checkbox" name="openInstallPages" data-open-install-pages ${store.openInstallPages ? "checked" : ""} ${store.busy ? "disabled" : ""} />
            <span>无法静默时打开安装页</span>
          </label>
        </div>
        ${renderExtensionMigrationDiffPreview()}
        ${
          store.extensionSyncOnlyChanged && plannedExtensions && plannedCount === 0
            ? `<p class="modal-note">当前没有需要同步的变更插件。需要强制覆盖时，可以取消勾选“仅同步变更插件”。</p>`
            : ""
        }
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="primary ${migrating ? "loading" : ""}" ${submitDisabled ? "disabled" : ""}>
            ${renderButtonLabel(migrating, "开始同步", "同步中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}
