import type { TaskArtifactPreview } from "../shared/tasks";
import { escapeTaskHtml as e, taskMarkdown } from "./task-rich-text";

export type WorkbenchCommand = { id: string; label: string; hint?: string; disabled?: boolean; run: () => void };
function dialogShell(className: string, title: string): { dialog: HTMLDialogElement; close: () => void } {
  document.querySelectorAll<HTMLDialogElement>(".task-command-dialog,.task-artifact-dialog").forEach(node => node.close());
  const previous = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog"); dialog.className = className;
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `<header><h2>${e(title)}</h2><button type="button" data-dialog-close aria-label="关闭">关闭 · Esc</button></header><div data-dialog-body></div>`;
  const close = () => dialog.close();
  dialog.querySelector("[data-dialog-close]")!.addEventListener("click", close);
  dialog.addEventListener("close", () => { dialog.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); }, { once: true });
  document.body.append(dialog);
  return { dialog, close };
}
export function showCommands(commands: WorkbenchCommand[], modifier: string): void {
  const { dialog, close } = dialogShell("task-command-dialog", "命令与快捷键");
  const body = dialog.querySelector<HTMLElement>("[data-dialog-body]")!;
  body.innerHTML = `<label for="task-command-search">搜索命令</label><input id="task-command-search" type="search" placeholder="输入命令名称…" autocomplete="off"><p>${e(modifier)}+K 命令 · ${e(modifier)}+Shift+O 新任务 · ${e(modifier)}+F 搜索 · 空输入框 ↑ 召回上一条 · Tab 切换控件</p><div class="task-command-list"></div>`;
  const input = body.querySelector<HTMLInputElement>("input")!;
  const list = body.querySelector<HTMLElement>(".task-command-list")!;
  const draw = () => { const query = input.value.toLocaleLowerCase().trim(); list.innerHTML = commands.filter(item => `${item.id} ${item.label} ${item.hint || ""}`.toLocaleLowerCase().includes(query)).map(item => `<button type="button" data-command="${e(item.id)}" ${item.disabled ? "disabled" : ""}><strong>${e(item.label)}</strong><small>${e(item.hint || "")}</small></button>`).join("") || '<p role="status">没有匹配的命令</p>'; };
  draw(); input.addEventListener("input", draw);
  list.addEventListener("click", event => { const id = (event.target as Element).closest<HTMLElement>("[data-command]")?.dataset.command; const command = commands.find(item => item.id === id); if (command && !command.disabled) { close(); command.run(); } });
  dialog.addEventListener("keydown", event => {
    const buttons = [...list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (event.key === "Enter" && event.target === input) { event.preventDefault(); buttons[0]?.click(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const i = buttons.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === "ArrowDown" ? (i + 1) % buttons.length : (i <= 0 ? buttons.length - 1 : i - 1); buttons[next]?.focus(); }
  });
  dialog.showModal(); input.focus();
}

export function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
export function artifactPreviewMarkup(file: TaskArtifactPreview): string {
  const image = file.dataUrl && /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/.test(file.dataUrl) ? `<img src="${e(file.dataUrl)}" alt="${e(file.name)}">` : "";
  if (file.text !== undefined) {
    if (/\.csv$/i.test(file.name) || file.mime.includes("csv")) return `<div class="task-table-scroll" tabindex="0" aria-label="CSV 表格"><table><tbody>${csvRows(file.text).map((row, i) => `<tr>${row.map(cell => `<${i ? "td" : "th"}>${e(cell)}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    if (/\.md$/i.test(file.name) || file.mime.includes("markdown")) return `<div class="task-markdown">${taskMarkdown(file.text)}</div>`;
    return `${image}${file.mime === "application/pdf" ? '<p class="muted">PDF 文字预览</p>' : ""}<pre>${e(file.text)}</pre>`;
  }
  if (image) return image;
  return '<p class="task-state">此文件没有可显示的预览。可使用系统应用打开。</p>';
}
export function showArtifact(file: TaskArtifactPreview, open: () => void, feedback: (text: string) => void): void {
  const { dialog, close } = dialogShell("task-artifact-dialog", file.name);
  const body = dialog.querySelector<HTMLElement>("[data-dialog-body]")!;
  body.innerHTML = `<div class="task-artifact-content">${artifactPreviewMarkup(file)}</div>${file.truncated ? '<p class="notice">预览已截断；完整内容请打开原文件。</p>' : ""}<div class="actions"><button type="button" data-open-original>使用系统应用打开</button><button type="button" data-artifact-feedback>将选中文字带回对话</button></div>`;
  body.querySelector("[data-open-original]")!.addEventListener("click", open);
  body.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-copy-code]"); if (!button) return;
    const text = button.closest(".task-code-block")?.querySelector("code")?.textContent || "";
    void navigator.clipboard.writeText(text).then(() => button.textContent = "已复制").catch(() => { button.textContent = "复制失败，请选择代码后复制"; });
  });
  body.querySelector("[data-artifact-feedback]")!.addEventListener("mousedown", event => event.preventDefault());
  body.querySelector("[data-artifact-feedback]")!.addEventListener("click", () => {
    const selection = window.getSelection();
    const quote = selection?.anchorNode && body.querySelector(".task-artifact-content")!.contains(selection.anchorNode) ? selection.toString().trim() : "";
    close(); feedback(`关于产物「${file.name}」${quote ? `：\n> ${quote.replace(/\n/g, "\n> ")}\n\n` : "：\n"}`);
  });
  dialog.showModal();
}
