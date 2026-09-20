import { randomUUID, createHash } from "node:crypto";
import type { BrowserAction, BrowserCandidate, BrowserObservation, BrowserTask } from "../../shared/tasks";
import { requestBrowserGateway, readOrCreateBrowserGatewayDaemonIdentity } from "../browser-gateway-client";

// Design reference: browser-use/jev-ultrafast (MIT). Independently implemented
// for ProfilePilot's existing Gateway ownership and task approval boundaries.
// This function is serialized and runs in the selected page, without model code.
function pageSnapshot() {
  const w = window as any;
  const key = "__profilepilot_jev_dom_v1";
  const cache = w[key] ||= { document: crypto.randomUUID(), ids: new WeakMap(), nodes: new Map(), next: 1 };
  const clean = (s: unknown, n = 240): string => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const candidates: BrowserCandidate[] = [];
  const contexts: string[] = [];
  const values: string[] = [];
  for (const [id, node] of cache.nodes) if (!node.isConnected) cache.nodes.delete(id);
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect(); const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0" && !el.closest('[inert],[aria-hidden="true"],[data-profilepilot-overlay]');
  };
  for (const node of Array.from(document.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="textbox"]'))) {
    if (candidates.length >= 180) break;
    if (!visible(node) || (node as HTMLInputElement).disabled || node.getAttribute("aria-disabled") === "true") continue;
    const type = (node as HTMLInputElement).type;
    if (["hidden", "password", "file"].includes(type) || node.isContentEditable) continue;
    let ref = cache.ids.get(node);
    if (!ref) { ref = `e${cache.next++}`; cache.ids.set(node, ref); cache.nodes.set(ref, node); }
    cache.nodes.set(ref, node);
    const labelIds = node.getAttribute("aria-labelledby")?.split(/\s+/) || [];
    const labels = Array.from((node as HTMLInputElement).labels || []).map(l => l.textContent).join(" ");
    const label = clean(node.getAttribute("aria-label") || labelIds.map(id => document.getElementById(id)?.textContent).join(" ") || labels || node.getAttribute("placeholder") || node.innerText || node.getAttribute("title") || node.getAttribute("name") || node.getAttribute("alt"));
    const tag = node.tagName;
    const kind = tag === "SELECT" ? "select" : tag === "TEXTAREA" || (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "image", "range", "color"].includes(type)) ? "fill" : "click";
    if (kind === "fill" && (node as HTMLInputElement).readOnly) continue;
    const role = node.getAttribute("role") || (tag === "A" ? "link" : kind === "fill" ? "textbox" : kind === "select" ? "combobox" : ["checkbox", "radio"].includes(type) ? type : "button");
    const candidate: BrowserCandidate = { ref, role, label, kind };
    if (tag === "A") candidate.href = (node as HTMLAnchorElement).href.split(/[?#]/)[0].slice(0, 1000);
    if (kind !== "click") candidate.value = String((node as HTMLInputElement).value || "").slice(0, 20000);
    if (["checkbox", "radio"].includes(role)) candidate.checked = tag === "INPUT" ? (node as HTMLInputElement).checked : node.getAttribute("aria-checked") === "true";
    if (tag === "SELECT") candidate.options = Array.from((node as HTMLSelectElement).options).filter(o => !o.disabled).slice(0, 80).map(o => ({ value: o.value, label: clean(o.label) }));
    if ((tag === "BUTTON" || tag === "INPUT") && type === "submit" && (node as HTMLButtonElement).form) candidate.submit = true;
    candidates.push(candidate);
    const form = (node as HTMLInputElement).form;
    values.push(JSON.stringify([kind !== "click" ? String((node as HTMLInputElement).value || "") : "", node.getAttribute("href"), node.getAttribute("type"), node.getAttribute("formaction"), node.getAttribute("target"), form?.action, form?.method, form?.target]));
    contexts.push(clean(node.closest("label,fieldset,tr,section,article")?.textContent || node.parentElement?.textContent, 350));
  }
  // Controls and nearby form context define action validity. Unrelated animated
  // page text does not invalidate a click; values and node identities do.
  const guard = JSON.stringify([location.href, cache.document, candidates, contexts, values]);
  const text = (document.body?.innerText || "").slice(0, 10000);
  return { document: cache.document, guard, candidates, url: location.href, title: document.title, text };
}

