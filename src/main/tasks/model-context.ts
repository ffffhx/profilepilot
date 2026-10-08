import type { BrowserTask } from "../../shared/tasks";
import { conversationEvents } from "./conversation";
import { latestUserRequest } from "./turn-request";

/** Rebuilding an SDK session must include the entire uncompacted conversation.
 * Only explicit compaction may replace older instructions with a summary. */
export function taskModelContext(task: BrowserTask, terminal?: object): object {
  return { goal: task.prompt, currentRequest: latestUserRequest(task), authorization: task.authorization, executionGrant: task.grant, profile: task.profileName,
    materials: task.materials, attachments: task.attachments, outputs: task.outputs, terminal,
    items: task.items, plan: task.plan, recentHistory: conversationEvents(task), conversationSummary: task.context?.summary,
    permissionMode: task.mode || "acceptEdits", nativeAccess: task.nativeAccess,
    receipts: task.receipts.filter((receipt, index) => index >= task.receipts.length - 20 || (receipt.status === "uncertain" && !["completed", "not_completed"].includes(receipt.reconciliation?.outcome || ""))), needsReconciliation: task.needsReconciliation,
    resumeContext: task.resumeContext,
    instruction: "需要浏览器操作时先重新观察；纯问答直接回复并用 responseOnly 完成，不要制造工具证据。资料以本消息提供的版本为准。" };
}
