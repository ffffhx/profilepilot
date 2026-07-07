import { createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
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
  // 使用方自报的命名 session（agent-browser --session <名>）；UI 里单独一行展示，不拼进工具名。
  session?: string;
  // 会话档案路径（内部用，不出 UI）：每轮 stat 它的 mtime 当“最后活动时间”。
  sessionFile?: string;
  // 会话档案最后修改时间（ISO）＝会话最近一次活动，用于区分活会话与残留连接。
  lastActive?: string;
  // 归属可信度说明（共享 daemon 按启动目录推测等），给 UI tooltip 用；精确归属时为空。
  note?: string;
}

// 缓存条目：在 CdpClientContext 之上多带 daemon 推测锚点。
// agent-browser 是常驻 daemon（default.sock 单例），会被多个会话先后复用；它的 cwd 永远是
// “出生时”的目录，跟当前使用者无关——归属只能按该目录推测，且必须每轮重查 + 新鲜度门槛，
// 不能像普通驱动进程那样按 pid 把解析结果钉死。
interface CachedContext extends CdpClientContext {
  daemonGuessCwd?: string;
  daemonSession?: string;
}

// 同一 pid = 同一会话，解析结果不变：按 pid 缓存，轮询时零成本复用；进程消失即清理。
const contextByPid = new Map<number, CachedContext>();
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
  // daemon 型驱动（agent-browser）的会话归属本身也是易变的，整段每轮重推。
  const result = new Map<number, CdpClientContext>();
  await Promise.all(
    clients.map(async (client) => {
      const base = contextByPid.get(client.pid);
      if (!base) {
        return;
      }
      if (base.daemonGuessCwd) {
        result.set(client.pid, await resolveDaemonContext(base));
        return;
      }
      const lastActive = base.sessionFile ? await fileMtimeIso(base.sessionFile) : undefined;
      result.set(client.pid, lastActive ? { ...base, lastActive } : base);
    })
  );
  return result;
}

// 出生目录里反查出的会话，最近这么久内有动静才认作“当前使用者”；再旧就只能算归属未知。
// 窗口别太小：agent 一轮长任务里会话档案可能几分钟不动。
const DAEMON_GUESS_FRESH_MS = 5 * 60_000;

