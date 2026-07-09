import { CdpClientInfo, CdpContentionChurn, CdpContentionInfo } from "../shared/types";
import { CdpBrowserClient, requestCdpVersionInfo } from "./cdp-client";
import { isRecord, stringValue } from "./fs-util";

// tab 争用观测：ProfilePilot 以观察者身份对每个 live CDP 端口保持一条 browser 级长连接，
// 订阅 Target.* 事件流，记录每个 page target 的 URL 变化轨迹。
// CDP 协议不暴露“哪个客户端 attach 了哪个 target”，无法精确归属；但“同一个标签页短时间内
// URL 反复往返改写（A→B→A）”是两个会话抢同一个 tab 的强信号——单会话正常浏览极少来回横跳。
// 这里只产出原始观测（变化次数/往返次数），是否判定“疑似争用”由 profile-manager 结合连接数决定。

// 观察窗口：只统计最近这段时间内的 URL 变化；窗口外的记录滚动丢弃。
const CHURN_WINDOW_MS = 90_000;
const OBSERVER_CONNECT_TIMEOUT = 3000;
// 单个 target 窗口内最多留这么多条变化记录，防止极端页面（高频跳转）撑爆内存。
const MAX_CHANGES_PER_TARGET = 120;

interface TargetTrack {
  url: string;
  title: string;
  // 窗口内的 URL 变化：时间戳 + 变化后的 URL（保序，用于识别 A→B→A 往返翻转）。
  changes: { at: number; url: string }[];
  // 「一 tab 一 owner」打戳（借鉴 ego-lite 的 TaskSpace）：这个 tab 在窗口内被哪些 owner 会话
  // 驱动过，ownerKey → 最近一次“驱动此 tab 时该 owner 在连”的时间戳。CDP 不暴露“谁改的 URL”，
  // 只能在 URL 变化的那一刻把当时在连的 owner 集合都记上；窗口内出现 ≥2 个不同 owner 即视为被争抢。
  owners: Map<string, number>;
}

interface PortObserver {
  port: number;
  client: CdpBrowserClient | null;
  connecting: boolean;
  targets: Map<string, TargetTrack>;
  // 当前连在这个端口上的 owner 会话集合（ownerKey → 最近一轮见到的时间戳），每轮由
  // resolveCdpContention 用最新的驱动连接刷新；URL 变化时据此给 tab 打上 owner 戳。
  owners: Map<string, number>;
}

const observers = new Map<number, PortObserver>();

// 每轮状态刷新时调用：为新出现的 live 端口建立观察连接，为消失的端口拆除。
// 连接失败（端口刚关/正在启动）静默跳过，下一轮自然重试；不阻塞调用方。
export function syncContentionObservers(livePorts: number[]): void {
  const wanted = new Set(livePorts);
  for (const [port, observer] of observers) {
    if (!wanted.has(port)) {
      observers.delete(port);
      observer.client?.close();
    }
  }
  for (const port of wanted) {
    let observer = observers.get(port);
    if (!observer) {
      observer = { port, client: null, connecting: false, targets: new Map(), owners: new Map() };
      observers.set(port, observer);
    }
    void connectObserver(observer);
  }
}

async function connectObserver(observer: PortObserver): Promise<void> {
  if (observer.client || observer.connecting) {
    return;
  }
  observer.connecting = true;
  try {
    const version = await requestCdpVersionInfo(observer.port);
    if (!version.webSocketDebuggerUrl) {
      return;
    }
    const client = await CdpBrowserClient.connect(version.webSocketDebuggerUrl, OBSERVER_CONNECT_TIMEOUT);
    client.onEvent = (method, params) => {
      handleTargetEvent(observer, method, params);
    };
    client.onDisconnect = () => {
      // 浏览器关闭/连接断开：清空客户端与轨迹，端口若还在 wanted 里下一轮会重连。
      if (observer.client === client) {
        observer.client = null;
        observer.targets.clear();
        observer.owners.clear();
      }
    };
    observer.client = client;
    try {
      await client.send("Target.setDiscoverTargets", { discover: true });
    } catch {
      client.close();
      // onDisconnect 会把 observer.client 置空；这里不再重复清理。
    }
  } catch {
    // 端口暂时不可达（浏览器启动中/刚退出），保留 observer 让下一轮重试。
  } finally {
    observer.connecting = false;
  }
}

function handleTargetEvent(observer: PortObserver, method: string, params: unknown): void {
  if (!isRecord(params)) {
    return;
  }

  if (method === "Target.targetDestroyed") {
    const targetId = stringValue(params.targetId);
    if (targetId) {
      observer.targets.delete(targetId);
    }
    return;
  }

  if (method !== "Target.targetCreated" && method !== "Target.targetInfoChanged") {
    return;
  }
  const info = params.targetInfo;
  if (!isRecord(info) || stringValue(info.type) !== "page") {
    return;
  }
  const targetId = stringValue(info.targetId);
  if (!targetId) {
    return;
  }
  const url = stringValue(info.url) || "";
  const title = stringValue(info.title) || "";

  const track = observer.targets.get(targetId);
  if (!track) {
    observer.targets.set(targetId, { url, title, changes: [], owners: new Map() });
    return;
  }
  // 只记“URL 真的变了”；title 抖动（页面加载中反复改标题）不算控制权信号。
  if (url && track.url && url !== track.url) {
    const now = Date.now();
    track.changes.push({ at: now, url });
    const cutoff = now - CHURN_WINDOW_MS;
    while (track.changes.length && (track.changes[0].at < cutoff || track.changes.length > MAX_CHANGES_PER_TARGET)) {
      track.changes.shift();
    }
    // 给这个 tab 打上“改动发生时在连的 owner 会话”戳；窗口外的旧 owner 顺手清掉。
    for (const owner of observer.owners.keys()) {
      track.owners.set(owner, now);
    }
    for (const [owner, at] of track.owners) {
      if (at < cutoff) {
        track.owners.delete(owner);
      }
    }
  }
  track.url = url || track.url;
  track.title = title || track.title;
}

