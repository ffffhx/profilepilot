import { domains, labels, saving, dirtyDomains, statusText, controlPreferencesDirty, type Modal } from "./control-preferences-model";
import { profileApi } from "./api";
import { setToast } from "./busy";
import { store } from "./state";
import { invalidateView as render } from "./view-events";
import { formatErrorMessage } from "./util";
import type { ControlPreferencesDomain as Domain, ControlPreferencesEditor as Editor } from "../shared/control-preferences";

export { controlPreferencesDomains, controlPreferencesDirty } from "./control-preferences-model";

const blankEditor = (): Editor => ({ loading: false, saving: false, draft: "", snapshot: null, syncAll: true, error: null });

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