// agent-browser daemon 的归属推测（每轮重算）：按它的启动目录找最新会话档案。
// 档案够新 → 给出归属但注明是推测；不够新 → 只报“共享 daemon、会话未知”，宁缺毋滥——
// 张冠李戴（把别的项目的旧会话当成当前驱动者）比不显示更糟。
async function resolveDaemonContext(base: CachedContext): Promise<CdpClientContext> {
  const cwd = base.daemonGuessCwd as string;
  const dirName = path.basename(cwd) || cwd;
  const named = base.daemonSession && base.daemonSession !== "default" ? base.daemonSession : "";

  // session 名带会话 UUID（~/.zshenv 从 CLAUDE_CODE_SESSION_ID 自动注入，格式 cc-<uuid>）：
  // 直接定位到会话档案——这是使用方环境自报的精确身份，不需要也不该再按出生目录推测。
  const uuid = named.match(/^cc-([0-9a-fA-F-]{36})$/)?.[1];
  if (uuid) {
    const file = await findClaudeSessionByUuid(uuid);
    if (file) {
      const info = await readSessionInfo(file, "claude");
      return {
        label: base.label,
        agent: "Claude Code",
        project: info?.project,
        title: info?.title,
        lastActive: await fileMtimeIso(file)
      };
    }
  }

  // cx-<uuid>：~/.zshenv 从 CODEX_THREAD_ID 自动注入的 Codex 会话身份。thread id 就是
  // rollout 档案名末尾的 UUID，直接定位档案——和 cc- 一样是精确归属，不需要推测。
  const codexUuid = named.match(/^cx-([0-9a-fA-F-]{36})$/)?.[1];
  if (codexUuid) {
    const file = await findCodexSessionByUuid(codexUuid);
    if (file) {
      const info = await readSessionInfo(file, "codex");
      return {
        label: base.label,
        agent: "Codex",
        project: info?.cwd ? path.basename(info.cwd) : undefined,
        title: info?.title,
        lastActive: await fileMtimeIso(file)
      };
    }
  }

  // 其余命名 session：它是使用方自报的身份，比目录推测可靠得多。
  // 但不拼进工具名（工具一行只放工具），作为独立 session 字段传给 UI 单独成行。
  const session = named || undefined;
  const sessionTag = named ? ` · session: ${named}` : "";

  // cx-<非uuid>：旧版托管块注入的项目目录名身份，或用户手动带的 cx- 前缀 session。
  // 剥掉前缀按项目名解析（项目级推测归属）。
  const cxProject = named.match(/^cx-(.+)$/)?.[1];
  if (cxProject) {
    const codexByName = await codexSessionByProjectName(cxProject);
    if (codexByName) {
      return {
        label: base.label,
        agent: "Codex",
        session,
        project: codexByName.project,
        title: codexByName.info.title,
        lastActive: await fileMtimeIso(codexByName.file),
        note: `归属为推测：按注入的项目名（cx-）匹配到 ${codexByName.project} 当前打开的 Codex 会话`
      };
    }
  }

  // 命名 session 的约定是 `--session <项目名>`（Codex 等无自动注入的 agent 手动带）。
  // 先拿 session 名当项目名，反查该项目当前打开着的 Codex rollout——命中即可把
  // 工具/项目/标题/活动补齐，比按 daemon 出生目录猜可靠得多。
  if (named && !cxProject) {
    const codexByName = await codexSessionByProjectName(named);
    if (codexByName) {
      return {
        label: base.label,
        agent: "Codex",
        session,
        project: codexByName.project,
        title: codexByName.info.title,
        lastActive: await fileMtimeIso(codexByName.file),
        note: `归属为推测：按 session 名匹配到项目 ${codexByName.project} 当前打开的 Codex 会话`
      };
    }
  }

  // 出生目录本身就在某个 Claude 会话的 scratchpad 里 → 直接定位到出生会话的档案；
  // 但 sock 名没带会话身份才会走到这（出生会话≠当前使用者），所以仍按推测+新鲜度处理。
  let file = claudeSessionFile(cwd) ?? (await latestClaudeSessionForCwd(cwd));
  let info = file ? await readSessionInfo(file, "claude") : null;
  if (!info) {
    const codex = await codexSessionInfo(cwd);
    if (codex) {
      file = codex.file;
      info = codex.info;
    }
  }
  const lastActive = file ? await fileMtimeIso(file) : undefined;
  const fresh = lastActive ? Date.now() - Date.parse(lastActive) <= DAEMON_GUESS_FRESH_MS : false;

  // 文案按 daemon 身份分档：命名 session 是"专属 daemon、名字可被同名接力"，
  // default 才是真正的"共享 daemon、谁都可能在用"——混为一谈会让用户以为命名也是共享的。
  if (info && fresh) {
    return {
      label: base.label,
      session,
      project: info.project || dirName,
      title: info.title,
      lastActive,
      note: named
        ? `归属为推测：session 名不含会话标识，按 daemon 启动目录（${dirName}）匹配的最新会话；同名 session 先后接力时可能不是当前使用者`
        : `归属为推测：未命名（default）daemon 由所有裸会话共用（启动于 ${dirName}），可能不是当前使用者`
    };
  }
  return {
    label: base.label,
    session,
    note: named
      ? `session「${named}」的专属 daemon（启动于 ${dirName}）：该目录下近期无活跃会话，可能是会话结束后的残留连接`
      : `共享 daemon（启动于 ${dirName}${sessionTag}）：该目录下近期无活跃会话，无法从连接判定当前使用者；多会话并发建议各用 --session 隔离`
  };
}

// 按会话 UUID 全局定位 Claude 会话档案：~/.claude/projects/<任意项目>/<uuid>.jsonl。
// 找到的路径不会变，正向缓存；找不到不缓存——会话档案可能在会话刚启动时尚未落盘。
const claudeSessionFileByUuid = new Map<string, string>();

async function findClaudeSessionByUuid(uuid: string): Promise<string | null> {
  const cached = claudeSessionFileByUuid.get(uuid);
  if (cached) {
    return cached;
  }
  const root = path.join(homedir(), ".claude", "projects");
  let slugs: string[];
  try {
    slugs = await readdir(root);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const candidate = path.join(root, slug, `${uuid}.jsonl`);
    try {
      await access(candidate);
      claudeSessionFileByUuid.set(uuid, candidate);
      return candidate;
    } catch {
      // 该项目下没有，继续。
    }
  }
  return null;
}

