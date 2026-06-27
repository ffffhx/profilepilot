import { isBusyAction, renderToastBody } from "../busy";
import { appRoot, store } from "../state";
import { PublicProfile } from "../types";
import { escapeHtml, renderButtonLabel } from "../util";

const MINI_PROFILE_LIMIT = 3;

// 头部 logo（纸飞机 mark），与 profilepilot-logo.svg 同源
const MINI_LOGO_MARK = `
  <svg class="mini-mark" viewBox="0 0 36 36" aria-hidden="true">
    <defs>
      <linearGradient id="mini-plane" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#82f5c9" />
        <stop offset="1" stop-color="#2bbd86" />
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="34" height="34" rx="9" fill="#0c161c" stroke="#38e1a0" stroke-opacity="0.35" />
    <path d="M18 7 L27 30 L18 24.5 L9 30 Z" fill="url(#mini-plane)" />
    <path d="M18 7 L18 24.5 L9 30 Z" fill="#27a877" fill-opacity="0.55" />
  </svg>
`;

const MINI_LOGO_GLYPH = `
  <svg class="mini-logo-glyph" viewBox="0 0 36 36" aria-hidden="true">
    <defs>
      <linearGradient id="mini-glyph-plane" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#82f5c9" />
        <stop offset="1" stop-color="#2bbd86" />
      </linearGradient>
    </defs>
    <path d="M18 7 L27 30 L18 24.5 L9 30 Z" fill="url(#mini-glyph-plane)" />
    <path d="M18 7 L18 24.5 L9 30 Z" fill="#27a877" fill-opacity="0.55" />
  </svg>
`;

// 航点节点：运行中朝右的小机头
const MINI_NODE_PLANE = `<svg viewBox="0 0 13 13" aria-hidden="true"><path d="M1 1 L12 6.5 L1 12 L4 6.5 Z" fill="currentColor" /></svg>`;

export function renderMini(): void {
  document.documentElement.classList.add("mini-rendered");
  document.body.classList.add("mini-mode");
  document.body.classList.toggle("mini-panel-open", store.miniPanelOpen);
  const previousScrollTop = store.miniExpanded ? store.miniScrollTop : 0;

  if (!store.miniPanelOpen) {
    appRoot.className = "mini-root mini-root-collapsed";
    appRoot.innerHTML = `
      <button type="button" class="mini-logo-dock" data-action="toggle-mini-panel" title="展开悬浮窗" aria-label="展开悬浮窗">
        ${MINI_LOGO_GLYPH}
      </button>
    `;
    return;
  }

  if (!store.state) {
    appRoot.className = "mini-root mini-root-panel";
    appRoot.innerHTML = '<div class="mini-shell"><div class="mini-loading">Loading...</div></div>';
    return;
  }

  const profiles = miniProfiles();
  const pinnedCount = store.state.miniProfileIds.length;
  const totalProfiles = store.state.profiles.length;
  const canExpand = totalProfiles > MINI_PROFILE_LIMIT;
  const visibleCount = Math.min(profiles.length, totalProfiles);
  appRoot.className = "mini-root mini-root-panel";
  appRoot.innerHTML = `
    <div class="mini-shell ${store.openProfileMenuId ? "menu-open" : ""}">
      <header class="mini-titlebar">
        <div class="mini-brand">
          <button type="button" class="mini-mark-button" data-action="toggle-mini-panel" title="收起为悬浮图标" aria-label="收起为悬浮图标">
            ${MINI_LOGO_MARK}
          </button>
          <div class="mini-brand-text">
            <strong>ProfilePilot</strong>
            <span>${store.miniExpanded ? `${visibleCount}/${totalProfiles} · all` : pinnedCount ? `${visibleCount}/${totalProfiles} · fixed` : `${visibleCount}/${totalProfiles} · auto`}</span>
          </div>
        </div>
        <div class="mini-window-actions">
          <button type="button" data-action="toggle-mini-panel" title="收起为悬浮图标">收起</button>
          <button type="button" data-action="show-main-window" title="展开完整控制台">展开</button>
        </div>
      </header>
      <main class="mini-profile-list ${store.miniExpanded ? "expanded" : ""}" aria-label="Mini Profiles">
        ${
          profiles.length
            ? profiles.map(renderMiniProfileCard).join("")
            : '<div class="mini-empty">还没有 Profile</div>'
        }
      </main>
      ${
        canExpand
          ? `<footer class="mini-load-more">
              <button type="button" data-action="toggle-mini-expanded" title="${store.miniExpanded ? "收起 Profile 列表" : "查看更多 Profile"}">
                ${store.miniExpanded ? "收起" : `查看更多 ${totalProfiles - visibleCount} 个 Profile`}
              </button>
            </footer>`
          : ""
      }
      ${store.toast ? `<div class="mini-toast ${store.toastKind === "error" ? "error" : ""}" role="status">${renderToastBody(store.toast)}</div>` : ""}
    </div>
  `;

  if (store.miniExpanded && previousScrollTop > 0) {
    window.requestAnimationFrame(() => {
      const list = document.querySelector<HTMLElement>(".mini-profile-list");
      if (list) {
        list.scrollTop = previousScrollTop;
      }
    });
  }
}

