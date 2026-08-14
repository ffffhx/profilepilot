import { isBusyAction } from "../busy";
import { plannedExtensionMigrationExtensions, renderExtensionMigrationDiffPreview, renderMigrationTargetPicker } from "./extensions";
import { bifrostMainProxyServer, DEFAULT_CLASH_PROXY_SERVER, proxyServerUsesPort } from "../proxy";
import { store } from "../state";
import { BifrostSnapshot, CdpPortSuggestion, GlobalInstructionFile, PublicProfile } from "../types";
import { escapeHtml, formatCdpPortSuggestionNote, formatDate, renderButtonLabel } from "../util";

type ProxyRouteMapTone = "current" | "saved" | "preview" | "warning" | "unknown";
type ProxyMode = "custom" | "bifrost-main" | "clash" | "direct";

interface ProxyRouteMapView {
  badge: string;
  note: string;
  tone: ProxyRouteMapTone;
  middleLabel: string;
  middleValue: string;
  middleNote: string;
  targetLabel: string;
  targetValue: string;
  targetNote: string;
}

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
          <strong>保存前按 revision 防并发覆盖，并自动保留可撤销版本</strong>
        </div>
        <div class="global-instruction-diff" data-global-instruction-diff>
          ${renderGlobalInstructionDiff(store.globalInstructionOriginal, store.globalInstructionDraft)}
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
        <span>来源</span>
        <strong>${escapeHtml(file.sourceLabel)}</strong>
      </div>
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
    ${renderGlobalInstructionDiagnostics(file)}
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
    const undoAvailable = Boolean(store.globalInstructions?.undoAvailableIds.includes(file.id));
    return `
      <div class="modal-actions">
        <button type="button" data-action="close-modal">关闭</button>
        <button type="button" data-action="undo-global-instruction" ${saving || !undoAvailable ? "disabled" : ""}>撤销上次修复</button>
        <button type="button" data-action="open-global-instruction" ${!file.exists ? "disabled" : ""}>打开文件</button>
        <button type="button" data-action="copy-global-instruction" ${!file.content ? "disabled" : ""}>复制内容</button>
        <button type="button" class="solid ${saving ? "loading" : ""}" data-action="repair-global-instruction-shell" ${saving || file.isReferenceShell ? "disabled" : ""}>
          ${renderButtonLabel(saving, "修复引用壳", "修复中…")}
        </button>
      </div>
    `;
  }

  const undoAvailable = Boolean(file && store.globalInstructions?.undoAvailableIds.includes(file.id));
  return `
    <div class="modal-actions">
      <button type="button" data-action="close-modal">关闭</button>
      <button type="button" data-action="undo-global-instruction" ${saving || !undoAvailable ? "disabled" : ""}>撤销上次修改</button>
      <button type="button" data-action="open-global-instruction" ${!file?.exists ? "disabled" : ""}>打开文件</button>
      <button type="button" data-action="copy-global-instruction" ${!file?.content ? "disabled" : ""}>复制内容</button>
      <button type="button" class="solid" data-action="edit-global-instruction" ${!file?.editable ? "disabled" : ""}>${file?.exists ? "编辑主源" : "创建并编辑主源"}</button>
    </div>
  `;
}

function renderGlobalInstructionDiagnostics(file: GlobalInstructionFile): string {
  if (!file.diagnostics.length) return "";
  return `
    <div class="global-instruction-diagnostics" aria-label="规则来源诊断">
      ${file.diagnostics.map((diagnostic) => `
        <p class="${diagnostic.severity}">
          <strong>${escapeHtml(diagnostic.code)}</strong>
          <span>${escapeHtml(diagnostic.message)}</span>
        </p>
      `).join("")}
    </div>
  `;
}