// 按 thread UUID 定位 Codex rollout 档案（rollout-<时间戳>-<uuid>.jsonl）。
// 路径找到就不会变，正向缓存；找不到不缓存——会话可能刚启动、档案尚未落盘。
const codexSessionFileByUuid = new Map<string, string>();

async function findCodexSessionByUuid(uuid: string): Promise<string | null> {
  const cached = codexSessionFileByUuid.get(uuid);
  if (cached) {
    return cached;
  }
  const suffix = `-${uuid}.jsonl`;
  // 活会话：codex 进程始终开着自己的 rollout，lsof 直接命中——且不依赖 CODEX_HOME 在哪。
  for (const file of await listOpenCodexRollouts()) {
    if (file.endsWith(suffix)) {
      codexSessionFileByUuid.set(uuid, file);
      return file;
    }
  }
  // 会话已结束的残留连接：到默认 CODEX_HOME 的日期分片目录（sessions/YYYY/MM/DD/）反查。
  // 新日期优先，并给扫描量封顶——残留连接对应的会话就在近期，扫太远只会拖慢轮询。
  const root = path.join(homedir(), ".codex", "sessions");
  let scannedDays = 0;
  for (const year of await readdirDesc(root)) {
    for (const month of await readdirDesc(path.join(root, year))) {
      for (const day of await readdirDesc(path.join(root, year, month))) {
        if (++scannedDays > 62) {
          return null;
        }
        const dir = path.join(root, year, month, day);
        const name = (await readdirDesc(dir)).find((entry) => entry.endsWith(suffix));
        if (name) {
          const file = path.join(dir, name);
          codexSessionFileByUuid.set(uuid, file);
          return file;
        }
      }
    }
  }
  return null;
}

// 目录项按名字降序（日期分片目录＝新的在前）；目录不存在返回空。
async function readdirDesc(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

// agent-browser daemon 打开的 unix socket（~/.agent-browser/<session>.sock）→ session 名。
// 配合“每个并发会话各用 --session <名>”的使用纪律，session 名就是可靠的归属标识。
async function agentBrowserSockSession(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-U", "-Fn"], {
      maxBuffer: 1024 * 1024
    });
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("n")) {
        continue;
      }
      const match = line.slice(1).match(/\/\.agent-browser\/([^/]+)\.sock$/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // lsof 失败不致命，退化成不带 session 名。
  }
  return undefined;
}

