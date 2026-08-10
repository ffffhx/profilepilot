import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  GlobalInstructionFile,
  GlobalInstructionFileId,
  GlobalInstructionUndoRequest,
  GlobalInstructionUpdateRequest,
  GlobalInstructionsSnapshot
} from "../shared/types";
import { ProfileManagerError } from "./profile-manager-error";

const GLOBAL_INSTRUCTION_SOURCES: Array<{
  id: GlobalInstructionFileId;
  title: string;
  fileName: string;
  path: string;
  role: "primary" | "reference";
  editable: boolean;
  referenceTargetPath: string | null;
}> = [
  {
    id: "codex-agents",
    title: "Codex AGENTS.md",
    fileName: "AGENTS.md",
    path: path.join(os.homedir(), ".codex", "AGENTS.md"),
    role: "primary",
    editable: true,
    referenceTargetPath: null
  },
  {
    id: "claude-memory",
    title: "Claude CLAUDE.md",
    fileName: "CLAUDE.md",
    path: path.join(os.homedir(), ".claude", "CLAUDE.md"),
    role: "reference",
    editable: false,
    referenceTargetPath: path.join(os.homedir(), ".codex", "AGENTS.md")
  }
];

export const CODEX_AGENTS_PATH = GLOBAL_INSTRUCTION_SOURCES[0].path;
export const CLAUDE_INSTRUCTION_PATH = GLOBAL_INSTRUCTION_SOURCES[1].path;
const INSTRUCTION_HISTORY_DIR = path.join(os.homedir(), ".profilepilot", "instruction-history");

export function claudeInstructionShellContent(): string {
  return [
    "# Claude 全局指令",
    "",
    "> 这个文件只做引用壳，不直接维护规则。请编辑：",
    `> \`${CODEX_AGENTS_PATH}\``,
    "",
    `@${CODEX_AGENTS_PATH}`,
    ""
  ].join("\n");
}

export async function readGlobalInstructions(): Promise<GlobalInstructionsSnapshot> {
  const rawFiles = await Promise.all(GLOBAL_INSTRUCTION_SOURCES.map(readGlobalInstructionFile));
  const files = rawFiles.map((file) => ({
    ...file,
    diagnostics: instructionDiagnostics(file)
  }));
  const [latestBackup, ...backupsById] = await Promise.all([
    latestInstructionBackup(),
    ...GLOBAL_INSTRUCTION_SOURCES.map((source) => latestInstructionBackup(source.id))
  ]);
  return {
    readAt: new Date().toISOString(),
    files,
    canUndo: Boolean(latestBackup),
    undoAvailableIds: GLOBAL_INSTRUCTION_SOURCES
      .filter((_, index) => Boolean(backupsById[index]))
      .map((source) => source.id),
    lastBackupAt: latestBackup?.createdAt || null
  };
}

export async function writeGlobalInstruction(request: GlobalInstructionUpdateRequest): Promise<GlobalInstructionsSnapshot> {
  const source = GLOBAL_INSTRUCTION_SOURCES.find((item) => item.id === request.id);
  if (!source) {
    throw new ProfileManagerError("没有找到这个全局指令文件。", "GLOBAL_INSTRUCTION_NOT_FOUND");
  }
  if (!source.editable) {
    throw new ProfileManagerError("CLAUDE.md 是引用壳，请编辑 AGENTS.md。", "GLOBAL_INSTRUCTION_READONLY_REFERENCE");
  }

  const content = String(request.content ?? "");
  if (Buffer.byteLength(content, "utf8") > 1024 * 1024) {
    throw new ProfileManagerError("全局指令内容超过 1MB，请拆分后再保存。", "GLOBAL_INSTRUCTION_TOO_LARGE");
  }

  const current = await readGlobalInstructionFile(source);
  assertExpectedRevision(request.expectedRevision, current.revision);
  if (current.content === content && current.exists) {
    return readGlobalInstructions();
  }
  await saveInstructionBackup(current);
  await writeTextFileAtomic(source.path, content);
  await ensureClaudeInstructionShellIfMissing();

  return readGlobalInstructions();
}

