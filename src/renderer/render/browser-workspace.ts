import { profileAvatar } from "./profile-avatar";
import { store } from "../state";
import type { PublicProfile, ExternalChromeInstance } from "../../shared/types";
import { escapeHtml as e } from "../util";
import { renderProfileActivityCell } from "./profiles";

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