async function fileMtimeIso(file: string): Promise<string | undefined> {
  try {
    const stats = await stat(file);
    return new Date(stats.mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

async function resolveOne(pid: number, comm: string): Promise<CachedContext> {
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

  const cwd = await lsofCwd(pid);

  // agent-browser 是常驻共享 daemon：sock 名携带使用方自报的身份（cc-/cx-），优先级必须
  // 高于一切 cwd 推断——cwd 只是“出生时”的目录，哪怕落在某个 Claude 会话的 scratchpad 里，
  // 实际使用者也可能是别的会话（如 Codex 嵌套跑在 Claude 会话里）。所以这里不钉死归属，
  // 只记推测锚点（cwd + sock session 名），交给 resolveDaemonContext 每轮重推。
  const label = command ? driverLabelFromCommand(command, comm) : comm;
  if (label === "agent-browser" && cwd) {
    return { label, daemonGuessCwd: cwd, daemonSession: await agentBrowserSockSession(pid) };
  }

  // Claude Code：驱动进程（node 等）cwd 落在 …/claude-<uid>/<slug>/<sessionUuid>/… → 定位会话档案。
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

  // 其余独立驱动（Playwright/Puppeteer 脚本等）是使用者自己 spawn 的短周期进程，cwd 可靠。
  // 如果这个项目目录当前正有会话在跑，按 cwd 反查到它，补上会话标题和最近活动时间：
  //   · Claude Code：cwd 直接映射成 ~/.claude/projects/<slug>/ 下的会话，取 mtime 最新的那个（=正在用的）。
  //   · Codex：按 cwd 匹配当前打开着的 rollout。
  if (cwd) {
    const claudeFile = await latestClaudeSessionForCwd(cwd);
    if (claudeFile) {
      const info = await readSessionInfo(claudeFile, "claude");
      return { label, project: info?.project || projectFromCwd(cwd), title: info?.title, sessionFile: claudeFile };
    }
    const codex = await codexSessionInfo(cwd);
    if (codex) {
      return { label, project: projectFromCwd(cwd), title: codex.info.title, sessionFile: codex.file };
    }
    // 没有会话可追，至少用 cwd 目录名当项目；不给 lastActive——不伪造活跃度。
    return { label, project: projectFromCwd(cwd) };
  }
  return { label };
}

// 拿工作目录名当“项目”兜底；根目录/家目录太泛，不当项目。
function projectFromCwd(cwd: string): string | undefined {
  if (cwd === "/" || cwd === homedir()) {
    return undefined;
  }
  return path.basename(cwd) || undefined;
}

// cwd → Claude 项目 slug（Claude 把工作目录里的 / 和 . 都换成 -）→ 该目录下最近改动的会话档案。
// 用于驱动进程 cwd 就是项目目录（而非 scratchpad）的情况：取 mtime 最新的会话＝当前正在用的那个。
async function latestClaudeSessionForCwd(cwd: string): Promise<string | null> {
  const slug = cwd.replace(/[/.]/g, "-");
  const dir = path.join(homedir(), ".claude", "projects", slug);
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }
  const stamped = await Promise.all(
    entries.map(async (name) => {
      const file = path.join(dir, name);
      const stats = await stat(file).catch(() => null);
      return stats ? { file, mtimeMs: stats.mtimeMs } : null;
    })
  );
  let best: { file: string; mtimeMs: number } | null = null;
  for (const item of stamped) {
    if (item && (!best || item.mtimeMs > best.mtimeMs)) {
      best = item;
    }
  }
  return best ? best.file : null;
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

// codex app-server 是共享进程，会同时开着多个会话的 rollout；用 lsof 只挑“当前打开着”的。
// 返回按文件名时间戳降序（最新会话在前）的 rollout 路径列表。
async function listOpenCodexRollouts(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-c", "codex", "-Fn"], {
      maxBuffer: 4 * 1024 * 1024
    });
    return [
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
    return [];
  }
}

// 按 session_meta.cwd 精确匹配 working-dir、取最新的打开着的 rollout（=正在用的那个会话）。
async function codexSessionInfo(workingDir: string): Promise<{ file: string; info: SessionInfo } | null> {
  for (const file of await listOpenCodexRollouts()) {
    const info = await readSessionInfo(file, "codex");
    if (info?.cwd === workingDir) {
      return { file, info };
    }
  }
  return null;
}

// 按项目目录名（cwd 的 basename）匹配打开着的 Codex rollout。
// 用于 agent-browser 命名 session 的归属：约定是 `--session <项目名>`（Codex 等无自动注入的
// agent 并发用浏览器时手动带），实际使用中还会加用途后缀（如 agent-snapshots-bifrost）。
// 所以先精确匹配，再退化为“session 名 = 项目名-<后缀>”的前缀匹配；
// 多个项目都能前缀命中时取项目名最长的（agent-snapshots 优先于 agent），列表新会话在前。
async function codexSessionByProjectName(
  sessionName: string
): Promise<{ file: string; info: SessionInfo; project: string } | null> {
  if (!sessionName) {
    return null;
  }
  let bestPrefix: { file: string; info: SessionInfo; project: string } | null = null;
  for (const file of await listOpenCodexRollouts()) {
    const info = await readSessionInfo(file, "codex");
    const base = info?.cwd ? path.basename(info.cwd) : "";
    if (!info || !base) {
      continue;
    }
    if (base === sessionName) {
      return { file, info, project: base };
    }
    if (sessionName.startsWith(`${base}-`) && (!bestPrefix || base.length > bestPrefix.project.length)) {
      bestPrefix = { file, info, project: base };
    }
  }
  return bestPrefix;
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
      return decodePercentEncoding(text).slice(0, 120);
    }
  }
  return undefined;
}

// 首句常是用户粘的链接，里头的 %E9%83%A8 之类 percent-encoded 中文在 UI 里是乱码；
// 尽量解码成可读文字。不是合法编码（如出现裸 % ）就原样返回。
function decodePercentEncoding(text: string): string {
  if (!text.includes("%")) {
    return text;
  }
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
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