export async function ensureClaudeInstructionShell(): Promise<GlobalInstructionsSnapshot> {
  const claudeSource = GLOBAL_INSTRUCTION_SOURCES.find((item) => item.id === "claude-memory");
  if (!claudeSource) {
    throw new ProfileManagerError("没有找到 CLAUDE.md 配置。", "GLOBAL_INSTRUCTION_NOT_FOUND");
  }

  const current = await readGlobalInstructionFile(claudeSource);
  if (current.exists && current.isReferenceShell) {
    return readGlobalInstructions();
  }
  await saveInstructionBackup(current);
  await writeTextFileAtomic(claudeSource.path, claudeInstructionShellContent());

  return readGlobalInstructions();
}

export async function undoGlobalInstruction(
  request: GlobalInstructionUndoRequest
): Promise<GlobalInstructionsSnapshot> {
  const source = GLOBAL_INSTRUCTION_SOURCES.find((item) => item.id === request.id);
  if (!source) {
    throw new ProfileManagerError("没有找到这个全局指令文件。", "GLOBAL_INSTRUCTION_NOT_FOUND");
  }
  const current = await readGlobalInstructionFile(source);
  assertExpectedRevision(request.expectedRevision, current.revision);
  const backup = await latestInstructionBackup(request.id);
  if (!backup) {
    throw new ProfileManagerError("没有可撤销的全局指令版本。", "GLOBAL_INSTRUCTION_UNDO_EMPTY");
  }
  if (backup.existed) {
    await writeTextFileAtomic(source.path, backup.content);
  } else {
    await fs.rm(source.path, { force: true });
  }
  await fs.rm(backup.path, { force: true });
  return readGlobalInstructions();
}

