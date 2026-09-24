import { taskIcon as icon } from "./task-icons";

export function taskComposer(): string {
  return `<form id="steer-task" aria-label="发送消息"><label for="steering" class="sr-only">发送消息</label><textarea name="steering" id="steering" placeholder="继续聊聊，或告诉 Agent 下一步做什么…" aria-describedby="steering-help"></textarea><div class="actions"><small id="steering-help">Enter 发送 · Ctrl+Enter 换行</small><button class="primary send-task" type="submit" title="发送（Enter）" aria-label="发送" disabled>${icon("arrow")}</button></div></form>`;
}
