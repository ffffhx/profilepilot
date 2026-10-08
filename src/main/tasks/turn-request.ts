import type { BrowserTask } from "../../shared/tasks";

/** Product confirmation receipts are not a new user goal. */
export function latestUserRequest(task: Pick<BrowserTask, "events" | "prompt">): string {
  return [...task.events].reverse().find(event => event.kind === "user" &&
    !/^(?:确认执行|拒绝执行|不执行此操作|确认交还|交还浏览器|已完成手动操作|继续当前任务(?:。先核查当前页面与已有执行记录，保留已完成项目，不要重复提交或重做已完成操作。)?)$/.test(event.text.trim()))?.text || task.prompt;
}

/** This only chooses the full model over the eager browser driver. It does not
 * authorize tools or change confirmation/ownership rules. False positives are
 * safe: the model still has to decide which authorized tools it needs. */
export function deferBrowserDriver(request: string): boolean {
  if (/[?？]/.test(request) || /^(?:为什么|怎么|如何|请解释|解释|说明|what\b|why\b|how\b)/i.test(request.trim())) return true;
  if (/(?:不要|无需|禁止|不再|不必|别)(?:再)?(?:操作|打开|访问|使用|读取|调用)?(?:任何|我的|当前|这个|该|已有|外部)?\s*(?:浏览器|网页|页面|网站|外部工具)|\b(?:do not|don't|must not|never)\s+(?:browse|navigate|visit)(?:\b|$)|\b(?:do not|don't|without)\s+(?:use|using|open|opening|read|reading|access|accessing)\s+(?:(?:any|the|my|a)\s+)?(?:browser|web(?:sites|pages)?|external tools)\b/i.test(request)) return true;
  return /(?:纯(?:回答|问答|对话)|只(?:需|要)?(?:回答|回复|解释|总结|比较|对比|改写)|(?:不要|无需|禁止|不再|不必|别)(?:再)?(?:操作|打开|访问|使用|读取|调用)?(?:浏览器|网页|页面|外部工具)|(?:仅|只)(?:依据|根据|基于).{0,40}(?:已有|已获得|前[两三几]|上[一两三]|刚才|上下文))|\b(?:answer|reply|explain|summarize|compare|rewrite)\s+only\b|\b(?:do not|don't|without|no need to)\s+(?:use|using|open|opening|access|accessing|operate|operating|browse|browsing|visit|visiting|read|reading)?\s*(?:the\s+)?(?:browser|web(?:sites|pages)?|external tools)\b/i.test(request);
}

export function hasBrowserRequest(request: string): boolean {
  // Ambiguous requests go to the conversational model, which can still ask for
  // authorized browser tools. Never browse just because an earlier turn did.
  return /浏览(?!器)|打开.{0,40}(?:页面|网页|网站|链接|标签|https?:|小红书|\bX\b)|(?:搜索|检索|查找|查看|看看|提取|阅读).{0,50}(?:网页|页面|网站|新闻|热点|笔记|帖子|小红书|\bX\b)|(?:点击|滚动|填写|填入|勾选)|\b(?:browse|navigate|click|scroll|fill)\b|\b(?:open|visit|search|read|extract)\b.{0,60}(?:https?:|\b(?:website|webpage|page|browser|news|posts|articles)\b)/i.test(request);
}
