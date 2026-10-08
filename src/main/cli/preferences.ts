import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliSettings { defaultProfile?: string; theme: "auto" | "dark" | "light" | "mono"; model?: string; historyEnabled: boolean; persistDraft: boolean; screenReader?: boolean; reducedMotion?: boolean; }
const DEFAULTS: CliSettings = { theme: "auto", historyEnabled: true, persistDraft: false };
const MAX_HISTORY = 500, MAX_TEXT = 30000;

/** Each workspace has its own input history; provider credentials never belong here. */
export class CliPreferencesStore {
  readonly root: string;
  readonly settingsPath: string;
  readonly historyPath: string;
  readonly draftPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(options: { homeDir?: string; cwd?: string } = {}) {
    this.root = path.join(options.homeDir || os.homedir(), ".profilepilot", "cli");
    this.settingsPath = path.join(this.root, "settings.json");
    const scope = workspaceHistoryKey(options.cwd || process.cwd());
    this.historyPath = path.join(this.root, "history", `${scope}.json`);
    this.draftPath = path.join(this.root, "drafts", `${scope}.json`);
  }
  async loadSettings(): Promise<CliSettings> { return parseSettings(await readJson(this.settingsPath)); }
  saveSettings(patch: Partial<CliSettings>): Promise<CliSettings> {
    return this.serial(async () => {
      const settings = parseSettings({ ...await this.loadSettings(), ...patch });
      await atomicJson(this.settingsPath, settings); return settings;
    });
  }
  async readHistory(): Promise<string[]> {
    if (!(await this.loadSettings()).historyEnabled) return [];
    const content = await readJson(this.historyPath);
    if (!Array.isArray(content)) return [];
    return content.filter((entry): entry is string => typeof entry === "string" && entry.length <= MAX_TEXT && !containsSecret(entry)).slice(-MAX_HISTORY);
  }
  appendHistory(text: string): Promise<void> {
    return this.serial(async () => {
      if (!text.trim() || text.length > MAX_TEXT || containsSecret(text) || !(await this.loadSettings()).historyEnabled) return;
      const history = await this.readHistory();
      if (history.at(-1) !== text) history.push(text);
      const bounded = history.slice(-MAX_HISTORY);
      while (bounded.length > 1 && Buffer.byteLength(JSON.stringify(bounded), "utf8") > 2 * 1024 * 1024) bounded.shift();
      await atomicJson(this.historyPath, bounded);
    });
  }
  async loadDraft(): Promise<string> {
    if (!(await this.loadSettings()).persistDraft) return "";
    const value = await readJson(this.draftPath);
    return typeof value === "string" && value.length <= MAX_TEXT && !containsSecret(value) ? value : "";
  }
  saveDraft(text: string): Promise<void> {
    return this.serial(async () => {
      if (!text || text.length > MAX_TEXT || containsSecret(text) || !(await this.loadSettings()).persistDraft) { await fs.rm(this.draftPath, { force: true }); return; }
      await atomicJson(this.draftPath, text);
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation); this.queue = next.catch(() => {}); return next;
  }
}

export function workspaceHistoryKey(cwd: string, platform = process.platform): string {
  const normalized = platform === "win32" ? path.win32.resolve(cwd).replace(/\\/g, "/").toLocaleLowerCase() : path.posix.resolve(cwd);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

/** Omit entire entries rather than storing a partially redacted secret-bearing command. */
export function containsSecret(text: string): boolean {
  return /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|authorization|password|passwd|secret|cookie)\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|(?:https?|socks5?):\/\/[^\s/@]+:[^\s/@]+@|^\s*\/(?:login|key|token|password)\s+\S+)/im.test(text);
}

function parseSettings(value: unknown): CliSettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const selected = (field: string): string | undefined => typeof raw[field] === "string" && raw[field].length <= 200 && raw[field].trim() && !containsSecret(raw[field]) ? raw[field] : undefined;
  const defaultProfile = selected("defaultProfile"), model = selected("model");
  return { ...DEFAULTS, ...(defaultProfile ? { defaultProfile } : {}), ...(model ? { model } : {}),
    theme: ["auto", "dark", "light", "mono"].includes(String(raw.theme)) ? raw.theme as CliSettings["theme"] : "auto",
    historyEnabled: typeof raw.historyEnabled === "boolean" ? raw.historyEnabled : true,
    persistDraft: typeof raw.persistDraft === "boolean" ? raw.persistDraft : false,
    screenReader: raw.screenReader === true, reducedMotion: raw.reducedMotion === true };
}
async function readJson(file: string): Promise<unknown> {
  try {
    const stat = await fs.stat(file); if (stat.size > 20 * 1024 * 1024) return undefined;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined; throw error; }
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => {});
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
