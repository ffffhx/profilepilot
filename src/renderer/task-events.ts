import type { TaskEvent } from "../shared/tasks";
import { renderTaskText } from "./task-links";

const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const date = (value: string): string => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function errorCopy(text: string): { title: string; help?: string } {
  const code = /"error_code"\s*:\s*"([A-Z_]+)"/.exec(text)?.[1];
  if (code === "GATEWAY_PROFILE_NOT_FOUND") {
    if (text.startsWith("退出时交还浏览器失败")) return {
      title: "应用退出时，未找到这条任务的浏览器连接。",
      help: "这是退出时的连接记录。继续任务前，请检查所选浏览器是否可用。"
    };
    return { title: "未找到任务使用的浏览器连接。", help: "请检查所选浏览器是否可用，再继续任务。" };
  }
  if (code === "GATEWAY_PROFILE_NOT_CONFIGURED") return { title: "任务使用的浏览器尚未配置。", help: "请在浏览器管理中检查配置。" };
  if (code === "PROFILE_LEASE_CONFLICT") return { title: "这个浏览器正由另一个任务使用。", help: "请等待那个任务结束后再继续。" };
  if (code === "AGENT_USER_IN_CONTROL") return { title: "浏览器目前由你接管。", help: "处理完成后，可以回到当前任务继续。" };
  const plain = text.replace(/^Error:\s*/, "").trim();
  // Keep already useful product messages; never put a stack trace or serialized
  // transport response into the main conversation as the explanation.
  if (!code && plain.length <= 160 && !/[\n{}]|\b(?:Error|Exception|error_code|hard_stop)\b/.test(plain) && /[\u4e00-\u9fff]/.test(plain)) return { title: plain };
  return { title: "这一步未能完成。", help: "展开技术详情可查看具体原因。" };
}

export function renderTaskEvents(events: TaskEvent[]): string {
  const groups: TaskEvent[][] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    // Only merge uninterrupted repetitions. A new action/message starts a new
    // occurrence, so an old error is never presented as the current task state.
    if (event.kind === "error" && previous?.[0].kind === "error" && previous[0].text.trim() === event.text.trim()) previous.push(event);
    else groups.push([event]);
  }
  return groups.map(group => {
    const first = group[0], last = group.at(-1)!;
    if (first.kind !== "error") return `<div class="event ${first.kind}"><span>${renderTaskText(first.text)}</span><time>${date(first.at)}</time></div>`;
    const copy = errorCopy(first.text);
    return `<div class="event error task-error"><p class="task-error-title">${escape(copy.title)}</p>${copy.help ? `<p class="task-error-help">${escape(copy.help)}</p>` : ""}
      <div class="task-error-meta">${group.length > 1 ? `<span>同一问题 ${group.length} 次，已合并</span>` : ""}<time datetime="${escape(last.at)}">${group.length > 1 ? "最近 " : ""}${date(last.at)}</time></div>
      <details class="task-error-details" id="task-error-${escape(first.id)}"><summary>技术详情</summary>${group.length > 1 ? `<p>首次 ${date(first.at)} · 最近 ${date(last.at)} · 共 ${group.length} 次</p>` : ""}<pre>${escape(first.text)}</pre></details>
    </div>`;
  }).join("");
}
