import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserTask, TaskAttachment, TaskArtifactPreview } from "../../shared/tasks";
import { readTaskDocument } from "./files";

/** Export human-readable conversation text without provider credentials or SDK state. */
export function taskMarkdown(task: BrowserTask): string {
  const role = { user: "你", assistant: "Agent", action: "工具", system: "状态", error: "错误" };
  return [`# ${task.title.replace(/[\r\n]/g, " ")}`, `Profile：${task.profileName}  \n状态：${task.status}  \n更新：${task.updatedAt}`,
    ...task.events.map(event => `## ${role[event.kind]} · ${event.at}\n\n${event.text}`),
    ...(task.result ? [`## 执行结果\n\n${task.result.summary}`, ...task.result.evidence.map(value => `- 依据：${value}`), ...task.result.remaining.map(value => `- 待完成：${value}`)] : []),
    ...(task.outputs?.length ? ["## 文件", ...task.outputs.map(file => `- ${file.name}`)] : [])].join("\n\n") + "\n";
}

export async function previewTaskFile(file: TaskAttachment): Promise<TaskArtifactPreview> {
  const size = statSync(file.path).size;
  if (size > 20 * 1024 * 1024) throw new Error("预览支持 20 MB 以内的文件；可使用外部打开查看完整文件。");
  const extension = path.extname(file.name).toLowerCase();
  const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[extension];
  if (mime) return { name: file.name, mime, dataUrl: `data:${mime};base64,${(await readFile(file.path)).toString("base64")}` };
  if (extension === ".pdf") {
    const result = await readTaskDocument({ attachments: [file], outputs: [] } as unknown as BrowserTask, { attachmentId: file.id, count: 3 });
    const data = JSON.parse(result.content[0].text);
    const image = result.content.find(block => block.type === "image");
    return { name: file.name, mime: "application/pdf", text: data.pages.map((page: { page: number; text: string }) => `第 ${page.page} 页\n${page.text}`).join("\n\n"),
      truncated: Boolean(data.nextPage || data.pages.some((page: { truncated: boolean }) => page.truncated)),
      ...(image ? { dataUrl: `data:${image.mimeType};base64,${image.data}` } : {}) };
  }
  if (![".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".html", ".xml", ".yaml", ".yml", ".js", ".ts", ".css", ".py"].includes(extension)) throw new Error("此格式暂无内嵌预览，可使用外部打开。");
  const text = (await readFile(file.path, "utf8")).replace(/^\uFEFF/, "");
  return { name: file.name, mime: extension === ".csv" ? "text/csv" : "text/plain", text: text.slice(0, 200000), truncated: text.length > 200000 };
}
