import { createHash } from "node:crypto";
import { opendir, lstat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserTask } from "../../shared/tasks";
import type { ReviewCoverage, ReviewEvidence, ReviewSettings, ReviewSource } from "../../shared/review";
import { readControlTraceSamples } from "../control-trace-report";
import { profilePilotManagementRoot } from "../profilepilot-management-protocol";

export const reviewHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

function stripServiceUri(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return raw.replace(/^([a-z0-9+.-]+:\/\/)(?:[^/?#\s]*@)+/i, "$1").replace(/[?#].*$/, "");
  }
}

export function redactReviewText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[已隐藏私钥]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[已隐藏令牌]")
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|glpat-[0-9A-Za-z_-]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,})\b/g, "[已隐藏密钥]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [已隐藏]")
    .replace(/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s"'`<>)]+/gi, stripServiceUri)
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|cookie)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n}]+)/gi, "$1[已隐藏]")
    .replace(/https?:\/\/[^\s<>"'`)]+/g, raw => {
      try { const url = new URL(raw); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; } catch { return "[网址]"; }
    });
}
const textContent = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.map(block => block && typeof block === "object" ? ["text", "input_text", "output_text"].includes(block.type) ? block.text || ""
    : block.type === "tool_use" ? `工具调用：${block.name || "未知"}`
      : block.type === "tool_result" ? `工具结果${block.is_error ? "（失败）" : ""}：${textContent(block.content)}` : "" : "").filter(Boolean).join("\n")
  : value && typeof value === "object" && "content" in value ? textContent((value as { content: unknown }).content) : "";

/** Only visible conversation and tool result records; excludes system prompts,
 * reasoning, images, attachments and arbitrary paths mentioned in transcripts. */
export function transcriptRecord(row: any, source: "codex" | "claude"): { at: string; role: string; text: string } | undefined {
  const at = row?.timestamp;
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return;
  if (source === "claude") {
    if (!["user", "assistant"].includes(row.type) || row.isSidechain) return;
    const text = textContent(row.message?.content);
    return text ? { at, role: row.type, text } : undefined;
  }
  if (row.type !== "response_item") return;
  const item = row.payload;
  if (item?.type === "message" && ["user", "assistant"].includes(item.role) && item.channel !== "analysis") {
    const text = textContent(item.content);
    return text ? { at, role: item.role, text } : undefined;
  }
  if (["function_call", "custom_tool_call"].includes(item?.type)) return { at, role: "tool", text: `工具调用：${item.name || "未知"}` };
  if (["function_call_output", "custom_tool_call_output"].includes(item?.type)) return { at, role: "tool", text: `工具结果：${textContent(item.output)}` };
}
export interface ReviewSourceOptions {
  home?: string;
  codexDirectory?: string;
  claudeDirectory?: string;
  traceRoot?: string;
  tasks: () => readonly BrowserTask[];
}
async function sessionFiles(root: string, source: "codex" | "claude", since: number) {
  const files: Array<{ file: string; mtime: number }> = [];
  let visited = 0, partial = false, available = true;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth < 0 || visited >= 12000) { partial = true; return; }
    try {
      const entries = [];
      for await (const entry of await opendir(directory)) {
        if (++visited > 12000) { partial = true; break; }
        entries.push(entry);
      }
      // Codex date directories sort newest first; Claude projects are one level deep.
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== "subagents") await walk(file, depth - 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const stat = await lstat(file);
          if (stat.mtimeMs >= since) files.push({ file, mtime: stat.mtimeMs });
        }
      }
    } catch { if (directory === root) available = false; else partial = true; }
  };
  await walk(root, source === "codex" ? 3 : 1);
  files.sort((a, b) => b.mtime - a.mtime);
  return { files: files.slice(0, 60), partial: partial || files.length > 60, available };
}

