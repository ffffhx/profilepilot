import { DEVICE_ONLY_PROFILE_ID, type BrowserTask } from "../../shared/tasks";
import { conversationEvents } from "./conversation";
import { latestUserRequest } from "./turn-request";
import type { SdkPromptState } from "./sdk-history";

export const MAX_RETAINED_SCREENSHOT_OBSERVATIONS = 3;
export const PRUNED_SCREENSHOT_NOTE = "[历史观察截图已省略，仅保留最近观察截图；文字快照仍保留]";

const DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{128,}/g;
const JSON_SCREENSHOT_RE = /"screenshotDataUrl"\s*:\s*"data:image\/[^"]+"/g;

function hasInlineScreenshot(value: unknown): boolean {
  if (typeof value === "string") {
    return /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{128,}/.test(value);
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasInlineScreenshot);
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string" && record.data.length >= 64) return true;
  if (record.type === "image" && typeof (record.source as any)?.data === "string" && (record.source as any).data.length >= 64) return true;
  if (typeof record.screenshotDataUrl === "string" && record.screenshotDataUrl.startsWith("data:image/")) return true;
  if (Array.isArray(record.content) && record.content.some(hasInlineScreenshot)) return true;
  if (typeof record.text === "string" && hasInlineScreenshot(record.text)) return true;
  return false;
}

function stripInlineScreenshot<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(JSON_SCREENSHOT_RE, `"screenshotNote":"${PRUNED_SCREENSHOT_NOTE}"`)
      .replace(DATA_IMAGE_RE, PRUNED_SCREENSHOT_NOTE) as unknown as T;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripInlineScreenshot) as unknown as T;
  const record = value as Record<string, unknown>;
  if (record.type === "image" && (typeof record.data === "string" || typeof (record.source as any)?.data === "string")) {
    return { type: "text", text: PRUNED_SCREENSHOT_NOTE } as unknown as T;
  }
  const clone: Record<string, unknown> = { ...record };
  if (typeof clone.screenshotDataUrl === "string" && clone.screenshotDataUrl.startsWith("data:image/")) {
    delete clone.screenshotDataUrl;
    clone.screenshotNote = PRUNED_SCREENSHOT_NOTE;
  }
  if (Array.isArray(clone.content)) {
    clone.content = clone.content.map(stripInlineScreenshot);
  }
  if (typeof clone.text === "string" && hasInlineScreenshot(clone.text)) {
    clone.text = stripInlineScreenshot(clone.text);
  }
  return clone as T;
}

/** Retain Base64 screenshot payloads only for the most recent `keepRecent`
 * observations/events; summarize older ones so consecutive observe(screenshot:true)
 * steps never blow up context tokens or memory. Items without screenshots are
 * returned by reference so SDK transcript digests remain exact. */
export function pruneContextScreenshots<T>(items: readonly T[], keepRecent = MAX_RETAINED_SCREENSHOT_OBSERVATIONS): T[] {
  const limit = Math.max(0, Math.floor(keepRecent));
  const result = items.slice();
  let retained = 0;
  for (let i = result.length - 1; i >= 0; i--) {
    if (!hasInlineScreenshot(result[i])) continue;
    if (retained < limit) {
      retained++;
      continue;
    }
    result[i] = stripInlineScreenshot(result[i]);
  }
  return result;
}

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
  const instruction = task.profileId === DEVICE_ONLY_PROFILE_ID
    ? "当前任务不绑定浏览器：请优先使用手机（phone_control）、桌面窗口（desktop_control）、本机应用（electron_control）、文件工具或终端完成操作；纯问答直接回复并用 responseOnly 完成。资料以最新提供的版本为准；未重新提供的字段沿用本会话已有值，null 表示清除。"
    : "需要浏览器操作时先重新观察；纯问答直接回复并用 responseOnly 完成，不要制造工具证据。资料以最新提供的版本为准；未重新提供的字段沿用本会话已有值，null 表示清除。";
  return { _profilepilot: { version: 1, taskId: task.id, mode: resume ? "resume" : "rebuild", throughEventId: task.events.at(-1)?.id },
    ...changes, currentRequest: latestUserRequest(task),
    ...(resume ? { inputEvents: pruneContextScreenshots(task.events.slice(index + 1).filter(event => ["user", "system", "error"].includes(event.kind))) }
      : { recentHistory: pruneContextScreenshots(conversationEvents(task)), conversationSummary: task.context?.summary }),
    instruction };
}