// 某个连接的 owner 会话标识：优先用使用方自报的命名 session（AGENT_BROWSER_SESSION，如
// cc-/cx-<uuid>）——这就是 ego-lite 里 tab 的 owner；没有命名 session 时退化成 pid:<pid>，
// 至少能把不同进程的连接区分开。
export function ownerKeyForClient(client: CdpClientInfo): string {
  const session = client.session?.trim();
  return session ? session : `pid:${client.pid}`;
}

// 每轮用最新的驱动连接刷新“端口上现在连着哪些 owner 会话”，供 URL 变化时给 tab 打戳。
function refreshPortOwners(port: number, clients: CdpClientInfo[]): void {
  const observer = observers.get(port);
  if (!observer) {
    return;
  }
  const now = Date.now();
  observer.owners.clear();
  for (const client of clients) {
    observer.owners.set(ownerKeyForClient(client), now);
  }
}

// 取某端口当前观测快照：是否在观察中 + 窗口内“最抖”的那个标签页（无明显抖动时 churn=null）。
export function getContentionChurn(port: number): { observing: boolean; churn: CdpContentionChurn | null } {
  const observer = observers.get(port);
  if (!observer || !observer.client) {
    return { observing: false, churn: null };
  }

  const cutoff = Date.now() - CHURN_WINDOW_MS;
  let best: CdpContentionChurn | null = null;
  for (const track of observer.targets.values()) {
    const recent = track.changes.filter((change) => change.at >= cutoff);
    if (!recent.length) {
      continue;
    }
    const owners = [...track.owners].filter(([, at]) => at >= cutoff).map(([owner]) => owner);
    const candidate: CdpContentionChurn = {
      title: track.title,
      url: track.url,
      changes: recent.length,
      flipBacks: countFlipBacks(recent.map((change) => change.url)),
      owners
    };
    // 挑“最像被争抢”的那个 tab：先看是不是被多 owner 驱动（最强信号），再看往返翻转、变化次数。
    if (!best || isMoreContended(candidate, best)) {
      best = candidate;
    }
  }
  return { observing: true, churn: best };
}

function isMoreContended(candidate: CdpContentionChurn, best: CdpContentionChurn): boolean {
  const candidateMulti = candidate.owners.length >= 2 ? 1 : 0;
  const bestMulti = best.owners.length >= 2 ? 1 : 0;
  if (candidateMulti !== bestMulti) {
    return candidateMulti > bestMulti;
  }
  if (candidate.flipBacks !== best.flipBacks) {
    return candidate.flipBacks > best.flipBacks;
  }
  return candidate.changes > best.changes;
}

// 判定“会话仍活跃”的窗口：会话档案 mtime 距今在此窗口内算活会话。
// 取 2 分钟：agent 一轮思考/工具调用间隔可能到分钟级，太短会把活会话误判成残留。
const ACTIVE_SESSION_WINDOW_MS = 2 * 60_000;
// 往返翻转达到这个次数才判“疑似争用”：偶发一次 A→B→A 可能是单会话的正常回退。
const FLIP_BACKS_THRESHOLD = 2;

// 综合判定一个端口的争用状态（每轮 getState 对每个 live 端口调用）：
// contention＝观察到抢写证据（往返翻转≥阈值，或同一 tab 被 ≥2 个不同 owner 会话驱动）且 ≥2 条驱动连接；
// risk＝≥2 条连接且 ≥2 个会话最近都有活动（还没等到/没观察到实际抢写）；
// 其余（单连接、一活一残留、纯残留）为 null，不打扰。
export function resolveCdpContention(port: number, clients: CdpClientInfo[]): CdpContentionInfo {
  const now = Date.now();
  // 先把“端口上现在连着哪些 owner 会话”记到观察者上，让后续 URL 变化能给 tab 精确打戳。
  refreshPortOwners(port, clients);
  const activeClientCount = clients.filter((client) => {
    const at = client.lastActive ? Date.parse(client.lastActive) : NaN;
    return Number.isFinite(at) && now - at <= ACTIVE_SESSION_WINDOW_MS;
  }).length;

  const { observing, churn } = getContentionChurn(port);
  let level: CdpContentionInfo["level"] = null;
  if (clients.length >= 2) {
    if (churn && (churn.flipBacks >= FLIP_BACKS_THRESHOLD || churn.owners.length >= 2)) {
      // 往返翻转达阈值，或“一 tab 两 owner”——后者是比纯 URL 抖动更精准的争抢证据。
      level = "contention";
    } else if (activeClientCount >= 2) {
      level = "risk";
    }
  }
  return {
    activeClientCount,
    observing,
    churn: level === "contention" ? churn : null,
    level
  };
}

// 往返翻转：URL 序列里出现“改回上上次的值”（…A→B→A）记一次。
// 这是区分“单会话顺序浏览”（URL 一路向前）和“两个会话抢写”（来回横跳）的核心指标。
export function countFlipBacks(urls: string[]): number {
  let flips = 0;
  for (let i = 2; i < urls.length; i += 1) {
    if (urls[i] === urls[i - 2] && urls[i] !== urls[i - 1]) {
      flips += 1;
    }
  }
  return flips;
}
