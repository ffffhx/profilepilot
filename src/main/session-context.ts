import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { driverLabelFromCommand } from "./cdp-client";
import { POSIX_LOCALE_ENV, execFileAsync, isRecord, stringValue } from "./fs-util";

// 一个 CDP 客户端背后的“谁在用”：工具名（Codex / Claude Code / agent-browser…）、项目、会话标题。
// 只有能从进程/会话档案里解析出来时才带 agent/project/title；否则退化成纯 label。
export interface CdpClientContext {
  label: string;
  agent?: string;
  project?: string;
  title?: string;
  // 会话档案路径（内部用，不出 UI）：每轮 stat 它的 mtime 当“最后活动时间”。
  sessionFile?: string;
  // 会话档案最后修改时间（ISO）＝会话最近一次活动，用于区分活会话与残留连接。
  lastActive?: string;
}

// 同一 pid = 同一会话，解析结果不变：按 pid 缓存，轮询时零成本复用；进程消失即清理。
const contextByPid = new Map<number, CdpClientContext>();
// 会话档案的首句/项目也不变：按文件路径缓存，避免反复读文件。
const sessionInfoByFile = new Map<string, SessionInfo>();

interface SessionInfo {
  cwd?: string;
  project?: string;
  title?: string;
}

const GENERIC_RUNTIME_COMMS = new Set(["node", "deno", "bun"]);

// 给一批客户端解析上下文（带 pid 级缓存）。返回 pid -> context。
export async function resolveClientContexts(
  clients: { pid: number; label: string }[]
): Promise<Map<number, CdpClientContext>> {
  const alive = new Set(clients.map((client) => client.pid));
  for (const pid of [...contextByPid.keys()]) {
    if (!alive.has(pid)) {
      contextByPid.delete(pid);
    }
  }
  await Promise.all(
    clients.map(async (client) => {
      if (!contextByPid.has(client.pid)) {
        contextByPid.set(client.pid, await resolveOne(client.pid, client.label));
      }
    })
  );
  // 静态信息（工具/项目/标题）按 pid 缓存即可；但“最后活动时间”会随会话进行不断变，
  // 必须每轮重新 stat 会话档案，不能被 pid 缓存冻住——否则一个活会话会一直显示成很久没动。
  const result = new Map<number, CdpClientContext>();
  await Promise.all(
    clients.map(async (client) => {
      const base = contextByPid.get(client.pid);
      if (!base) {
        return;
      }
      const lastActive = base.sessionFile ? await fileMtimeIso(base.sessionFile) : undefined;
      result.set(client.pid, lastActive ? { ...base, lastActive } : base);
    })
  );
  return result;
}

async function fileMtimeIso(file: string): Promise<string | undefined> {
  try {
    const stats = await stat(file);
    return new Date(stats.mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

async function resolveOne(pid: number, comm: string): Promise<CdpClientContext> {
  const command = await psCommand(pid);

  // Codex：连 CDP 的是它自带 cua_node 内核，命令行直接带 --working-dir，据此反查活跃 rollout 拿标题。
  const workingDir = command ? codexWorkingDir(command) : null;
  if (workingDir) {
    const found = await codexSessionInfo(workingDir);
    return {
      label: "Codex",
      agent: "Codex",
      project: path.basename(workingDir) || workingDir,
      title: found?.info.title,
      sessionFile: found?.file
    };
  }

  // Claude Code：驱动进程（agent-browser / node）cwd 落在 …/claude-<uid>/<slug>/<sessionUuid>/… → 定位会话档案。
  const cwd = await lsofCwd(pid);
  const sessionFile = cwd ? claudeSessionFile(cwd) : null;
  if (sessionFile) {
    const info = await readSessionInfo(sessionFile, "claude");
    return {
      // 通用运行时名（node）没信息量，换成工具名；agent-browser 这种有名字的保留。
      label: GENERIC_RUNTIME_COMMS.has(comm) ? "Claude Code" : comm,
      agent: "Claude Code",
      project: info?.project,
      title: info?.title,
      // 档案不存在（info 为空）就别挂路径，免得 stat 白跑；存在才拿去算最后活动时间。
      sessionFile: info ? sessionFile : undefined
    };
  }

  // 认不出具体会话（如独立启动、非某个 Claude 会话派生的 agent-browser）：至少把运行时名
  // 升级成工具真名，并用它的工作目录名当“项目”，让用户知道是哪个工具、在哪个目录跑。
  // 没有会话档案可追，故不给 sessionFile/lastActive——不伪造活跃度。
  return {
    label: command ? driverLabelFromCommand(command, comm) : comm,
    project: cwd ? projectFromCwd(cwd) : undefined
  };
}

// 拿工作目录名当“项目”兜底；根目录/家目录太泛，不当项目。
function projectFromCwd(cwd: string): string | undefined {
  if (cwd === "/" || cwd === homedir()) {
    return undefined;
  }
  return path.basename(cwd) || undefined;
}

async function psCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      maxBuffer: 1024 * 1024,
      env: POSIX_LOCALE_ENV
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function lsofCwd(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      maxBuffer: 1024 * 1024
    });
    const line = stdout.split("\n").find((entry) => entry.startsWith("n"));
    return line ? line.slice(1).trim() || null : null;
  } catch {
    return null;
  }
}

