import { ProfilePilotSignalInfo } from "../shared/types";

// 面向 agent 的稳定信号码 —— 借鉴 ego-lite 的 EGO_* 契约模型：
//   「码是持久契约（跨版本不漂移），文案可以改」。
// ProfilePilot 检测到「端口争用 / 端口被占 / 会话被顶替」这些**面向 agent**的场景时，
// 不只给用户看现象（琥珀 ×2 ⚠），而是产出一条 { code, message, action, hardStop }：
//   · code     —— 稳定信号码，agent/上层据此分支，改文案不影响判定；
//   · message  —— 给人看的一句简述（面板/tooltip 里的现象描述）；
//   · action   —— **机器可照做的一句指令**（端口填好、命令拼好，照抄即可自救）；
//   · hardStop —— 是否属于「必须停手、按 action 处理」的硬停，对标 ego 的
//                 isEgoHardStopCode（USER_IN_CONTROL / INACTIVE）。
// 硬停信号在面板/overlay 上塌缩成一行 action 引导（见 renderer 的 collapse 逻辑），
// 对标 ego「hard-stop 把缓冲输出塌缩成一行引导」。

export enum ProfilePilotSignal {
  // 观察到多个会话正在抢同一个标签页（同一 tab 的 URL 短时间反复往返改写 A→B→A）。
  // 继续操作只会互相打断——硬停，先分流到独立端口/会话再重跑。
  CDP_PORT_CONTENDED = "CDP_PORT_CONTENDED",
  // ≥2 个活跃会话共用同一 CDP 端口，但还没抓到实际抢写现场。风险提示，非硬停：
  // 可以继续，但建议尽早用 --session 隔离或克隆副本，免得升级成真正的争用。
  CDP_SESSION_SHARED = "CDP_SESSION_SHARED",
  // 想要的 CDP 端口已被别的 Chrome 实例/会话占用，连上去会连到别人的浏览器。
  // 硬停：先让用户确认是否切换登录态/Profile，再改用系统建议的空闲端口。
  CDP_PORT_UNAVAILABLE = "CDP_PORT_UNAVAILABLE",
  // 本会话对 agent-browser 共享 daemon（未命名 default）的控制被后来的会话顶替。
  // 保留契约：当前由归属推测（session-context）在人话说明里表达，尚未从此纯函数产出，
  // 但码是稳定的，日后接线时直接复用，不新造码。
  AGENT_SESSION_DISPLACED = "AGENT_SESSION_DISPLACED",
  // 用户通过 ProfilePilot/overlay 主动接管，或 Agent 完成后正在收敛释放 Session。
  // 对 Agent 来说这是语义硬停，不是网络断开或可重试错误；接管时必须等用户明确交还，
  // 完成时则等待释放结束，不得重新连接旧 Session。
  AGENT_USER_IN_CONTROL = "AGENT_USER_IN_CONTROL",
  // 用户完成手动操作后显式把同一 Profile 交还给原 Agent。不是 hard-stop：Agent 下一条
  // 浏览器命令可以继续，同时收到这条恢复通知。
  AGENT_CONTROL_RETURNED = "AGENT_CONTROL_RETURNED",
  // 用户主动终止了 AI 浏览器控制任务。语义上接近 ego 的 INACTIVE：不是让 Agent 等待自动恢复，
  // 而是这轮浏览器操作已结束，除非用户重新发起。
  AGENT_TASK_STOPPED = "AGENT_TASK_STOPPED"
}

// 硬停码集合（对标 ego 的 isEgoHardStopCode）：这些码代表「必须停手、按 action 处理」。
const HARD_STOP_CODES = new Set<string>([
  ProfilePilotSignal.CDP_PORT_CONTENDED,
  ProfilePilotSignal.CDP_PORT_UNAVAILABLE,
  ProfilePilotSignal.AGENT_SESSION_DISPLACED,
  ProfilePilotSignal.AGENT_USER_IN_CONTROL,
  ProfilePilotSignal.AGENT_TASK_STOPPED
]);

export function isHardStopSignal(code: string): boolean {
  return HARD_STOP_CODES.has(code);
}

