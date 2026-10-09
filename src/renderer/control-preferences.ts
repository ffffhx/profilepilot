import { profileApi } from "./api";
import { setToast } from "./busy";
import { store } from "./state";
import { render } from "./render/render-root";
import { escapeHtml, formatErrorMessage } from "./util";
import type { ModalState } from "./types";
import type { ControlPreferencesDomain as Domain, ControlPreferencesEditor as Editor } from "../shared/control-preferences";

type Modal = Extract<ModalState, { kind: "control-preferences" }>;
export const controlPreferencesDomains: Domain[] = ["browser", "electron", "phone"];
const domains = controlPreferencesDomains;
const labels: Record<Domain, string> = { browser: "浏览器", electron: "Electron", phone: "手机" };
const descriptions: Record<Domain, string> = {
  browser: "设置优先使用的 Profile、连接方式，以及切换账号前的确认规则。",
  electron: "设置 Electron 应用的选择、后台操作、控制标识和用户接管规则。首次提供默认说明，保存后供 Agent 读取。",
  phone: "设置优先使用的手机、默认查看或控制模式，以及操作前的确认规则。"
};
const examples: Record<Domain, string> = {
  browser: "例如：优先使用系统默认 Chrome Profile，通过 ProfilePilot 扩展连接。切换账号前先询问我。",
  electron: "例如：通过应用的 Agent 端口连接，默认后台操作，保持控制标识可见。用户接管后停止操作。",
  phone: "例如：优先使用我指定的安卓手机，多台设备连接时先确认目标。默认仅查看，点击或输入前先询问我。"
};
const blankEditor = (): Editor => ({ loading: false, saving: false, draft: "", snapshot: null, syncAll: true, error: null });
const saving = (modal: Modal) => domains.some(domain => modal.editors[domain].saving);
export function controlPreferencesDirty(editor: Editor): boolean {
  return Boolean(editor.snapshot && (editor.draft !== editor.snapshot.content || editor.syncAll && editor.snapshot.differs));
}
const dirtyDomains = (modal: Modal) => domains.filter(domain => controlPreferencesDirty(modal.editors[domain]));
function statusText(editor: Editor): string {
  return editor.loading ? "正在读取…" : controlPreferencesDirty(editor) ? "有未保存的修改" : editor.snapshot?.exists ? "已与本地内容同步" : "保存后创建个人偏好";
}

async function loadPreferences(modal: Modal, domain: Domain): Promise<void> {
  const editor = blankEditor();
  editor.loading = true;
  modal.editors[domain] = editor;
  render();
  try {
    const snapshot = await profileApi().readControlPreferences(domain);
    editor.snapshot = snapshot;
    editor.draft = snapshot.content;
    editor.syncAll = !snapshot.differs;
  } catch (error) { editor.error = formatErrorMessage(error); }
  finally {
    editor.loading = false;
    if (store.modal === modal && modal.editors[domain] === editor) {
      render();
      if (modal.activeTab === domain && !document.activeElement?.matches('[role="tab"]')) document.getElementById("control-preferences-editor")?.focus();
    }
  }
}

export async function openControlPreferences(): Promise<void> {
  const modal: Modal = { kind: "control-preferences", activeTab: "browser", editors: { browser: blankEditor(), electron: blankEditor(), phone: blankEditor() }, discard: false };
  store.modal = modal;
  await loadPreferences(modal, "browser");
}

export function switchControlPreferencesTab(domain: Domain): void {
  const modal = store.modal;
  if (modal?.kind !== "control-preferences" || !domains.includes(domain) || saving(modal) || modal.discard) return;
  modal.activeTab = domain;
  const editor = modal.editors[domain];
  if (!editor.snapshot && !editor.loading && !editor.error) void loadPreferences(modal, domain);
  else render();
  document.getElementById(`control-preferences-tab-${domain}`)?.focus();
}

export function leaveControlPreferences(action: "close" | "reload", confirmed = false): void {
  const modal = store.modal;
  if (modal?.kind !== "control-preferences" || saving(modal)) return;
  const dirty = action === "close" ? dirtyDomains(modal).length > 0 : controlPreferencesDirty(modal.editors[modal.activeTab]);
  if (!confirmed && dirty) {
    modal.discard = action;
    render();
    document.querySelector<HTMLButtonElement>('[data-action="keep-control-preferences"]')?.focus();
  } else if (action === "reload") {
    modal.discard = false;
    void loadPreferences(modal, modal.activeTab);
  } else {
    store.modal = null;
    render();
    document.querySelector<HTMLButtonElement>('[data-action="open-control-preferences"]')?.focus();
  }
}

export function updateControlPreferencesDraft(value: string): void {
  const modal = store.modal;
  if (modal?.kind !== "control-preferences") return;
  const editor = modal.editors[modal.activeTab];
  editor.draft = value;
  // Keep the textarea node during typing, including Chinese IME composition.
  const status = document.querySelector<HTMLElement>("[data-control-preferences-state]");
  if (status) status.textContent = statusText(editor);
  const save = document.querySelector<HTMLButtonElement>('[data-action="save-control-preferences"]');
  if (save) save.disabled = !editor.snapshot || editor.saving || Boolean(editor.snapshot.exists && !controlPreferencesDirty(editor));
  const tab = document.getElementById(`control-preferences-tab-${modal.activeTab}`);
  if (tab) {
    tab.dataset.dirty = String(controlPreferencesDirty(editor));
    tab.setAttribute("aria-label", labels[modal.activeTab] + (controlPreferencesDirty(editor) ? "，有未保存的修改" : ""));
  }
}