export function renderGlobalInstructionDiff(before: string, after: string): string {
  if (before === after) {
    return `
      <div class="global-instruction-diff-head">
        <strong>没有改动</strong>
        <span>保存按钮不会改变磁盘内容</span>
      </div>
    `;
  }
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }
  const removed = beforeLines.slice(prefix, beforeSuffix + 1);
  const added = afterLines.slice(prefix, afterSuffix + 1);
  const preview = [
    ...removed.slice(0, 8).map((line) => ({ kind: "remove", line })),
    ...added.slice(0, 8).map((line) => ({ kind: "add", line }))
  ];
  const hidden = Math.max(0, removed.length + added.length - preview.length);
  return `
    <div class="global-instruction-diff-head">
      <strong>保存预览</strong>
      <span>+${added.length} / −${removed.length} 行 · 从第 ${prefix + 1} 行开始</span>
    </div>
    <pre class="global-instruction-diff-lines"><code>${preview.map((item) =>
      `<span class="${item.kind}">${item.kind === "add" ? "+" : "−"} ${escapeHtml(item.line || " ")}</span>`
    ).join("")}${hidden ? `<span class="context">… 另有 ${hidden} 行未展开</span>` : ""}</code></pre>
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

export function renderBifrostProxyModal(profileId: string, snapshot: BifrostSnapshot | null): string {
  const profile = store.state?.profiles.find((item) => item.id === profileId);
  if (!profile || profile.source !== "isolated") {
    return "";
  }

  const config = profile.bifrostProxy;
  const upstreamConfig = profile.upstreamProxy;
  const directConnection = profile.directConnection === true;
  const enabled = Boolean(config || upstreamConfig || directConnection);
  const bifrostMainServer = bifrostMainProxyServer(snapshot);
  const clashServer = DEFAULT_CLASH_PROXY_SERVER;
  const mode: ProxyMode = directConnection
    ? "direct"
    : upstreamConfig
      ? proxyServerUsesPort(upstreamConfig.server, snapshot?.mainPort || 9900)
        ? "bifrost-main"
        : proxyServerUsesPort(upstreamConfig.server, 7897)
          ? "clash"
          : "custom"
      : "bifrost-main";
  const customProxyServer = mode === "custom" ? upstreamConfig?.server || "" : "";
  const upstreamBypass = upstreamConfig?.bypassList || "";
  const locked = Boolean(profile.running);
  const saving = isBusyAction("save-bifrost-proxy", { profileId });
  const systemRouteView = systemProxyRouteMapView(profile, snapshot);
  const routeView = config
    ? bifrostRouteMapView(
        profile,
        snapshot,
        config.listenerPort,
        config.rules.length + config.groupRules.length,
        (config.disabledRules?.length || 0) + (config.disabledGroupRules?.length || 0)
      )
    : upstreamConfig
      ? upstreamRouteMapView(profile, snapshot, upstreamConfig.server)
      : directConnection
        ? directRouteMapView(profile)
        : systemRouteView;

  return `
    <div class="modal-backdrop app-modal-backdrop" data-action="close-modal">
      <form
        class="modal bifrost-proxy-modal"
        data-bifrost-proxy-form
        data-profile-id="${escapeHtml(profile.id)}"
        data-bifrost-configured="${enabled ? "true" : "false"}"
        data-bifrost-running="${profile.running ? "true" : "false"}"
        data-bifrost-hot-edit="false"
        data-proxy-mode="${mode}"
        data-bifrost-main-server="${escapeHtml(bifrostMainServer)}"
        data-clash-server="${escapeHtml(clashServer)}"
        data-current-route-badge="${escapeHtml(systemRouteView.badge)}"
        data-current-route-note="${escapeHtml(systemRouteView.note)}"
        data-current-route-tone="${systemRouteView.tone}"
        data-current-route-middle-label="${escapeHtml(systemRouteView.middleLabel)}"
        data-current-route-middle-value="${escapeHtml(systemRouteView.middleValue)}"
        data-current-route-middle-note="${escapeHtml(systemRouteView.middleNote)}"
        data-current-route-target-label="${escapeHtml(systemRouteView.targetLabel)}"
        data-current-route-target-value="${escapeHtml(systemRouteView.targetValue)}"
        data-current-route-target-note="${escapeHtml(systemRouteView.targetNote)}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bifrost-proxy-title"
      >
        <div class="bifrost-proxy-head">
          <div>
            <span class="modal-kicker inline-flex mb-2 text-accent font-mono text-[11px] font-semibold tracking-[0.18em] uppercase">Proxy route</span>
            <h2 id="bifrost-proxy-title">${escapeHtml(profile.name)} 的请求分流</h2>
            <p>为这个独立 Profile 固定一条网络路径，不再跟随系统代理。</p>
          </div>
          <button type="button" class="${snapshot === null ? "loading" : ""}" data-action="refresh-bifrost-snapshot" data-id="${escapeHtml(profile.id)}" ${snapshot === null ? "disabled" : ""}>
            ${renderButtonLabel(snapshot === null, "刷新 Bifrost", "读取中…")}
          </button>
        </div>

        ${renderBifrostStatus(snapshot)}

        ${renderProxyRouteMap(routeView, profile)}

        ${
          profile.running
            ? `<button
                type="button"
                class="bifrost-enable-row bifrost-enable-row-button locked ${enabled ? "enabled" : ""}"
                data-action="prepare-bifrost-proxy"
                data-id="${escapeHtml(profile.id)}"
                aria-describedby="bifrost-proxy-lock-note"
              >
                <span>
                  <strong>启用独立网络路径</strong>
                  <small>启动 Profile 时按所选模式注入 Chrome 网络参数，不再跟随系统代理</small>
                </span>
                <span class="bifrost-toggle-control ${enabled ? "checked" : ""}" aria-hidden="true"></span>
              </button>`
            : `<label class="bifrost-enable-row ${enabled ? "enabled" : ""}">
                <span>
                  <strong>启用独立网络路径</strong>
                  <small>启动 Profile 时按所选模式注入 Chrome 网络参数，不再跟随系统代理</small>
                </span>
                <input type="checkbox" name="enabled" data-bifrost-proxy-enabled ${enabled ? "checked" : ""} ${saving ? "disabled" : ""} />
              </label>`
        }

        ${
          profile.running
            ? `<div class="bifrost-lock-notice" id="bifrost-proxy-lock-note"><strong>正在运行，配置已锁定</strong><span>网络路径需要在启动 Chrome 时注入；刷新网页不会改变启动参数。</span><button type="button" data-action="prepare-bifrost-proxy" data-id="${escapeHtml(profile.id)}">关闭后配置</button></div>`
            : ""
        }

        <fieldset class="bifrost-config-fields ${enabled ? "enabled" : ""}" data-bifrost-config-fields ${!enabled || locked ? "disabled" : ""}>
          <div class="bifrost-mode-switch" role="radiogroup" aria-label="分流模式">
            <label class="bifrost-mode-option ${enabled && mode === "custom" ? "selected" : ""}">
              <input type="radio" name="mode" value="custom" data-bifrost-mode ${mode === "custom" ? "checked" : ""} ${profile.running ? "disabled" : ""} />
              <span><strong>指定代理</strong><small>手动填写 HTTP / SOCKS5 地址</small></span>
            </label>
            <label class="bifrost-mode-option ${enabled && mode === "bifrost-main" ? "selected" : ""}">
              <input type="radio" name="mode" value="bifrost-main" data-bifrost-mode ${mode === "bifrost-main" ? "checked" : ""} ${profile.running ? "disabled" : ""} />
              <span><strong>Bifrost</strong><small>主入口 · ${escapeHtml(bifrostMainServer.replace(/^https?:\/\//, ""))}</small></span>
            </label>
            <label class="bifrost-mode-option ${enabled && mode === "clash" ? "selected" : ""}">
              <input type="radio" name="mode" value="clash" data-bifrost-mode ${mode === "clash" ? "checked" : ""} ${profile.running ? "disabled" : ""} />
              <span><strong>Clash</strong><small>默认 mixed · ${escapeHtml(clashServer.replace(/^https?:\/\//, ""))}</small></span>
            </label>
            <label class="bifrost-mode-option ${enabled && mode === "direct" ? "selected" : ""}">
              <input type="radio" name="mode" value="direct" data-bifrost-mode ${mode === "direct" ? "checked" : ""} ${profile.running ? "disabled" : ""} />
              <span><strong>直接联网</strong><small>绕过系统代理，不连接 Bifrost 或 Clash</small></span>
            </label>
          </div>

          <div class="bifrost-mode-panel" data-bifrost-mode-panel="custom" ${mode === "custom" ? "" : "hidden"}>
            <div class="field bifrost-upstream-field">
              <label for="bifrost-upstream-server">代理地址</label>
              <input id="bifrost-upstream-server" name="upstreamServer" type="text" spellcheck="false" placeholder="http://127.0.0.1:8080" value="${escapeHtml(customProxyServer)}" data-bifrost-upstream-server />
              <span class="field-note">支持 <code>http://</code>、<code>https://</code>、<code>socks5://</code> 或裸 <code>host:port</code>；启动 Profile 前会进行 TCP 探活。</span>
            </div>
            <div class="field bifrost-bypass-field">
              <label for="bifrost-upstream-bypass">Bypass 列表 <span>可选</span></label>
              <input id="bifrost-upstream-bypass" name="bypassList" type="text" spellcheck="false" placeholder="localhost,127.0.0.1,*.local" value="${escapeHtml(upstreamBypass)}" data-bifrost-upstream-bypass />
              <span class="field-note">逗号分隔，对应 Chrome <code>--proxy-bypass-list</code>；这些地址直连不走代理。</span>
            </div>
          </div>

        </fieldset>

        <div class="modal-actions bifrost-modal-actions">
          <button type="button" data-action="close-modal" ${saving ? "disabled" : ""}>取消</button>
          <button type="submit" class="solid ${saving ? "loading" : ""}" data-bifrost-submit-label ${locked || saving ? "disabled" : ""}>
            ${renderButtonLabel(saving, enabled ? "保存分流" : "保持系统代理", "保存中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderProxyRouteMap(view: ProxyRouteMapView, profile: PublicProfile): string {
  return `
    <div class="bifrost-route-context ${view.tone}" data-bifrost-route-context aria-live="polite">
      <span data-bifrost-route-badge>${escapeHtml(view.badge)}</span>
      <small data-bifrost-route-note>${escapeHtml(view.note)}</small>
    </div>
    <div class="bifrost-route-map" data-bifrost-route-map aria-label="Profile 代理路径">
          <div class="bifrost-route-node profile-node">
            <span>Profile</span>
            <strong>${escapeHtml(profile.name)}</strong>
            <small>${profile.fixedCdpPort ? `CDP :${profile.fixedCdpPort}` : "Chrome process"}</small>
          </div>
          <span class="bifrost-route-arrow" aria-hidden="true">→</span>
          <div class="bifrost-route-node port-node">
            <span data-bifrost-route-middle-label>${escapeHtml(view.middleLabel)}</span>
            <strong data-bifrost-route-port>${escapeHtml(view.middleValue)}</strong>
            <small data-bifrost-route-middle-note>${escapeHtml(view.middleNote)}</small>
          </div>
          <span class="bifrost-route-arrow" aria-hidden="true">→</span>
          <div class="bifrost-route-node rules-node">
            <span data-bifrost-route-target-label>${escapeHtml(view.targetLabel)}</span>
            <strong data-bifrost-route-count>${escapeHtml(view.targetValue)}</strong>
            <small data-bifrost-route-target-note>${escapeHtml(view.targetNote)}</small>
          </div>
    </div>
  `;
}

function systemProxyRouteMapView(profile: PublicProfile, snapshot: BifrostSnapshot | null): ProxyRouteMapView {
  const badge = profile.running ? "当前生效" : "当前设置";
  const note = profile.running
    ? "未启用独立分流，Chrome 正在跟随系统代理"
    : "未启用独立分流，启动后将跟随系统代理";
  if (!snapshot?.systemProxy) {
    return {
      badge,
      note,
      tone: "unknown",
      middleLabel: "System proxy",
      middleValue: "正在读取…",
      middleNote: "等待 Chrome 系统代理快照",
      targetLabel: "Current route",
      targetValue: "状态未知",
      targetNote: "刷新 Bifrost 后重试"
    };
  }

  const routes = snapshot.systemProxy.routes;
  const allDirect = snapshot.systemProxy.mode === "direct" || (routes.length > 0 && routes.every((route) => route.kind === "direct"));
  if (allDirect) {
    return {
      badge,
      note,
      tone: "current",
      middleLabel: "System proxy",
      middleValue: "DIRECT",
      middleNote: "HTTP / HTTPS 未设置代理",
      targetLabel: "Current route",
      targetValue: "直接访问目标",
      targetNote: "未启用独立代理分流"
    };
  }

  const routeCopies = routes.map((route) => `${route.protocol.toUpperCase()} ${route.kind === "direct" ? "DIRECT" : route.endpoint || "未知"}`);
  const proxiedRoutes = routes.filter((route) => route.kind !== "direct" && route.endpoint);
  const endpoints = [...new Set(proxiedRoutes.map((route) => route.endpoint as string))];
  const sameProxyForEveryProtocol = routes.length > 0 && routes.every((route) => route.kind !== "direct") && endpoints.length === 1;
  const mainPort = snapshot.mainPort;
  const allThroughBifrostMain = Boolean(
    snapshot.running &&
      mainPort &&
      routes.length > 0 &&
      proxiedRoutes.length === routes.length &&
      proxiedRoutes.every((route) => isLoopbackPort(route.endpoint, mainPort))
  );
  const middleValue = sameProxyForEveryProtocol ? endpoints[0] : routeCopies.join(" · ") || "状态未知";

  if (allThroughBifrostMain) {
    return {
      badge,
      note,
      tone: "current",
      middleLabel: "System proxy",
      middleValue,
      middleNote: "HTTP / HTTPS · 系统当前设置",
      targetLabel: "Current route",
      targetValue: `Bifrost 主入口 :${mainPort}`,
      targetNote: "使用主代理当前规则视图"
    };
  }
  if (sameProxyForEveryProtocol) {
    return {
      badge,
      note,
      tone: "current",
      middleLabel: "System proxy",
      middleValue,
      middleNote: "HTTP / HTTPS · 系统当前设置",
      targetLabel: "Current route",
      targetValue: "外部代理入口",
      targetNote: "具体规则由该代理决定"
    };
  }
  return {
    badge,
    note,
    tone: "current",
    middleLabel: "System proxy",
    middleValue,
    middleNote: "系统按协议使用不同路径",
    targetLabel: "Current route",
    targetValue: "按协议分流",
    targetNote: "以上为 Chrome 实际解析结果"
  };
}

function bifrostRouteMapView(
  profile: PublicProfile,
  snapshot: BifrostSnapshot | null,
  listenerPort: number,
  ruleCount: number,
  disabledRuleCount: number
): ProxyRouteMapView {
  const binding = snapshot?.ports.find((entry) => entry.port === listenerPort);
  const rawProfileId = profile.id.startsWith("isolated:") ? profile.id.slice("isolated:".length) : profile.id;
  const owned = Boolean(snapshot?.running && binding?.name === `profilepilot:${rawProfileId}`);
  const activeRuleCount = Math.max(0, ruleCount - disabledRuleCount);
  const ruleLabel = ruleCount
    ? disabledRuleCount
      ? `${activeRuleCount} 条启用 · ${disabledRuleCount} 条停用`
      : `${ruleCount} 条显式规则`
    : "尚未选择规则";

  if (owned) {
    return {
      badge: profile.running ? "当前生效" : "入口已就绪",
      note: profile.running ? "Chrome 正在使用这个 Bifrost 专属入口" : "专属入口当前存在，启动 Profile 后使用",
      tone: "current",
      middleLabel: "Local listener",
      middleValue: `127.0.0.1:${listenerPort}`,
      middleNote: "Bifrost 正在监听 · 仅本机",
      targetLabel: "Rule view",
      targetValue: ruleLabel,
      targetNote: "自动包含 Default"
    };
  }

  const bifrostAvailable = Boolean(snapshot?.installed && snapshot.running);
  const occupied = Boolean(binding && binding.name !== `profilepilot:${rawProfileId}`);
  return {
    badge: profile.running ? "入口未监听" : bifrostAvailable ? "待启动恢复" : "Bifrost 不可用",
    note: profile.running
      ? occupied
        ? `端口 ${listenerPort} 当前属于其他 Bifrost 入口`
        : `Bifrost 中不存在这个 Profile 的 ${listenerPort} 入口`
      : bifrostAvailable
        ? "配置已保存，启动 Profile 时自动恢复专属入口"
        : "配置已保存，Bifrost 启动后才能恢复入口",
    tone: profile.running || occupied || !bifrostAvailable ? "warning" : "saved",
    middleLabel: "Saved listener",
    middleValue: `127.0.0.1:${listenerPort}`,
    middleNote: occupied ? "端口已被其他入口占用" : "当前没有对应监听",
    targetLabel: "Saved rules",
    targetValue: ruleLabel,
    targetNote: "入口恢复后才会生效"
  };
}

function upstreamRouteMapView(profile: PublicProfile, snapshot: BifrostSnapshot | null, server: string): ProxyRouteMapView {
  const reachable = snapshot?.upstreamHealth?.[server];
  const usesBifrostMain = proxyServerUsesPort(server, snapshot?.mainPort || 9900);
  return {
    badge: profile.running ? (reachable === false ? "上游不可达" : "当前生效") : "已保存配置",
    note: profile.running ? "Chrome 正在直连这个上游代理" : "启动 Profile 后将直连这个上游代理",
    tone: reachable === false ? "warning" : profile.running ? "current" : "saved",
    middleLabel: "指定代理",
    middleValue: server || "地址未填写",
    middleNote: reachable === true ? "TCP 探活成功" : reachable === false ? "TCP 探活失败" : "等待探活结果",
    targetLabel: "Route owner",
    targetValue: usesBifrostMain ? "Bifrost 主入口" : "Clash / 自定义代理",
    targetNote: usesBifrostMain ? "使用主入口当前启用规则" : "具体规则由目标入口决定"
  };
}

function directRouteMapView(profile: PublicProfile): ProxyRouteMapView {
  return {
    badge: profile.running ? "当前生效" : "已保存配置",
    note: profile.running ? "Chrome 正在直接访问网络" : "启动 Profile 后将绕过所有系统代理",
    tone: profile.running ? "current" : "saved",
    middleLabel: "Chrome network",
    middleValue: "DIRECT",
    middleNote: "--no-proxy-server",
    targetLabel: "Current route",
    targetValue: "直接访问目标",
    targetNote: "不连接 Bifrost 或 Clash"
  };
}

function isLoopbackPort(endpoint: string | null, port: number): boolean {
  if (!endpoint) return false;
  const match = endpoint.match(/^(?:127\.0\.0\.1|localhost|\[?::1\]?):(\d{1,5})$/i);
  return Number(match?.[1]) === port;
}

function renderBifrostStatus(snapshot: BifrostSnapshot | null): string {
  if (!snapshot) {
    return `<div class="bifrost-status checking"><span class="sync-spinner" aria-hidden="true"></span><div><strong>正在读取 Bifrost</strong><small>检查 CLI、运行状态与本地规则…</small></div></div>`;
  }
  const tone = snapshot.running ? "ready" : "error";
  const title = snapshot.running
    ? `Bifrost ${snapshot.version || ""} 已就绪`
    : snapshot.installed
      ? "Bifrost 尚未运行"
      : "没有找到 Bifrost CLI";
  const detail = snapshot.running
    ? `主代理 ${snapshot.mainPort ? `:${snapshot.mainPort}` : "端口未知"} · ${snapshot.localRules.length} 条本地规则 · ${snapshot.ports.length} 个临时入口`
    : snapshot.error || "启动 Bifrost 后再刷新。";
  return `<div class="bifrost-status ${tone}"><span class="bifrost-status-light" aria-hidden="true"></span><div><strong>${escapeHtml(title.trim())}</strong><small>${escapeHtml(detail)}</small></div></div>`;
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
