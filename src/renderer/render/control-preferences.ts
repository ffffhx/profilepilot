import { descriptions, examples } from "../control-preferences-model";
import { domains, labels, saving, dirtyDomains, statusText, controlPreferencesDirty } from "../control-preferences-model";
import { store } from "../state";
import { escapeHtml } from "../util";

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
