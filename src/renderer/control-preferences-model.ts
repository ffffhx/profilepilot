import type { ModalState } from "./types";
import type { ControlPreferencesDomain as Domain, ControlPreferencesEditor as Editor } from "../shared/control-preferences";

export type Modal = Extract<ModalState, { kind: "control-preferences" }>;

export const controlPreferencesDomains: Domain[] = ["browser", "electron", "phone"];

export const domains = controlPreferencesDomains;

export const labels: Record<Domain, string> = { browser: "浏览器", electron: "Electron", phone: "手机" };

export const descriptions: Record<Domain, string> = {
  browser: "设置优先使用的 Profile、连接方式，以及切换账号前的确认规则。",
  electron: "设置 Electron 应用的选择、后台操作、控制标识和用户接管规则。首次提供默认说明，保存后供 Agent 读取。",
  phone: "设置优先使用的手机、默认查看或控制模式，以及操作前的确认规则。"
};

export const examples: Record<Domain, string> = {
  browser: "例如：优先使用系统默认 Chrome Profile，通过 ProfilePilot 扩展连接。切换账号前先询问我。",
  electron: "例如：通过应用的 Agent 端口连接，默认后台操作，保持控制标识可见。用户接管后停止操作。",
  phone: "例如：优先使用我指定的安卓手机，多台设备连接时先确认目标。默认仅查看，点击或输入前先询问我。"
};

export const saving = (modal: Modal) => domains.some(domain => modal.editors[domain].saving);

export function controlPreferencesDirty(editor: Editor): boolean {
  return Boolean(editor.snapshot && (editor.draft !== editor.snapshot.content || editor.syncAll && editor.snapshot.differs));
}

export const dirtyDomains = (modal: Modal) => domains.filter(domain => controlPreferencesDirty(modal.editors[domain]));

export function statusText(editor: Editor): string {
  return editor.loading ? "正在读取…" : controlPreferencesDirty(editor) ? "有未保存的修改" : editor.snapshot?.exists ? "已与本地内容同步" : "保存后创建个人偏好";
}