// 稳定码目录（契约的自描述清单）：每个码的固定语义 + 默认引导模板。
// message/action 里带端口的部分由 resolveSignal 用实际状态填好；这里给出无上下文兜底文案，
// 方便日后新增码时一处登记、也便于测试对齐。
export const SIGNAL_CATALOG: Record<ProfilePilotSignal, Omit<ProfilePilotSignalInfo, "code">> = {
  [ProfilePilotSignal.CDP_PORT_CONTENDED]: {
    message: "多个会话正在抢同一个标签页",
    action: "停手：该端口正被多会话争用，不要继续重试或自动切换 Profile；先告知用户，并征得同意后改用独立 Profile 的逻辑端口",
    hardStop: true
  },
  [ProfilePilotSignal.CDP_SESSION_SHARED]: {
    message: "多个活跃会话共用同一 CDP 端口，可能互抢标签页",
    action: "给你的会话加 --session <名> 独占 daemon，或克隆一个副本走独立端口，避免和别的会话抢同一个标签页",
    hardStop: false
  },
  [ProfilePilotSignal.CDP_PORT_UNAVAILABLE]: {
    message: "想要的 CDP 端口已被别的实例占用",
    action: "停手：不要自动切换 Profile；先告知用户端口已被占用，并征得同意后再运行 agent-browser --cdp <建议端口> <cmd>",
    hardStop: true
  },
  [ProfilePilotSignal.AGENT_SESSION_DISPLACED]: {
    message: "本会话对共享 daemon 的控制已被后来的会话顶替",
    action: "停手：改用 --session <你的会话名> 独占一个 daemon 再重跑，别继续用共享 default daemon",
    hardStop: true
  },
  [ProfilePilotSignal.AGENT_USER_IN_CONTROL]: {
    message: "用户已接管这个 Profile，AI 浏览器命令已暂停",
    action: "停手：这是用户主动接管，不要重试或自动重连；运行 agent-browser profilepilot wait-control 等待用户交还，返回后先重新读取页面状态再继续",
    hardStop: true
  },
  [ProfilePilotSignal.AGENT_CONTROL_RETURNED]: {
    message: "用户已将这个 Profile 的浏览器控制权交还 Agent",
    action: "控制权已恢复：可以继续之前的浏览器任务；先重新读取页面状态，再从用户接管后的页面继续",
    hardStop: false
  },
  [ProfilePilotSignal.AGENT_TASK_STOPPED]: {
    message: "用户已终止这个 Profile 的 AI 浏览器任务",
    action: "停手：这是用户主动终止任务，不要重试或自动重连；只有在用户重新发起浏览器操作时才继续",
    hardStop: true
  }
};

// resolveSignal 的输入：把「当前争用/端口状态」这类观测，映射成一个稳定信号。
// 用可辨识联合，让同一个纯函数覆盖不同来源的场景，调用方按 kind 传入即可。
export type SignalInput =
  | {
      kind: "cdp-contention";
      // 与 CdpContentionInfo.level 同义：contention=抢写，risk=共用有风险，null=正常。
      level: "contention" | "risk" | null;
      // 落在活跃窗口内的驱动连接数（用于 risk 文案）。
      activeClientCount: number;
      // 该 Profile 的 CDP 端口（拼进 action 指明「哪个端口」）。
      port: number | null;
      // contention 时被抢标签页在窗口内的 URL 改写次数（拼进 message 加强现场感）。
      churnChanges?: number;
      // 「一 tab 一 owner」打戳里驱动过被抢标签页的 owner 会话（复用 ① 的 owners 精确归属）：
      // ≥2 个即点名争抢方，拼进 CONTENDED 的 message，让 agent 知道是在和谁抢。
      churnOwners?: string[];
    }
  | {
      kind: "cdp-port";
      // 想要的端口是否可用；true 时不产信号。
      available: boolean;
      preferredPort: number;
      // 系统挑出的空闲替代端口（拼进 action，照抄即可分流）。
      suggestedPort: number;
      // 占用者的人话描述（如有），拼进 message。
      owner?: string | null;
    };

// 纯函数：把当前争用/端口状态映射成一个稳定信号；无可报告场景时返回 null。
// 保持自包含、无副作用，便于单测与后续接线复用。
export function resolveSignal(input: SignalInput): ProfilePilotSignalInfo | null {
  if (input.kind === "cdp-contention") {
    const portTag = input.port ? `:${input.port}` : "";
    if (input.level === "contention") {
      const changes = input.churnChanges ? `（90 秒内被改写 ${input.churnChanges} 次）` : "";
      // 复用 ① 的 owners 打戳：能点名 ≥2 个争抢方时把它们拼进 message，让 agent 知道在和谁抢。
      const owners = input.churnOwners && input.churnOwners.length >= 2 ? `（争抢方：${input.churnOwners.join("、")}）` : "";
      return {
        code: ProfilePilotSignal.CDP_PORT_CONTENDED,
        message: `多个会话正在抢同一个标签页${changes}${owners}`,
        action: `停手：端口${portTag} 正被多会话争用，不要继续重试或自动切换 Profile；先告知用户，并征得同意后改用独立 Profile 的逻辑端口`,
        hardStop: true
      };
    }
    if (input.level === "risk") {
      return {
        code: ProfilePilotSignal.CDP_SESSION_SHARED,
        message: `${input.activeClientCount} 个活跃会话共用端口${portTag}，可能互抢标签页`,
        action: SIGNAL_CATALOG[ProfilePilotSignal.CDP_SESSION_SHARED].action,
        hardStop: false
      };
    }
    return null;
  }

  // kind === "cdp-port"
  if (input.available) {
    return null;
  }
  const owner = input.owner ? `（占用者：${input.owner}）` : "";
  return {
    code: ProfilePilotSignal.CDP_PORT_UNAVAILABLE,
    message: `端口 ${input.preferredPort} 已被占用${owner}`,
    action: `停手：不要自动切换 Profile；先告知用户端口 ${input.preferredPort} 已被占用，并征得同意后再运行 agent-browser --cdp ${input.suggestedPort} <cmd>`,
    hardStop: true
  };
}

// 硬停信号塌缩成一行引导（对标 ego：hard-stop 丢弃缓冲、只留一句 owned guidance）。
// 面板/overlay 在 hardStop 时优先突出这一行；非硬停返回 null，交由常规现象展示。
export function collapseHardStopGuidance(info: ProfilePilotSignalInfo | null): string | null {
  if (!info || !info.hardStop) {
    return null;
  }
  return `[${info.code}] ${info.action}`;
}