function prepareAction(expected: { document: string; guard: string }, action: BrowserAction, snapshot: typeof pageSnapshot) {
  const current = snapshot();
  if (current.document !== expected.document || current.guard !== expected.guard) throw new Error("页面内容已经变化，动作未执行，请重新观察。");
  const cache = (window as any).__profilepilot_jev_dom_v1;
  const ref = action.ref?.replace(/^@/, "");
  const candidate = current.candidates.find(c => c.ref === ref);
  const node = (ref ? cache.nodes.get(ref) : undefined) as HTMLElement | undefined;
  if (action.kind === "scroll") { window.scrollBy({ top: action.value === "up" ? -600 : 600, behavior: "instant" }); return { done: true }; }
  if (!node?.isConnected || !candidate) throw new Error("目标元素已失效，动作未执行。");
  if ((action.kind === "fill" && candidate.kind !== "fill") || (action.kind === "select" && candidate.kind !== "select") || (action.kind === "click" && candidate.kind !== "click")) throw new Error("目标类型不匹配。");
  node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const r = node.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(node === hit || node.contains(hit))) throw new Error("目标被其他元素遮挡，动作未执行。");
  if (action.kind === "click") return { x, y };
  const value = action.value || "";
  if (action.kind === "select" && !candidate.options?.some(o => o.value === value)) throw new Error("下拉选项不存在。");
  node.focus();
  const prototype = node.tagName === "SELECT" ? HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
  return { done: true };
}

export class FastBrowser {
  private readonly ready = new Set<string>();
  constructor(private readonly acquire: (task: BrowserTask) => Promise<unknown>) {}
  async raw(task: BrowserTask, method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!task.port) throw new Error("任务没有绑定浏览器端口。");
    if (!this.ready.has(task.sessionId)) { await this.acquire(task); this.ready.add(task.sessionId); }
    const homeDir = process.env.PROFILEPILOT_GATEWAY_HOME;
    const response = await requestBrowserGateway({ action: "raw-cdp", publicPort: task.port, sessionId: task.sessionId,
      daemonInstanceId: readOrCreateBrowserGatewayDaemonIdentity(task.sessionId, homeDir), method, params, timeoutMs: 15000 }, { homeDir, timeoutMs: 18000 });
    return response.result;
  }
  private async evaluate(task: BrowserTask, expression: string): Promise<any> {
    const response = await this.raw(task, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error("页面变化或控件不支持，动作无法执行；请重新观察或交由主模型处理。");
    return response.result?.value;
  }
  async observe(task: BrowserTask): Promise<BrowserObservation> {
    const page = await this.evaluate(task, `(${pageSnapshot.toString()})()`);
    if (!page || typeof page.guard !== "string" || !Array.isArray(page.candidates)) throw new Error("无法读取页面。");
    const lines = page.candidates.map((c: BrowserCandidate) => `- ${c.role} ${JSON.stringify(c.label)} [ref=${c.ref}] ${c.value !== undefined ? `value=${JSON.stringify(c.value)}` : ""}${c.checked !== undefined ? ` checked=${c.checked}` : ""}${c.submit ? " (submit button)" : ""}`);
    return { version: randomUUID(), at: new Date().toISOString(), url: page.url, title: page.title,
      fingerprint: createHash("sha256").update(page.guard).digest("hex"), snapshot: page.text + "\n\nControls:\n" + lines.join("\n"), account: "账号未确认",
      fast: { document: page.document, guard: page.guard, candidates: page.candidates } };
  }
  async execute(task: BrowserTask, action: BrowserAction): Promise<string> {
    const expected = task.observation?.fast;
    if (!expected) throw new Error("缺少有效页面观察。");
    if (action.kind === "click" && process.platform === "win32") {
      // Background Chrome on Windows needs a compositor frame for native input.
      await this.raw(task, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    }
    const result = await this.evaluate(task, `(${prepareAction.toString()})(${JSON.stringify({ document: expected.document, guard: expected.guard })},${JSON.stringify(action)},${pageSnapshot.toString()})`);
    if (!result) throw new Error("无法验证操作结果。");
    if (action.kind === "click") {
      if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) throw new Error("无效的目标位置。");
      await this.raw(task, "Input.dispatchMouseEvent", { type: "mousePressed", x: result.x, y: result.y, button: "left", clickCount: 1 });
      await this.raw(task, "Input.dispatchMouseEvent", { type: "mouseReleased", x: result.x, y: result.y, button: "left", clickCount: 1 });
    }
    return "操作已执行；需要重新观察确认结果。";
  }
  forget(task: BrowserTask): void { this.ready.delete(task.sessionId); }
}