function miniProfiles(): PublicProfile[] {
  if (!store.state) {
    return [];
  }

  const profiles = store.state.profiles || [];
  const pinnedProfiles = store.state.miniProfileIds
    .map((id) => profiles.find((profile) => profile.id === id))
    .filter((profile): profile is PublicProfile => Boolean(profile));

  if (store.miniExpanded) {
    return profiles;
  }

  return (pinnedProfiles.length ? pinnedProfiles : profiles).slice(0, MINI_PROFILE_LIMIT);
}

function renderMiniProfileCard(profile: PublicProfile): string {
  const menuOpen = store.openProfileMenuId === profile.id;
  const port = miniPortInfo(profile);
  const action = miniPrimaryAction(profile);
  const focusing = isBusyAction("focus-profile", { profileId: profile.id });
  const launching = isBusyAction("launch-profile", { profileId: profile.id });
  const launchingCdp = isBusyAction("launch-cdp", { profileId: profile.id });
  const closing = isBusyAction("close-profile", { profileId: profile.id });

  return `
    <article class="mini-profile-card ${port.kind}">
      <button type="button" class="mini-profile-main" data-action="${action}" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
        <span class="mini-node ${port.kind === "live" ? "plane" : "ring"}" aria-hidden="true">${port.kind === "live" ? MINI_NODE_PLANE : ""}</span>
        <span class="mini-profile-name">${escapeHtml(profile.name)}</span>
        <span class="mini-readout">${escapeHtml(port.label)}</span>
      </button>
      <div class="mini-menu-anchor" data-profile-actions>
        <button type="button" class="mini-menu-button ${menuOpen ? "active" : ""}" data-action="toggle-profile-menu" data-id="${profile.id}" aria-expanded="${menuOpen ? "true" : "false"}" ${store.busy ? "disabled" : ""}>...</button>
      </div>
      ${
        menuOpen
          ? `
            <div class="mini-profile-menu" role="menu" aria-label="${escapeHtml(profile.name)} 操作" data-profile-actions>
              <button type="button" class="${focusing ? "loading" : ""}" data-action="mini-focus-profile" data-id="${profile.id}" title="显示 Chrome 窗口" ${store.busy || !profile.running ? "disabled" : ""}>
                ${renderButtonLabel(focusing, "显示", "显示中")}
              </button>
              <button type="button" class="${launching ? "loading" : ""}" data-action="mini-launch" data-id="${profile.id}" title="启动 Profile" ${store.busy || profile.running ? "disabled" : ""}>
                ${renderButtonLabel(launching, "启动", "启动中")}
              </button>
              <button type="button" class="${launchingCdp ? "loading" : ""}" data-action="mini-launch-cdp" data-id="${profile.id}" title="以 CDP 启动" ${store.busy || profile.running || profile.source !== "isolated" ? "disabled" : ""}>
                ${renderButtonLabel(launchingCdp, "CDP", "启动中")}
              </button>
              <button type="button" class="${closing ? "loading" : ""}" data-action="mini-close-profile" data-id="${profile.id}" title="关闭 Profile" ${store.busy || !profile.running ? "disabled" : ""}>
                ${renderButtonLabel(closing, "关闭", "关闭中")}
              </button>
              <button type="button" data-action="mini-copy-port" data-id="${profile.id}" title="复制 CDP 地址" ${!port.copyValue ? "disabled" : ""}>复制</button>
            </div>
          `
          : ""
      }
    </article>
  `;
}

function miniPrimaryAction(profile: PublicProfile): string {
  if (profile.running) {
    return "mini-focus-profile";
  }

  if (profile.source === "isolated" && profile.fixedCdpPort) {
    return "mini-launch-cdp";
  }

  return "mini-launch";
}

export function miniPortInfo(profile: PublicProfile): {
  kind: "live" | "bound" | "off";
  label: string;
  copyValue: string | null;
} {
  if (profile.cdpUrl) {
    return {
      kind: "live",
      label: profile.cdpUrl.replace(/^https?:\/\//, ""),
      copyValue: profile.cdpUrl
    };
  }

  if (profile.running) {
    return {
      kind: "live",
      label: "no cdp",
      copyValue: null
    };
  }

  if (profile.source === "isolated" && profile.fixedCdpPort) {
    return {
      kind: "bound",
      label: `bound ${profile.fixedCdpPort}`,
      copyValue: `http://127.0.0.1:${profile.fixedCdpPort}`
    };
  }

  return {
    kind: "off",
    label: "off",
    copyValue: null
  };
}