export async function saveControlPreferences(): Promise<void> {
  const modal = store.modal;
  if (modal?.kind !== "control-preferences" || saving(modal)) return;
  const domain = modal.activeTab;
  const editor = modal.editors[domain];
  if (!editor.snapshot || editor.loading || modal.discard) return;
  editor.saving = true;
  editor.error = null;
  render();
  try {
    const snapshot = await profileApi().writeControlPreferences({ domain, content: editor.draft, expectedRevision: editor.snapshot.revision, syncAll: editor.syncAll });
    editor.snapshot = snapshot;
    editor.draft = snapshot.content;
    setToast(`${labels[domain]}控制偏好已保存`);
  } catch (error) { editor.error = formatErrorMessage(error); }
  finally { editor.saving = false; if (store.modal === modal) render(); }
}

export function renderControlPreferencesModal(): string {
  const modal = store.modal;
  if (modal?.kind !== "control-preferences") return "";
  const domain = modal.activeTab;
  const editor = modal.editors[domain];
  const snapshot = editor.snapshot;
  const unavailable = editor.loading || editor.saving || !snapshot;
  const dirty = dirtyDomains(modal);
  const otherDirty = dirty.filter(item => item !== domain).map(item => labels[item]).join("、");
  const discardLabel = modal.discard === "reload" ? labels[domain] : dirty.map(item => labels[item]).join("、");
  return `<div class="modal-backdrop control-preferences-backdrop" data-action="close-modal">
    <section class="modal control-preferences-modal" role="dialog" aria-modal="true" aria-labelledby="control-preferences-title">
      <header class="control-preferences-header"><div><h2 id="control-preferences-title">控制偏好</h2><p>告诉 Agent 如何使用你的浏览器、Electron 应用和手机。</p></div><button type="button" data-action="close-modal" aria-label="关闭控制偏好" ${saving(modal) ? "disabled" : ""}>×</button></header>
      <div class="control-preferences-tabs" role="tablist" aria-label="控制对象">${domains.map(item => `<button type="button" role="tab" id="control-preferences-tab-${item}" data-action="switch-control-preferences-tab" data-preferences-tab="${item}" data-dirty="${controlPreferencesDirty(modal.editors[item])}" aria-label="${labels[item]}${controlPreferencesDirty(modal.editors[item]) ? "，有未保存的修改" : ""}" aria-selected="${domain === item}" aria-controls="control-preferences-panel-${item}" tabindex="${domain === item ? "0" : "-1"}" ${saving(modal) || modal.discard ? "disabled" : ""}>${labels[item]}</button>`).join("")}</div>
      <div class="control-preferences-panel" id="control-preferences-panel-${domain}" role="tabpanel" aria-labelledby="control-preferences-tab-${domain}" aria-busy="${editor.loading || editor.saving}">
        <p class="control-preferences-description">${descriptions[domain]}</p>
        ${editor.error ? `<p class="control-preferences-error" role="alert">${escapeHtml(editor.error)}</p>` : ""}
        ${snapshot?.differs ? `<p class="control-preferences-note">各 Agent 的现有偏好不同，当前显示${escapeHtml(snapshot.locations.find(item => item.path === snapshot.path)?.label || "本地")}的内容。勾选下方同步选项会将其他 Agent 的${labels[domain]}偏好替换为这里的内容。</p>` : ""}
        <label class="control-preferences-label" for="control-preferences-editor">${labels[domain]}控制偏好 <span>支持普通文字和 Markdown</span></label>
        <textarea id="control-preferences-editor" data-domain="${domain}" spellcheck="false" ${unavailable ? "disabled" : ""} placeholder="${editor.loading ? "正在读取偏好…" : examples[domain]}">${escapeHtml(editor.draft)}</textarea>
        <div class="control-preferences-options"><span data-control-preferences-state role="status">${statusText(editor)}</span>${snapshot && snapshot.locations.length > 1 ? `<label><input type="checkbox" data-control-preferences-sync ${editor.syncAll ? "checked" : ""} ${unavailable ? "disabled" : ""}> 同时同步到其他 Agent</label>` : ""}</div>
        <p class="control-preferences-hint">${domain === "phone" ? "偏好用于指导 Agent；手机授权、暂停和结束控制仍由手机控制机制执行。" : "偏好用于指导 Agent；已有的连接权限和用户接管机制继续生效。"}</p>
        ${snapshot ? `<details class="control-preferences-location"><summary>保存位置</summary><p>${escapeHtml(snapshot.path)}</p><p>更新 ProfilePilot CLI 时会保留这些个人偏好。</p></details>` : ""}
      </div>
      ${otherDirty ? `<p class="control-preferences-other-draft">${otherDirty} Tab 还有未保存的修改。</p>` : ""}
      ${modal.discard ? `<div class="control-preferences-discard" role="alert"><span>${modal.discard === "reload" ? `重新读取会放弃${discardLabel}中未保存的修改，继续吗？` : `放弃${discardLabel}中未保存的修改？`}</span><button type="button" data-action="keep-control-preferences">继续编辑</button><button type="button" data-action="discard-control-preferences">${modal.discard === "reload" ? "放弃并重新读取" : "放弃修改"}</button></div>` : ""}
      <footer class="control-preferences-footer"><button type="button" data-action="reload-control-preferences" ${editor.loading || saving(modal) || modal.discard ? "disabled" : ""}>重新读取</button><span></span><button type="button" data-action="close-modal" ${saving(modal) ? "disabled" : ""}>关闭</button><button class="primary" type="button" data-action="save-control-preferences" ${unavailable || modal.discard || snapshot?.exists && !controlPreferencesDirty(editor) ? "disabled" : ""}>${editor.saving ? "保存中…" : `保存${labels[domain]}偏好`}</button></footer>
    </section>
  </div>`;
}
