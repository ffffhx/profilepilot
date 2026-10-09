import { store } from "../state";
import type { PublicProfile, ExternalChromeInstance } from "../types";
import { escapeHtml as e } from "../util";
import { renderProfileActivityCell } from "./profiles";

export function profileAvatar(profile: PublicProfile): string {
  if (profile.avatarDataUrl && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(profile.avatarDataUrl)) return `<span class="profile-avatar"><img src="${e(profile.avatarDataUrl)}" alt="" /></span>`;
  const color = profile.source === "native" ? 0 : [...profile.id].reduce((sum,c)=>sum+c.charCodeAt(0),0)%4;
  return `<span class="profile-avatar avatar-${color}" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 22v-3a8 8 0 0 1 16 0v3" fill="currentColor"/></svg></span>`;
}
export function renderBrowserInspector(profile?: PublicProfile, external?: ExternalChromeInstance): string {
  if (external) return `<aside class="browser-profile-inspector" aria-label="选中外部实例"><div class="inspector-identity"><div><h2>${e(external.label)}</h2><span class="browser-kind">${e(external.browser)}</span><span class="inspector-connection connected"><i></i>运行中 · 外部管理</span></div></div><section class="inspector-current-task"><h3>连接</h3><p>${external.cdpPort ? `CDP :${external.cdpPort}` : "未开放 CDP"}</p></section><div class="inspector-actions">${external.headless ? "" : `<button class="primary" data-action="focus-external" data-dir="${e(external.userDataDir)}" ${store.busy ? "disabled" : ""}>显示浏览器</button>`}<button data-action="open-external-details" data-dir="${e(external.userDataDir)}">连接详情</button><button class="danger" data-action="close-external" data-dir="${e(external.userDataDir)}" ${store.busy ? "disabled" : ""}>关闭外部实例</button></div></aside>`;
  if (!profile) return '<aside class="browser-profile-inspector"><p class="muted">选择一个 Profile 查看连接与任务。</p></aside>';
  const extension = store.nativeExtensionBrowsers?.find(item=>item.profileId === profile.id);
  const connected = Boolean(extension?.connected || profile.cdpUrl || profile.gatewayControl?.connectionActive);
  const label = extension?.connected ? "扩展已连接" : connected ? "Gateway 已连接" : "尚未连接";
  return `<aside class="browser-profile-inspector" aria-label="选中 Profile">
    <div class="inspector-identity">${profileAvatar(profile)}<div><h2>${e(profile.name)}</h2><span class="browser-kind"><i aria-hidden="true"></i>Chrome</span><span class="inspector-connection ${connected ? "connected" : ""}"><i></i>${label}</span></div></div>
    <section class="browser-preview" data-browser-preview="${e(profile.id)}"></section>
    <section class="inspector-current-task"><h3>当前 Agent</h3>${renderProfileActivityCell(profile)}</section>
  </aside>`;
}