async function readGlobalInstructionFile(source: (typeof GLOBAL_INSTRUCTION_SOURCES)[number]): Promise<GlobalInstructionFile> {
  try {
    const [stats, content] = await Promise.all([fs.stat(source.path), fs.readFile(source.path, "utf8")]);
    return {
      ...source,
      exists: true,
      content,
      sizeBytes: stats.size,
      updatedAt: stats.mtime.toISOString(),
      error: null,
      revision: instructionRevision(content),
      sourceLabel: instructionSourceLabel(source.id),
      diagnostics: [],
      referenceShellContent: source.role === "reference" ? claudeInstructionShellContent() : null,
      isReferenceShell: source.role === "reference" ? isClaudeInstructionShell(content) : null
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    const notFound = code === "ENOENT";
    return {
      ...source,
      exists: false,
      content: "",
      sizeBytes: 0,
      updatedAt: null,
      error: notFound ? null : error instanceof Error ? error.message : String(error),
      revision: instructionRevision(""),
      sourceLabel: instructionSourceLabel(source.id),
      diagnostics: [],
      referenceShellContent: source.role === "reference" ? claudeInstructionShellContent() : null,
      isReferenceShell: source.role === "reference" ? false : null
    };
  }
}

async function ensureClaudeInstructionShellIfMissing(): Promise<void> {
  const source = GLOBAL_INSTRUCTION_SOURCES.find((item) => item.id === "claude-memory");
  if (!source) return;
  const current = await readGlobalInstructionFile(source);
  if (current.exists) {
    // 已存在但不是引用壳时保留原文，让 UI 报冲突并由用户显式修复。
    return;
  }
  await saveInstructionBackup(current);
  await writeTextFileAtomic(source.path, claudeInstructionShellContent());
}

function assertExpectedRevision(expected: string | undefined, actual: string): void {
  if (expected && expected !== actual) {
    throw new ProfileManagerError(
      "文件在你编辑期间已被其它程序修改。ProfilePilot 没有覆盖它；请刷新并重新检查差异。",
      "GLOBAL_INSTRUCTION_CONFLICT"
    );
  }
}

function instructionRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function instructionSourceLabel(id: GlobalInstructionFileId): string {
  return id === "codex-agents" ? "Codex 全局主源" : "Claude 引用壳";
}

function instructionDiagnostics(file: GlobalInstructionFile): GlobalInstructionFile["diagnostics"] {
  if (file.id === "codex-agents" && !file.exists) {
    return [{
      code: "PRIMARY_SOURCE_MISSING",
      severity: "info",
      message: "全局主源尚未创建；创建前不会改变任何 Agent 规则。"
    }];
  }
  if (file.id === "claude-memory" && !file.exists) {
    return [{
      code: "REFERENCE_SHELL_MISSING",
      severity: "warning",
      message: "Claude 引用壳不存在，Claude Code 不会继承这份全局主源。"
    }];
  }
  if (file.id === "claude-memory" && file.isReferenceShell === false) {
    return [{
      code: "REFERENCE_SHELL_DIVERGED",
      severity: "warning",
      message: "CLAUDE.md 包含独立内容或其它引用。保存主源不会覆盖它；需要用户显式预览后修复。"
    }];
  }
  return [];
}

interface InstructionBackup {
  id: GlobalInstructionFileId;
  existed: boolean;
  content: string;
  createdAt: string;
  path: string;
}

async function saveInstructionBackup(file: GlobalInstructionFile): Promise<void> {
  await fs.mkdir(INSTRUCTION_HISTORY_DIR, { recursive: true });
  const createdAt = new Date().toISOString();
  const backupPath = path.join(
    INSTRUCTION_HISTORY_DIR,
    `${createdAt.replace(/[:.]/g, "-")}-${file.id}.json`
  );
  await writeTextFileAtomic(backupPath, JSON.stringify({
    version: 1,
    id: file.id,
    existed: file.exists,
    content: file.content,
    createdAt
  }, null, 2));
  await pruneInstructionBackups(file.id, 20);
}

async function latestInstructionBackup(
  id?: GlobalInstructionFileId
): Promise<InstructionBackup | null> {
  const entries = await fs.readdir(INSTRUCTION_HISTORY_DIR).catch(() => []);
  const candidates = entries
    .filter((name) => name.endsWith(".json") && (!id || name.endsWith(`-${id}.json`)))
    .sort((a, b) => b.localeCompare(a));
  for (const name of candidates) {
    const backupPath = path.join(INSTRUCTION_HISTORY_DIR, name);
    try {
      const parsed = JSON.parse(await fs.readFile(backupPath, "utf8")) as Partial<InstructionBackup> & { version?: number };
      if (
        parsed.version === 1 &&
        (parsed.id === "codex-agents" || parsed.id === "claude-memory") &&
        typeof parsed.existed === "boolean" &&
        typeof parsed.content === "string" &&
        typeof parsed.createdAt === "string"
      ) {
        return {
          id: parsed.id,
          existed: parsed.existed,
          content: parsed.content,
          createdAt: parsed.createdAt,
          path: backupPath
        };
      }
    } catch {
      // 损坏的历史项不阻塞读取当前规则，继续找上一项。
    }
  }
  return null;
}

async function pruneInstructionBackups(id: GlobalInstructionFileId, keep: number): Promise<void> {
  const entries = (await fs.readdir(INSTRUCTION_HISTORY_DIR).catch(() => []))
    .filter((name) => name.endsWith(`-${id}.json`))
    .sort((a, b) => b.localeCompare(a));
  await Promise.all(
    entries.slice(keep).map((name) => fs.rm(path.join(INSTRUCTION_HISTORY_DIR, name), { force: true }))
  );
}

async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.profilepilot-tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

function isClaudeInstructionShell(content: string): boolean {
  return normalizeInstructionShell(content) === normalizeInstructionShell(claudeInstructionShellContent());
}

function normalizeInstructionShell(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}