export async function collectReviewSources(settings: ReviewSettings, from: number, until: number, options: ReviewSourceOptions) {
  const evidence: ReviewEvidence[] = [], coverage: ReviewCoverage[] = [];
  const inside = (at: string) => Date.parse(at) > from && Date.parse(at) <= until;
  let remaining = 60000;
  const sourceBytes: Record<ReviewSource, number> = { trace: 0, profilepilot: 0, codex: 0, claude: 0 };
  const truncated = new Set<ReviewSource>();
  const add = (source: ReviewSource, session: string, label: string, at: string, text: string, location: string): boolean => {
    if (text.length > 1400) truncated.add(source);
    const clean = redactReviewText(text).slice(0, 1400);
    if (!clean.trim()) return false;
    if (remaining < clean.length || sourceBytes[source] + clean.length > 14000) { truncated.add(source); return false; }
    remaining -= clean.length;
    sourceBytes[source] += clean.length;
    const id = reviewHash(`${source}:${location}:${at}:${clean}`);
    if (!evidence.some(item => item.id === id)) evidence.push({ id, source, session: reviewHash(`${source}:${session}`), label: redactReviewText(label).slice(0, 160), at, text: clean, location });
    return true;
  };
  if (settings.sources.trace) {
    const root = options.traceRoot || profilePilotManagementRoot(options.home || os.homedir(), process.env);
    const samples = readControlTraceSamples(root, from + 1, until);
    const real = samples.rows.filter(row => row.taskKind !== "verification");
    const groups = new Map<string, typeof real>();
    for (const row of real) {
      const key = `${row.route}/${row.method || "unknown"}/${row.code || (row.ok ? "OK" : "FAILED")}/${row.taskKind}`;
      const group = groups.get(key) || []; group.push(row); groups.set(key, group);
    }
    for (const [key, rows] of [...groups].sort((a, b) => b[1].filter(r => !r.ok).length - a[1].filter(r => !r.ok).length).slice(0, 30)) {
      add("trace", key, key, rows.at(-1)!.at, JSON.stringify({ calls: rows.length, failed: rows.filter(row => !row.ok).length,
        requiresUser: rows.filter(row => row.requiresUser).length, meanMs: Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length),
        taskKind: rows[0].taskKind, sampleRequestIds: rows.slice(0, 6).map(row => row.requestId), meaning: "调用样本；需用户操作不等于缺陷，未标记调用不等于日常任务；不能推断任务成功率。" }), `control-diagnostics/${key}`);
    }
    coverage.push({ source: "trace", records: real.length, sessions: new Set(real.map(row => row.taskHash || row.sessionHash).filter(Boolean)).size, partial: true,
      note: `有限容量的调用样本，日志轮转可能遗漏；排除 ${samples.rows.length - real.length} 条验收调用，${samples.skippedLines} 条无效记录。` });
  }
  if (settings.sources.profilepilot) {
    const tasks = options.tasks().filter(task => Date.parse(task.updatedAt) > from && Date.parse(task.createdAt) <= until).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let records = 0, partial = tasks.length > 30;
    for (const task of tasks.slice(0, 30)) {
      const rows = task.events.filter(event => inside(event.at) && ["user", "assistant", "error", "action"].includes(event.kind));
      partial ||= rows.length > 8;
      const chosen = rows.length > 8 ? [rows[0], ...rows.slice(-7)] : rows;
      for (const row of chosen) {
        if (add("profilepilot", task.id, task.title, row.at, `目标：${task.prompt.slice(0, 400)}\n${row.kind}：${row.text}`, `task:${task.id}/event:${row.id}`)) records++;
        else partial = true;
      }
    }
    coverage.push({ source: "profilepilot", records, sessions: new Set(evidence.filter(e => e.source === "profilepilot").map(e => e.session)).size, partial,
      note: "ProfilePilot 已保存的任务对话片段；不包含截图、附件正文或未接入应用。" });
  }
  const home = options.home || os.homedir();
  for (const source of ["codex", "claude"] as const) {
    if (!settings.sources[source]) continue;
    const root = source === "codex" ? options.codexDirectory || path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions")
      : options.claudeDirectory || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects");
    const listing = await sessionFiles(root, source, from);
    let partial = listing.partial, records = 0, sessions = 0;
    for (const { file } of listing.files) {
      if (records >= 60 || remaining < 1500) { partial = true; break; }
      let handle;
      try {
        if ((await lstat(file)).isSymbolicLink()) { partial = true; continue; }
        handle = await open(file, "r");
        const stat = await handle.stat(), start = Math.max(0, stat.size - 1024 * 1024);
        partial ||= start > 0;
        const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
        if (start) lines.shift();
        lines.pop(); // In-progress JSONL records belong to the next scan.
        const rows: Array<{ at: string; role: string; text: string; line: number }> = [];
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try { const row = transcriptRecord(JSON.parse(lines[i]), source); if (row && inside(row.at)) rows.push({ ...row, line: i + 1 }); }
          catch { partial = true; }
        }
        partial ||= rows.length > 8;
        const chosen = rows.length > 8 ? [rows[0], ...rows.slice(-7)] : rows;
        if (chosen.length) sessions++;
        for (const row of chosen) {
          if (records >= 60 || !add(source, path.relative(root, file), `${source === "codex" ? "Codex" : "Claude Code"} · ${path.basename(file, ".jsonl")}`, row.at,
            `${row.role}：${row.text}`, `${file} · ${start ? `末段起点 ${start} 字节，第` : "第"} ${row.line} 条记录`)) { partial = true; break; }
          records++;
        }
      } catch { partial = true; }
      finally { await handle?.close(); }
    }
    coverage.push({ source, records, sessions, partial, note: !listing.available ? "未找到或无法读取本机记录目录。" : "本机已保存会话的有限片段；不包含云端聊天、隐藏推理或附件。" });
  }
  return { evidence, coverage: coverage.map(row => ({ ...row, partial: row.partial || truncated.has(row.source) })) };
}