function codexWorkingDir(command: string): string | null {
  if (!command.includes("Codex.app") && !command.includes("cua_node")) {
    return null;
  }
  const match = command.match(/--working-dir[= ]+(\S+)/);
  return match ? match[1] : null;
}

// …/claude-<uid>/<slug>/<sessionUuid>/… → ~/.claude/projects/<slug>/<sessionUuid>.jsonl
function claudeSessionFile(cwd: string): string | null {
  const match = cwd.match(/\/claude-\d+\/([^/]+)\/([0-9a-fA-F-]{36})(?:\/|$)/);
  if (!match) {
    return null;
  }
  return path.join(homedir(), ".claude", "projects", match[1], `${match[2]}.jsonl`);
}

// codex app-server 是共享进程，会同时开着多个会话的 rollout；用 lsof 只挑“当前打开着”的，
// 再按 session_meta.cwd 匹配 working-dir、取文件名时间戳最新的一个（=正在用的那个会话）。
async function codexSessionInfo(workingDir: string): Promise<{ file: string; info: SessionInfo } | null> {
  let rollouts: string[];
  try {
    const { stdout } = await execFileAsync("lsof", ["-c", "codex", "-Fn"], {
      maxBuffer: 4 * 1024 * 1024
    });
    rollouts = [
      ...new Set(
        stdout
          .split("\n")
          .filter((entry) => entry.startsWith("n"))
          .map((entry) => entry.slice(1))
          .filter((name) => /\/sessions\/.*rollout-.*\.jsonl$/.test(name))
      )
    ]
      // 文件名里就是 rollout-<ISO时间戳>-...，按文件名（而非完整路径）降序＝最新会话在前；
      // 不能按整条路径排，否则 .mew/.codex 这类目录前缀会盖过时间戳。
      .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  } catch {
    return null;
  }

  for (const file of rollouts) {
    const info = await readSessionInfo(file, "codex");
    if (info?.cwd === workingDir) {
      return { file, info };
    }
  }
  return null;
}

// 读会话档案（Codex rollout / Claude jsonl），提取 cwd/project 和“首句标题”。只扫文件头，够了就停。
async function readSessionInfo(file: string, kind: "codex" | "claude"): Promise<SessionInfo | null> {
  const cached = sessionInfoByFile.get(file);
  if (cached) {
    return cached;
  }
  try {
    await access(file);
  } catch {
    return null;
  }

  const info: SessionInfo = {};
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let scanned = 0;
  try {
    for await (const line of rl) {
      if (++scanned > 400) {
        break; // 首句一般在前几十行；封顶防超大档案拖慢轮询
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      if (kind === "codex") {
        if (!info.cwd) {
          info.cwd = codexMetaCwd(parsed);
        }
        if (!info.title) {
          info.title = codexUserTitle(parsed);
        }
      } else {
        if (!info.cwd) {
          const cwd = stringValue(parsed.cwd);
          if (cwd) {
            info.cwd = cwd;
            info.project = path.basename(cwd);
          }
        }
        if (!info.title) {
          info.title = claudeUserTitle(parsed);
        }
      }
      if (info.title && info.cwd) {
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  sessionInfoByFile.set(file, info);
  return info;
}

function codexMetaCwd(entry: Record<string, unknown>): string | undefined {
  if (stringValue(entry.type) !== "session_meta" || !isRecord(entry.payload)) {
    return undefined;
  }
  return stringValue(entry.payload.cwd) || undefined;
}

function codexUserTitle(entry: Record<string, unknown>): string | undefined {
  const payload = isRecord(entry.payload) ? entry.payload : entry;
  if (stringValue(payload.type) !== "message" || stringValue(payload.role) !== "user") {
    return undefined;
  }
  if (!Array.isArray(payload.content)) {
    return undefined;
  }
  for (const part of payload.content) {
    const title = titleFromMessage((isRecord(part) ? stringValue(part.text) : "") || "");
    if (title) {
      return title;
    }
  }
  return undefined;
}

function claudeUserTitle(entry: Record<string, unknown>): string | undefined {
  if (stringValue(entry.type) !== "user" || !isRecord(entry.message)) {
    return undefined;
  }
  const content = entry.message.content;
  let raw = "";
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .map((part) => (isRecord(part) && stringValue(part.type) === "text" ? stringValue(part.text) : ""))
      .filter(Boolean)
      .join(" ");
  }
  return titleFromMessage(raw);
}

// 一条 user 消息 → 标题。注入内容（AGENTS.md/CLAUDE.md 预注入、<environment_context> 等 <tag> 包裹、
// 命令回执/打断提示）都是整条独立消息，开头即可判定：命中就整条丢弃，否则取第一行非空文本当标题。
function titleFromMessage(raw: string): string | undefined {
  const head = raw.trimStart();
  if (!head || isInjectedNoise(head)) {
    return undefined;
  }
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (text) {
      return text.slice(0, 120);
    }
  }
  return undefined;
}

function isInjectedNoise(text: string): boolean {
  return (
    text.startsWith("<") ||
    text.startsWith("# AGENTS.md") ||
    text.startsWith("# CLAUDE.md") ||
    text.startsWith("Caveat:") ||
    text.startsWith("[Request interrupted")
  );
}
