import type { NativeBrowserState } from "../shared/tasks";
import type { PublicProfile } from "./types";

const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export interface NativePairing { profileId: string; code: string; expiresAt: string }
export function nativeBrowserSettings(profiles: PublicProfile[], states: NativeBrowserState[], pairing?: NativePairing, authorization?: { profileId: string; expiresAt: string }, installations: Array<{ profileId: string; stage: string; message: string }> = []): string {
  const native = profiles.filter(p => p.source === "native");
  return `<section class="panel native-browser-settings"><div class="panel-header"><h2>连接系统 Chrome</h2><span class="pill">浏览器扩展</span></div>
    <p class="muted">让任务直接使用日常 Chrome 的当前页和登录态，也可选择已有页或新建页。</p>
    <p class="muted">选择 Profile 后点击“授权并连接”，按打开页面的步骤安装扩展。应用会准备固定安装目录；完成持久安装后，Chrome 重启仍可使用。</p>
    <p class="muted">连接后默认允许所有普通网站和已实现的浏览器操作。点击扩展打开侧边栏，就能发起任务、附上选中文字并继续对话；随时点击“立即停止”。</p>
    ${installations.map(i => `<p class="notice" role="status">${escape(profiles.find(p => p.id === i.profileId)?.name || i.profileId)}：${escape(i.message)}</p>`).join("")}
    ${authorization && !installations.some(i => i.profileId === authorization.profileId) ? `<p class="notice" role="status">${states.some(s => s.profileId === authorization.profileId && s.connected && s.taskTabs) ? "连接成功，可以返回任务选择这个系统 Profile。" : Date.parse(authorization.expiresAt) <= Date.now() ? "连接请求已过期，请重新点击授权并连接。" : `请在已打开的 Chrome 页面完成授权。请求有效至 ${escape(new Date(authorization.expiresAt).toLocaleTimeString("zh-CN"))}。`}</p>` : ""}
    ${native.length ? `<div class="field"><label for="native-profile">要连接的系统 Profile</label><select id="native-profile" name="nativeProfileId">${native.map(p => `<option value="${escape(p.id)}" ${(authorization?.profileId || pairing?.profileId) === p.id ? "selected" : ""}>${escape(p.name)} · ${escape(p.id.replace(/^native:/, ""))}</option>`).join("")}</select></div><button type="button" class="primary" data-action="authorize-native">授权并连接 ↗</button>` : '<p class="notice">尚未发现系统 Chrome Profile。请先打开 Chrome，再重新打开此设置页。</p>'}
    <details class="details"><summary>安装目录与手动配对</summary><p class="muted">在目标 Chrome 的 chrome://extensions 启用开发者模式，选择“加载未打包的扩展程序”并使用此固定目录。安装后点击“授权并连接”。商店版本及临时安装备用入口会在安装页显示。</p><div class="actions"><button type="button" data-action="extension-folder">打开扩展文件夹 ↗</button>${native.length ? '<button type="button" data-action="pair-native">生成手动配对码</button>' : ""}</div></details>
    ${pairing ? `<div class="field native-pairing"><label for="native-pair-code">配对码 · ${escape(new Date(pairing.expiresAt).toLocaleTimeString("zh-CN"))} 前有效</label><textarea id="native-pair-code" readonly spellcheck="false" rows="3">${escape(pairing.code)}</textarea><button type="button" data-action="copy-native-code">复制配对码</button><small>配对码只粘贴到目标 Profile 的扩展中。连接后自动收起。</small></div>` : ""}
    <div class="native-connections" aria-live="polite">${native.map(p => {
      const state = states.find(s => s.profileId === p.id);
      return `<div class="item"><div class="task-row-copy"><strong>${escape(p.name)}</strong><p class="muted">${state?.connected ? !state.taskTabs ? "已连接 · 请更新或重新加载扩展" : state.ownerSessionId ? state.ownership === "agent" ? "任务使用中" : "已连接 · 已停止操作" : "已连接 · 可使用当前页" : state ? "已配对 · 点击授权并连接恢复" : "尚未连接"}${state?.tabTitle ? ` · ${escape(state.tabTitle)}` : ""}</p></div>${state ? `<button type="button" class="danger" data-disconnect-native="${escape(p.id)}">断开配对</button>` : ""}</div>`;
    }).join("")}</div><small>默认在后台操作页面，不主动切走你正在浏览的标签页。Chrome 内部页面及系统弹窗仍受浏览器限制；必要时任务会说明原因。可在扩展的“网站与确认设置”中禁止个别网站或启用逐次确认。关闭应用或扩展断线会停止操作。</small>
  </section>`;
}
