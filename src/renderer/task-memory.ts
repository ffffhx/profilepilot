import type { TaskApi, ProfileMemorySnapshot } from "../shared/tasks";
import { escapeTaskHtml as e } from "./task-rich-text";
import { confirmTaskAction } from "./task-confirm";

export function showProfileMemory(api: TaskApi, profiles: Array<{ id: string; name: string }>, selected = ""): void {
  const previous = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "task-artifact-dialog task-memory-dialog";
  dialog.setAttribute("aria-label", "长期记忆");
  dialog.innerHTML = `<header><h2>长期记忆</h2><button type="button" data-close>关闭 · Esc</button></header>
    <div class="task-artifact-content"><p>同一 Profile 的任务共享记忆，不同 Profile 分开保存。你可以在对话中说“请记住我的偏好”，也可以在这里查看和修改。</p>
    <div class="field"><label for="memory-profile">选择 Profile</label><select id="memory-profile">${profiles.map(profile => `<option value="${e(profile.id)}">${e(profile.name)}</option>`).join("")}</select></div>
    <div class="actions"><button type="button" data-toggle disabled>停用记忆</button><button type="button" data-refresh>刷新</button></div>
    <p data-memory-status role="status" aria-live="polite"></p><div data-memory-content></div></div>`;
  const select = dialog.querySelector<HTMLSelectElement>("select")!;
  if (profiles.some(profile => profile.id === selected)) select.value = selected;
  const status = dialog.querySelector<HTMLElement>("[data-memory-status]")!;
  const body = dialog.querySelector<HTMLElement>("[data-memory-content]")!;
  const toggle = dialog.querySelector<HTMLButtonElement>("[data-toggle]")!;
  let snapshot: ProfileMemorySnapshot | undefined, currentName = "MEMORY.md", original = "", pending = false, generation = 0;
  const dirty = (): boolean => (body.querySelector<HTMLTextAreaElement>("textarea")?.value ?? original) !== original;
  const canDiscard = async (): Promise<boolean> => !dirty() || await confirmTaskAction("放弃未保存的修改？", "记忆内容尚未保存。", "放弃修改");
  const draw = (): void => {
    if (!snapshot) return;
    const file = snapshot.files.find(file => file.name === currentName);
    original = file?.content || "";
    toggle.textContent = snapshot.enabled ? "停用记忆" : "启用记忆"; toggle.disabled = snapshot.busy;
    status.textContent = snapshot.busy ? "此 Profile 有任务正在运行。暂停任务后可编辑或停用记忆。" : snapshot.enabled ? "已启用 · 后续任务会读取和维护这里的记忆。" : "已停用 · 后续运行不再读取或更新记忆。已进入会话历史的内容不会自动删除。";
    body.innerHTML = `<div class="actions">${[...new Set(["MEMORY.md", ...snapshot.files.map(file => file.name)])].map(name => `<button type="button" data-memory-file="${e(name)}" ${name === currentName ? 'aria-current="true"' : ""}>${e(name)}</button>`).join("")}</div>
      ${!snapshot.files.length ? '<p class="muted">尚无记忆。可以直接填写索引，也可以让 Agent 在对话中记住有用的信息。</p>' : ""}
      <div class="field"><label for="memory-content">${e(currentName === "MEMORY.md" ? "记忆索引 · MEMORY.md" : currentName)}</label><textarea id="memory-content" rows="14" spellcheck="false" ${snapshot.busy ? "readonly" : ""}>${e(original)}</textarea></div>
      <p class="muted">记忆用于保留稳定偏好与已确认的信息；当前要求和本次提供的资料优先。</p>
      <div class="actions"><button type="button" class="primary" data-save ${snapshot.busy ? "disabled" : ""}>保存修改</button><button type="button" class="danger" data-delete ${!file || snapshot.busy ? "disabled" : ""}>删除此文件</button></div>`;
  };
  const load = async (): Promise<void> => {
    const id = select.value, request = ++generation;
    if (!id) { status.textContent = "请先创建或连接一个 Profile。"; return; }
    snapshot = undefined; original = ""; body.replaceChildren(); toggle.disabled = true; status.textContent = "正在读取记忆…";
    const next = await api.getMemory(id);
    if (!dialog.isConnected || request !== generation) return;
    snapshot = next; if (!next.files.some(file => file.name === currentName)) currentName = "MEMORY.md"; draw();
  };
  const act = async (operation: () => Promise<void>): Promise<void> => {
    if (pending) return;
    pending = true; select.disabled = true;
    try { await operation(); } catch (error) { if (dialog.isConnected) status.textContent = error instanceof Error ? error.message : String(error); }
    finally { pending = false; select.disabled = false; }
  };
  const close = (): void => { void act(async () => { if (await canDiscard()) dialog.close(); }); };
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => { generation++; dialog.remove(); if (previous?.isConnected) previous.focus(); }, { once: true });
  select.addEventListener("change", () => { void act(async () => { if (!await canDiscard()) { select.value = snapshot?.profileId || ""; return; } currentName = "MEMORY.md"; await load(); }); });
  dialog.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button"); if (!button || button.disabled || pending) return;
    if (button.hasAttribute("data-close")) { close(); return; }
    void act(async () => {
      if (button.hasAttribute("data-refresh")) { if (await canDiscard()) await load(); return; }
      if (!snapshot) return;
      const profileId = snapshot.profileId;
      if (button.dataset.memoryFile) { if (await canDiscard()) { currentName = button.dataset.memoryFile; draw(); } return; }
      if (button.hasAttribute("data-toggle")) { if (await canDiscard()) { snapshot = await api.setMemoryEnabled(profileId, !snapshot.enabled); draw(); } return; }
      const file = snapshot.files.find(file => file.name === currentName);
      if (button.hasAttribute("data-save")) {
        const content = body.querySelector<HTMLTextAreaElement>("textarea")!.value;
        snapshot = await api.writeMemory(profileId, currentName, content, file?.revision ?? null); draw(); status.textContent = "记忆已保存，后续运行会使用更新后的内容。";
      }
      if (button.hasAttribute("data-delete") && file && await confirmTaskAction("删除这份记忆？", "文件及其索引链接会删除；已进入会话历史的内容仍会保留。", "删除记忆")) {
        snapshot = await api.deleteMemory(profileId, file.name, file.revision); currentName = "MEMORY.md"; draw();
      }
    });
  });
  document.body.append(dialog); dialog.showModal(); void act(load);
}
