import type { BrowserTask } from "../../shared/tasks";
import { conversationEvents } from "./conversation";
import { latestUserRequest } from "./turn-request";
import type { SdkPromptState } from "./sdk-history";

/** Rebuilding an SDK session must include the entire uncompacted conversation.
 * Only explicit compaction may replace older instructions with a summary. */
export function taskModelContext(task: BrowserTask, terminal?: object, previous?: SdkPromptState): object {
  const state = { goal: task.prompt, authorization: task.authorization, executionGrant: task.grant, profile: task.profileName, profileId: task.profileId,
    materials: task.materials, attachments: task.attachments, outputs: task.outputs, terminal,
    selectedSkill: task.skill ? { ...task.skill, adapter: "这是用户选择的业务 Skill 快照，用户当前要求优先。SKILL.md 中相对路径基于 root。必要的 references 和 scripts 可通过 Read 读取；用现有浏览器工具进行网页操作，用 terminal_run 执行脚本（Python 先检查环境），输出写到 terminal.workspace。完成后用 register_outputs 登记该工作目录中的 HTML、PNG、CSV 等文件。Skill 不扩大已有操作授权。" } : undefined,
    items: task.items, plan: task.plan,
    permissionMode: task.mode || "acceptEdits", nativeAccess: task.nativeAccess,
    receipts: task.receipts.filter((receipt, index) => index >= task.receipts.length - 20 || (receipt.status === "uncertain" && !["completed", "not_completed"].includes(receipt.reconciliation?.outcome || ""))), needsReconciliation: task.needsReconciliation,
    resumeContext: task.resumeContext };
  const index = previous?.throughEventId ? task.events.findIndex(event => event.id === previous.throughEventId) : -1;
  const resume = Boolean(task.sdkSessionId && previous && index >= 0);
  // A restored SDK session already owns previous messages and tool results.
  // Send changed product state and undelivered inputs; only rebuilds receive
  // history. Explicit null clears a value previously sent to the SDK.
  const changes = resume ? Object.fromEntries(Object.entries(state).filter(([key, value]) =>
    JSON.stringify(value ?? null) !== JSON.stringify(previous!.state[key] ?? null)).map(([key, value]) => [key, value ?? null])) : state;
  return { _profilepilot: { version: 1, taskId: task.id, mode: resume ? "resume" : "rebuild", throughEventId: task.events.at(-1)?.id },
    ...changes, currentRequest: latestUserRequest(task),
    ...(resume ? { inputEvents: task.events.slice(index + 1).filter(event => ["user", "system", "error"].includes(event.kind)) }
      : { recentHistory: conversationEvents(task), conversationSummary: task.context?.summary }),
    instruction: "需要浏览器操作时先重新观察；纯问答直接回复并用 responseOnly 完成，不要制造工具证据。资料以最新提供的版本为准；未重新提供的字段沿用本会话已有值，null 表示清除。" };
}
