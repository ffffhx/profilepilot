import { isBusyAction } from "../busy";
import { plannedExtensionMigrationExtensions, renderExtensionMigrationDiffPreview, renderMigrationTargetPicker } from "./extensions";
import { store } from "../state";
import { CdpPortSuggestion, GlobalInstructionFile, PublicProfile } from "../types";
import { escapeHtml, formatCdpPortSuggestionNote, formatDate, renderButtonLabel } from "../util";

export function renderGlobalInstructionsModal(): string {
  const files = store.globalInstructions?.files || [];
  const active = files.find((file) => file.id === store.activeGlobalInstructionId) || files[0] || null;
  const loading = store.globalInstructionsLoading;
  const editing = Boolean(active && store.editingGlobalInstructionId === active.id);
  const saving = store.globalInstructionsSaving;

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal max-h-[calc(100vh-36px)] overflow-auto overflow-x-hidden border-solid border border-line-strong rounded-xl bg-[linear-gradient(180deg,var(--panel-raise),var(--panel))] p-5 [box-shadow:0_30px_90px_rgba(2,6,9,0.8),0_0_0_1px_rgba(56,225,160,0.06)] global-instructions-modal" role="dialog" aria-modal="true" aria-labelledby="global-instructions-title">
        <div class="global-instructions-head">
          <div>
            <span class="modal-kicker inline-flex mb-2 text-accent font-mono text-[11px] font-semibold tracking-[0.18em] uppercase">Agent Instructions</span>
            <h2 id="global-instructions-title">全局指令</h2>
          </div>
          <button type="button" class="${loading ? "loading" : ""}" data-action="refresh-global-instructions" ${loading || editing || saving ? "disabled" : ""}>
            ${renderButtonLabel(loading, "刷新", "读取中…")}
          </button>
        </div>
        <div class="global-instruction-tabs" role="tablist" aria-label="Global instruction files">
          ${
            files.length
              ? files.map((file) => renderGlobalInstructionTab(file, active?.id === file.id)).join("")
              : ["AGENTS.md", "CLAUDE.md"]
                  .map((fileName) => `<button type="button" class="global-instruction-tab" disabled>${fileName}</button>`)
                  .join("")
          }
        </div>
        ${renderGlobalInstructionBody(active, loading, editing)}
        ${renderGlobalInstructionActions(active, editing, saving)}
      </section>
    </div>
  `;
}

function renderGlobalInstructionTab(file: GlobalInstructionFile, selected: boolean): string {
  const status = globalInstructionStatus(file);
  return `
    <button
      type="button"
      class="global-instruction-tab ${selected ? "selected" : ""} ${file.error ? "error" : file.exists ? "" : "missing"}"
      data-action="select-global-instruction"
      data-id="${escapeHtml(file.id)}"
      role="tab"
      aria-selected="${selected ? "true" : "false"}"
    >
      <span>${escapeHtml(file.fileName)}</span>
      <small>${escapeHtml(status)}</small>
    </button>
  `;
}

function renderGlobalInstructionBody(file: GlobalInstructionFile | null, loading: boolean, editing: boolean): string {
  if (loading && !file) {
    return `
      <div class="global-instruction-empty">
        <span class="sync-spinner" aria-hidden="true"></span>
        <strong>正在读取全局指令…</strong>
      </div>
    `;
  }

  if (!file) {
    return `
      <div class="global-instruction-empty">
        <strong>还没有读取结果</strong>
      </div>
    `;
  }

  const roleNotice = renderGlobalInstructionRoleNotice(file);
  const body = editing
    ? `
        <textarea
          class="global-instruction-editor"
          data-global-instruction-editor
          spellcheck="false"
          aria-label="${escapeHtml(file.fileName)} 内容"
          ${store.globalInstructionsSaving ? "disabled" : ""}
        >${escapeHtml(store.globalInstructionDraft)}</textarea>
        <div class="global-instruction-edit-note">
          <span data-global-instruction-draft-count>${escapeHtml(String(store.globalInstructionDraft.length))} 字符</span>
          <strong>保存会直接覆盖 ${escapeHtml(file.path)}</strong>
        </div>
      `
    : file.error
      ? `<p class="global-instruction-message error">读取失败：${escapeHtml(file.error)}</p>`
      : file.exists
        ? `<pre class="global-instruction-content"><code>${escapeHtml(file.content)}</code></pre>`
        : file.editable
          ? `<p class="global-instruction-message">这个文件还不存在，可以点击“编辑”创建。</p>`
          : `<p class="global-instruction-message">这个引用壳还不存在，可以点击“修复引用壳”创建。</p>`;

  return `
    <div class="global-instruction-meta">
      <div>
        <span>路径</span>
        <code>${escapeHtml(file.path)}</code>
      </div>
      <div>
        <span>修改时间</span>
        <strong>${escapeHtml(file.updatedAt ? formatDate(file.updatedAt) : file.exists ? "未知" : "未找到")}</strong>
      </div>
      <div>
        <span>大小</span>
        <strong>${escapeHtml(formatBytes(file.sizeBytes))}</strong>
      </div>
    </div>
    ${roleNotice}
    ${body}
  `;
}

function renderGlobalInstructionActions(file: GlobalInstructionFile | null, editing: boolean, saving: boolean): string {
  if (editing) {
    return `
      <div class="modal-actions">
        <button type="button" data-action="cancel-global-instruction-edit" ${saving ? "disabled" : ""}>取消编辑</button>
        <button type="button" class="primary ${saving ? "loading" : ""}" data-action="save-global-instruction" ${saving ? "disabled" : ""}>
          ${renderButtonLabel(saving, "保存", "保存中…")}
        </button>
      </div>
    `;
  }

  if (file && !file.editable) {
    return `
      <div class="modal-actions">
        <button type="button" data-action="close-modal">关闭</button>
        <button type="button" data-action="open-global-instruction" ${!file.exists ? "disabled" : ""}>打开文件</button>
        <button type="button" data-action="copy-global-instruction" ${!file.content ? "disabled" : ""}>复制内容</button>
        <button type="button" class="solid ${saving ? "loading" : ""}" data-action="repair-global-instruction-shell" ${saving || file.isReferenceShell ? "disabled" : ""}>
          ${renderButtonLabel(saving, "修复引用壳", "修复中…")}
        </button>
      </div>
    `;
  }

  return `
    <div class="modal-actions">
      <button type="button" data-action="close-modal">关闭</button>
      <button type="button" data-action="open-global-instruction" ${!file?.exists ? "disabled" : ""}>打开文件</button>
      <button type="button" data-action="copy-global-instruction" ${!file?.content ? "disabled" : ""}>复制内容</button>
      <button type="button" class="solid" data-action="edit-global-instruction" ${!file?.editable ? "disabled" : ""}>${file?.exists ? "编辑主源" : "创建并编辑主源"}</button>
    </div>
  `;
}

function globalInstructionStatus(file: GlobalInstructionFile): string {
  if (file.error) {
    return "读取失败";
  }
  if (file.role === "primary") {
    return file.exists ? "唯一主源" : "主源未创建";
  }
  if (!file.exists) {
    return "引用壳未创建";
  }
  return file.isReferenceShell ? "引用壳正常" : "需要修复";
}

function renderGlobalInstructionRoleNotice(file: GlobalInstructionFile): string {
  if (file.role === "primary") {
    return `
      <p class="global-instruction-role-note primary">
        <strong>唯一主源</strong>
        <span>请在这里维护真实规则；保存后 ProfilePilot 会自动确保 CLAUDE.md 继续引用这个文件。</span>
      </p>
    `;
  }

  const target = file.referenceTargetPath || "/Users/bytedance/.codex/AGENTS.md";
  return `
    <p class="global-instruction-role-note ${file.isReferenceShell ? "reference" : "warn"}">
      <strong>${file.isReferenceShell ? "引用壳正常" : "引用壳需要修复"}</strong>
      <span>CLAUDE.md 不直接维护规则，只通过 <code>@${escapeHtml(target)}</code> 引用主源。</span>
    </p>
  `;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const kb = value / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

export function renderNewModal(): string {
  const creating = isBusyAction("create-profile");

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal max-h-[calc(100vh-36px)] overflow-auto overflow-x-hidden border-solid border border-line-strong rounded-xl bg-[linear-gradient(180deg,var(--panel-raise),var(--panel))] p-5 [box-shadow:0_30px_90px_rgba(2,6,9,0.8),0_0_0_1px_rgba(56,225,160,0.06)]" data-create-form>
        <h2>新建独立 Profile</h2>
        <div class="field grid gap-2 my-[18px]">
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
      <form class="modal max-h-[calc(100vh-36px)] overflow-auto overflow-x-hidden border-solid border border-line-strong rounded-xl bg-[linear-gradient(180deg,var(--panel-raise),var(--panel))] p-5 [box-shadow:0_30px_90px_rgba(2,6,9,0.8),0_0_0_1px_rgba(56,225,160,0.06)]" data-rename-form data-profile-id="${escapeHtml(profile.id)}">
        <h2>修改 Profile 名称</h2>
        <div class="field grid gap-2 my-[18px]">
          <label for="profile-rename">名称</label>
          <input id="profile-rename" name="name" type="text" maxlength="80" autocomplete="off" required value="${escapeHtml(profile.name)}" />
          <span class="field-note text-muted text-[12px] leading-[1.45]">只修改本工具里的显示名称，不改变 Profile 目录。</span>
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

export function renderCloneTagModal(profileId: string): string {
  const profile = store.state?.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return "";
  }
  const saving = isBusyAction("set-clone-tag", { profileId });

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal max-h-[calc(100vh-36px)] overflow-auto overflow-x-hidden border-solid border border-line-strong rounded-xl bg-[linear-gradient(180deg,var(--panel-raise),var(--panel))] p-5 [box-shadow:0_30px_90px_rgba(2,6,9,0.8),0_0_0_1px_rgba(56,225,160,0.06)]" data-clone-tag-form data-profile-id="${escapeHtml(profile.id)}">
        <span class="modal-kicker inline-flex mb-2 text-accent font-mono text-[11px] font-semibold tracking-[0.18em] uppercase">副本标签</span>
        <h2>给 ${escapeHtml(profile.name)} 设置项目标签</h2>
        <div class="field grid gap-2 my-[18px]">
          <label for="clone-tag">项目标签</label>
          <input id="clone-tag" name="tag" type="text" maxlength="40" autocomplete="off" placeholder="例如：coze 验证 / boe" value="${escapeHtml(profile.projectTag || "")}" />
          <span class="field-note text-muted text-[12px] leading-[1.45]">只是个展示标记，标注这个副本当前在干哪个项目的活；留空即清除标签。</span>
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="primary ${saving ? "loading" : ""}" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(saving, "保存标签", "保存中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

export function renderCdpModal(profileId: string, portSuggestion: CdpPortSuggestion | null): string {
  const profile = store.state?.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return "";
  }
  const launching = isBusyAction("launch-cdp", { profileId });
  const defaultPort = profile.fixedCdpPort ?? portSuggestion?.port ?? null;
  const portNote = profile.fixedCdpPort
    ? `已预填该 Profile 绑定的固定端口 ${profile.fixedCdpPort}。`
    : portSuggestion
      ? formatCdpPortSuggestionNote(portSuggestion)
      : "";

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal max-h-[calc(100vh-36px)] overflow-auto overflow-x-hidden border-solid border border-line-strong rounded-xl bg-[linear-gradient(180deg,var(--panel-raise),var(--panel))] p-5 [box-shadow:0_30px_90px_rgba(2,6,9,0.8),0_0_0_1px_rgba(56,225,160,0.06)]" data-cdp-form data-profile-id="${escapeHtml(profile.id)}">
        <span class="modal-kicker inline-flex mb-2 text-accent font-mono text-[11px] font-semibold tracking-[0.18em] uppercase">Chrome DevTools Protocol</span>
        <h2>启动 ${escapeHtml(profile.name)} 的 CDP</h2>
        <p class="modal-copy mt-[10px] mb-4 mx-0 text-muted text-[14px] leading-[1.6] [overflow-wrap:anywhere]">已为你预填下一个可用端口，可直接启动，也可以改成你想要的端口；留空则从 9222 起自动选择。</p>
        <div class="field grid gap-2 my-[18px]">
          <label for="cdp-port">监听端口</label>
          <input id="cdp-port" name="port" type="number" min="1024" max="65535" inputmode="numeric" placeholder="自动选择（默认从 9222 起）"${defaultPort !== null ? ` value="${defaultPort}"` : ""} />
          <span class="field-note text-muted text-[12px] leading-[1.45]">${portNote ? `${escapeHtml(portNote)} ` : ""}启动后会监听在 127.0.0.1，仅供本机 CDP / Agent Browser 工具连接。</span>
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
      <form class="modal max-h-[calc(100vh-36px)] overflow-auto overflow-x-hidden border-solid border border-line-strong rounded-xl bg-[linear-gradient(180deg,var(--panel-raise),var(--panel))] p-5 [box-shadow:0_30px_90px_rgba(2,6,9,0.8),0_0_0_1px_rgba(56,225,160,0.06)] migration-modal" data-extension-migration-form>
        <span class="modal-kicker inline-flex mb-2 text-accent font-mono text-[11px] font-semibold tracking-[0.18em] uppercase">插件同步</span>
        <h2>选择目标 Profile</h2>
        <p class="modal-copy mt-[10px] mb-4 mx-0 text-muted text-[14px] leading-[1.6] [overflow-wrap:anywhere]">
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
        <div class="field grid gap-2 my-[18px]">
          <span class="picker-label" id="migration-target-label">目标 Profile</span>
          ${renderMigrationTargetPicker(profiles, targetId, sourceId)}
          ${
            targetProfile?.running
              ? `<p class="modal-note mt-2 mb-0 mx-0 text-muted text-[12px] font-semibold leading-[1.45] warn">目标 ${escapeHtml(targetProfile.name)} 正在运行。开始同步后会先关闭目标 Profile；若能读取到 CDP 页签列表，完成后会恢复原标签页。</p>`
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
            ? `<p class="modal-note mt-2 mb-0 mx-0 text-muted text-[12px] font-semibold leading-[1.45]">当前没有需要同步的变更插件。需要强制覆盖时，可以取消勾选“仅同步变更插件”。</p>`
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
