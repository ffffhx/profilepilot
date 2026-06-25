import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  GlobalInstructionFile,
  GlobalInstructionFileId,
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
  const files = await Promise.all(GLOBAL_INSTRUCTION_SOURCES.map(readGlobalInstructionFile));
  return {
    readAt: new Date().toISOString(),
    files
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

  await writeTextFileAtomic(source.path, content);
  await ensureClaudeInstructionShell();

  return readGlobalInstructions();
}

export async function ensureClaudeInstructionShell(): Promise<GlobalInstructionsSnapshot> {
  const claudeSource = GLOBAL_INSTRUCTION_SOURCES.find((item) => item.id === "claude-memory");
  if (!claudeSource) {
    throw new ProfileManagerError("没有找到 CLAUDE.md 配置。", "GLOBAL_INSTRUCTION_NOT_FOUND");
  }

  await writeTextFileAtomic(claudeSource.path, claudeInstructionShellContent());

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
      referenceShellContent: source.role === "reference" ? claudeInstructionShellContent() : null,
      isReferenceShell: source.role === "reference" ? false : null
    };
  }
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
