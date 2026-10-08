import { randomUUID, createHash } from "node:crypto";
import type { BrowserAction, BrowserCandidate, BrowserObservation, BrowserTask, Effect } from "../../shared/tasks";
import { requestBrowserGateway, readOrCreateBrowserGatewayDaemonIdentity } from "../browser-gateway-client";

export function pageViewport() {
  const el = document.documentElement;
  return { width: window.innerWidth || 0, height: window.innerHeight || 0, x: window.scrollX || 0, y: window.scrollY || 0,
    scrollWidth: el?.scrollWidth || 0, scrollHeight: el?.scrollHeight || 0 };
}

// Design reference: browser-use/jev-ultrafast (MIT). Independently implemented
// for ProfilePilot's existing Gateway ownership and task approval boundaries.
// This function is serialized and runs in the selected page, without model code.
export interface PageReadOptions {
  cursor?: string; query?: string; limit?: number; textLimit?: number; frameId?: string;
}
export interface PageSlice {
  offset?: number; textOffset?: number; query?: string; limit?: number; textLimit?: number;
  document?: string; revision?: string; refs?: string[];
}
export interface DomCandidate extends BrowserCandidate {
  dom?: { tag: string; type: string; search: boolean; popup: boolean; toggle: boolean; command: string; download: boolean; effect?: Effect; enterEffect?: Effect };
}
/** Classify observed controls, never model descriptions. Serialized into the page reader. */
export function domControlEffect(candidate: DomCandidate): Effect | undefined {
  const dom = candidate.dom, label = String(candidate.label || "").trim();
  if (candidate.kind === "fill") return dom?.search ? "read" : "edit";
  if (candidate.kind === "select") return "edit";
  const recordLink = ["link", "menuitem"].includes(candidate.role) && /^(?:查看|浏览|打开|核对)?(?:提交|申请|投递|发送|发布|订单|支付|购买)(?:记录|历史|状态|详情|列表)$|^(?:(?:view|show|open|check)\s+)?(?:application|submission|order|payment|purchase|sent message)s?\s+(?:history|records|status|details|list)$/i.test(label);
  if (recordLink && !candidate.submit && !dom?.toggle && !dom?.command && !dom?.download) return "read";
  // Article titles can contain action words. Only an imperative link label or
  // explicit action/toggle semantics makes an HTTP anchor a write control.
  const imperativeLink = /^(?:(?:立即|确认|确定|马上|取消|撤销)\s*)?(?:支付|付款|购买|下单|删除|移除|发送|提交|发布|投递|保存|点赞|收藏|关注|转发)(?:$|订单|申请|评论|笔记|帖子|文章|更改|记录|账号|此|这)|^(?:pay|purchase|checkout|delete|remove|send|submit|publish|save|like|unlike|bookmark|unbookmark|follow|unfollow|repost|retweet)(?:\s|$)/i.test(label);
  const command = dom?.command || "";
  const actionLabel = candidate.role !== "link" || (imperativeLink && !recordLink) || Boolean(command) || dom?.toggle ? `${label} ${command}` : "";
  if (/支付|付款|购买|下单|提交订单|确认订单|\bpay\b|\bbuy\b|purchase|checkout|place\s+order|confirm\s+order/i.test(actionLabel)) return "purchase";
  if (/删除|移除|\bdelete\b|\bremove\b/i.test(actionLabel)) return "delete";
  if (/发送|\bsend\b/i.test(actionLabel)) return "send";
  if (/提交|发布|投递|保存|点赞|喜欢|取消赞|已赞|收藏|关注|转发|\bsubmit\b|publish|apply\s+changes|\bsave\b|\blike\b|\bunlike\b|collect|bookmark|\bfollow\b|unfollow|repost|retweet/i.test(actionLabel) || /^(post|put|patch)$/i.test(command)) return "submit";
  if (dom?.search) return "read";
  if (candidate.submit) return "submit";
  if (dom?.toggle || /^(?:checkbox|radio|switch|option)$/.test(candidate.role)) return "edit";
  if (candidate.role === "link" && /^https?:\/\//i.test(candidate.href || "") && !dom?.download && !command && (!dom || dom.tag === "A")) return "read";
  if (dom?.popup || candidate.role === "tab" || /^(筛选|排序|搜索|查找|关闭|返回|展开|收起|更多|filter|sort|search|close|back|next page|previous page)$/i.test(label)) return "read";
  return undefined;
}
export interface PagedObservation extends BrowserObservation {
  page?: { frameId?: string; nextCursor?: string; totalControls: number; totalText: number; offset: number; textOffset: number; query?: string };
}
export function pageSnapshot(documentId: string, native = false, slice: PageSlice = {}, classify = domControlEffect) {
  const w = window as any;
  const key = "__profilepilot_jev_dom_v1";
  // Generate IDs in the app: fresh blank pages and HTTP origins may not expose crypto.randomUUID.
  const cache = w[key] ||= { document: documentId, ids: new WeakMap(), nodes: new Map(), next: 1 };
  cache.contextIds ||= new WeakMap(); cache.nextContext ||= 1;
  const contextIdentity = (node: Element): string => {
    let id = cache.contextIds.get(node);
    if (!id) { id = `c${cache.nextContext++}`; cache.contextIds.set(node, id); }
    return id;
  };
  const clean = (s: unknown, n = 240): string => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const linkAddress = (address: string): string => {
    // Anchor.href is already resolved by the browser. Preserve its encoding,
    // routing/search parameters and anchors; redact only named credentials.
    const secret = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|password|passwd|secret|client[_-]?secret|authorization)$/i;
    return address.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/i, "$1")
      .replace(/([?&#])([^=&#]+)=([^&#]*)/g, (part, delimiter, name) => {
        let decoded = name;
        try { decoded = decodeURIComponent(name.replace(/\+/g, " ")); } catch { /* Keep malformed noncredential keys unchanged. */ }
        return secret.test(decoded) ? `${delimiter}${name}=[redacted]` : part;
      }).slice(0, 4000);
  };
  const candidates: DomCandidate[] = [];
  const contexts: string[] = [];
  const values: string[] = [];
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const endpointAction = (address: string): string => address.match(/(?:^|\/|[?&](?:action|op|do)=)(purchase|checkout|pay|buy|delete|send|submit|publish|like|bookmark|follow)(?=\/|[?#&]|$)/i)?.[1] || "";
  const searchName = (el: Element): boolean => /^(搜索|搜一搜|查找)|^(search|find)(?:\b|\s|$)/i.test(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
  const searchBindings = new Map<Element, { root: Element; trigger: HTMLElement }>();
  const searchTriggers = new Set<Element>();
  // The native selector includes fieldset inheritance (and the first-legend
  // exception), plus disabled optgroups. The element's own property does not.
  const disabled = (el: Element): boolean => Boolean((el as HTMLInputElement).disabled || el.matches?.(":disabled"));
  const editingHost = (el: HTMLElement): boolean => el.isContentEditable && !el.parentElement?.isContentEditable;
  const writes = /(?:^|[\s/#_-])(purchase|checkout|buy|submit|publish|delete|send|like|collect|bookmark|follow|post|put|patch|comment|reply|compose)(?:$|[\s/?#_-])|支付|购买|下单|提交|发布|删除|发送|点赞|收藏|关注/i;
  const writeControl = (el: Element): boolean => writes.test([
    el.getAttribute("data-action"), el.getAttribute("data-method"), el.getAttribute("formaction"), el.getAttribute("aria-label"), el.getAttribute("alt"),
    (el as HTMLElement).innerText, el.getAttribute("id"), el.getAttribute("name"), el.getAttribute("class"),
    el.tagName.toLowerCase() === "use" ? el.getAttribute("href") || el.getAttribute("xlink:href") : "",
  ].join(" ")) || ["data-action", "data-method"].some(name => Boolean(el.getAttribute(name) && !/^(search|find|get)$/i.test(el.getAttribute(name)!))) ||
    Boolean(el.getAttribute("formmethod") && el.getAttribute("formmethod")!.toLowerCase() !== "get") ||
    Boolean((el as HTMLInputElement).form && (String((el as HTMLInputElement).form!.method || "get").toLowerCase() !== "get" || writes.test((el as HTMLInputElement).form!.action || "")));
  const searchRegion = (el: HTMLElement): boolean | undefined => {
    // A changing hot-search placeholder is not a durable purpose. Require both
    // a search field identifier and an associated search trigger in a small,
    // single-field region; never infer this from the page URL or model summary.
    if (!/(?:^|[\s_-])search(?:$|[\s_-])/i.test(`${el.id || ""} ${el.getAttribute("class") || ""}`)) return;
    let root = el.parentElement;
    for (let depth = 0; root && depth < 3 && !["BODY", "HTML"].includes(root.tagName); depth++, root = root.parentElement) {
      if (writeControl(root)) return false;
      const fields = Array.from(root.querySelectorAll<HTMLElement>('input,textarea,select,[contenteditable]')).filter(field => field.isContentEditable ||
        ["TEXTAREA", "SELECT"].includes(field.tagName) || field.tagName === "INPUT" && !["hidden", "button", "submit", "reset", "image"].includes((field as HTMLInputElement).type));
      if (fields.length !== 1 || fields[0] !== el) return false;
      const controls = Array.from(root.querySelectorAll<HTMLElement>('button,[role="button"],input[type="submit"],input[type="image"],[onclick],[data-action],[data-method],[class*="search"],use'))
        .filter(control => control !== el && !control.contains(el));
      if (controls.some(writeControl)) return false;
      const triggers = controls.filter(control => {
        if (!["BUTTON", "INPUT", "DIV", "SPAN"].includes(control.tagName)) return false;
        const name = clean(control.getAttribute("aria-label") || control.innerText);
        const icon = control.querySelector("use");
        const image = control.querySelector('img[class*="search"]');
        const searchIcon = /(?:^|[\s_-])search[-_](?:icon|button|btn)(?:$|[\s_-])/i;
        const imageSearch = image && visible(image) && searchIcon.test(control.className || "") && searchIcon.test(image.getAttribute("class") || "");
        return /^(搜索|查找|search|find)$/i.test(name) || /#search$/i.test(icon?.getAttribute("href") || icon?.getAttribute("xlink:href") || "") || Boolean(imageSearch);
      });
      const trigger = triggers.find(control => !disabled(control) && control.getAttribute("aria-disabled") !== "true" && visible(control));
      if (trigger) {
        searchBindings.set(el, { root, trigger }); searchTriggers.add(trigger); return true;
      }
      if (triggers.length) return false;
    }
    return;
  };
  const searchField = (el: HTMLElement): boolean => {
    const type = String((el as HTMLInputElement).type || "text").toLowerCase();
    if (!(el.tagName === "TEXTAREA" || el.tagName === "INPUT" && ["text", "search"].includes(type)) || disabled(el) || (el as HTMLInputElement).readOnly || !visible(el) || writeControl(el)) return false;
    const form = (el as HTMLInputElement).form;
    if (form && String(form.method || "get").toLowerCase() !== "get") return false;
    const fields = Array.from(form?.elements || []) as HTMLInputElement[];
    if (form && writes.test(form.action || "")) return false;
    if (fields.some(field => ["submit", "image"].includes(field.type) && (field.getAttribute?.("formmethod") && field.getAttribute("formmethod")!.toLowerCase() !== "get" || writes.test(`${field.getAttribute?.("formaction") || ""} ${field.getAttribute?.("aria-label") || field.innerText || field.value || ""}`)))) return false;
    if (fields.some(field => field !== el && (field.tagName === "TEXTAREA" || field.isContentEditable || field.tagName === "INPUT" && !["hidden", "submit", "button", "reset"].includes(field.type) && !/^(?:q|query|search|keyword|keywords)$/i.test(field.name || "")))) return false;
    const region = searchRegion(el);
    if (region !== undefined) return region;
    return type === "search" || el.getAttribute("role") === "searchbox" || Boolean(el.closest('search,[role="search"]')) || el.tagName === "INPUT" && searchName(el);
  };
  for (const [id, node] of cache.nodes) if (!node.isConnected) cache.nodes.delete(id);
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect(); const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0" && !el.closest('[inert],[aria-hidden="true"],[data-profilepilot-overlay]');
  };
  // Walk each shadow tree explicitly. querySelectorAll/innerText on document do
  // not include shadow descendants. The cache is local to this frame document.
  const roots: Array<Document | ShadowRoot> = [document];
  for (let i = 0; i < roots.length; i++) {
    for (const node of roots[i].querySelectorAll<HTMLElement>('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
  }
  const semanticSelector = 'a[href],button,input,textarea,select,summary,canvas,[role="button"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="textbox"],[role="searchbox"],[role="tab"],[aria-haspopup],[class*="dropdown-trigger"],[onmouseenter],[onmouseover],[onclick],[tabindex]';
  const semanticNodes = new Set(roots.flatMap(root => Array.from(root.querySelectorAll<HTMLElement>(semanticSelector))));
  // Empty/uppercase/plaintext-only are valid editing declarations too. Only
  // collect editing hosts, not every descendant that inherits editability.
  for (const root of roots) for (const node of root.querySelectorAll<HTMLElement>('[contenteditable]')) {
    if (editingHost(node)) semanticNodes.add(node);
  }
  // Determine associated icon buttons before enumeration, regardless of DOM order.
  const searchFields = new Map([...semanticNodes].filter(node => ["INPUT", "TEXTAREA"].includes(node.tagName)).map(node => [node, searchField(node)]));
  // React/Vue menus often expose only a pointer-styled div or image, without
  // a role, tabindex, or onclick attribute. Include the root pointer region,
  // not each inherited descendant or every decorative image on the page.
  const pointerNodes = roots.flatMap(root => Array.from(root.querySelectorAll<HTMLElement>('div,span,img,svg,li'))).filter(node => {
    if (semanticNodes.has(node) || getComputedStyle(node).cursor !== 'pointer') return false;
    if (node.parentElement?.closest(semanticSelector)) return false;
    return !node.parentElement || getComputedStyle(node.parentElement).cursor !== 'pointer';
  });
  for (const node of [...semanticNodes, ...pointerNodes]) {
    if (!visible(node) || disabled(node) || node.getAttribute("aria-disabled") === "true") continue;
    if (node.isContentEditable && !editingHost(node)) continue;
    const type = (node as HTMLInputElement).type;
    if (["hidden", "password"].includes(type) || (!native && (type === "file" || node.isContentEditable))) continue;
    let ref = cache.ids.get(node);
    if (!ref) { ref = `e${cache.next++}`; cache.ids.set(node, ref); cache.nodes.set(ref, node); }
    cache.nodes.set(ref, node);
    const labelIds = node.getAttribute("aria-labelledby")?.split(/\s+/) || [];
    const labels = Array.from((node as HTMLInputElement).labels || []).map(l => l.textContent).join(" ");
    const rect = node.getBoundingClientRect();
    const iconPosition = `${rect.top < 160 ? '上方' : rect.top > window.innerHeight * 0.66 ? '下方' : '中部'}${rect.left > window.innerWidth * 0.66 ? '右侧' : rect.right < window.innerWidth * 0.33 ? '左侧' : ''}`;
    const iconLabel = node.getAttribute("class")?.includes("dropdown-trigger")
      ? `下拉菜单入口（${iconPosition}，悬停展开）` : `无文字控件（${iconPosition}，可悬停查看）`;
    const root = (node.getRootNode?.() || document) as Document | ShadowRoot;
    const label = clean(node.getAttribute("aria-label") || labelIds.map(id => root.getElementById(id)?.textContent).join(" ") || labels || node.getAttribute("placeholder") || node.innerText || node.getAttribute("title") || node.getAttribute("name") || node.getAttribute("alt") || node.querySelector("img[alt]")?.getAttribute("alt") || node.querySelector("svg title")?.textContent || (searchTriggers.has(node) ? "搜索" : iconLabel));
    const tag = node.tagName;
    const kind = tag === "SELECT" ? "select" : node.isContentEditable || tag === "TEXTAREA" || (tag === "INPUT" && !["file", "checkbox", "radio", "button", "submit", "reset", "image", "range", "color"].includes(type)) ? "fill" : "click";
    if (kind === "fill" && (node as HTMLInputElement).readOnly) continue;
    const role = type === "file" ? "fileupload" : node.getAttribute("role") || (tag === "CANVAS" ? "canvas" : tag === "A" ? "link" : kind === "fill" ? "textbox" : kind === "select" ? "combobox" : ["checkbox", "radio"].includes(type) ? type : "button");
    const form = (node as HTMLInputElement).form;
    const popup = Boolean(node.getAttribute("aria-haspopup") && node.getAttribute("aria-haspopup") !== "false") || /dropdown|filter-container|filter-panel-trigger/.test(node.getAttribute("class") || "") || node.getAttribute("onmouseenter") !== null || node.getAttribute("onmouseover") !== null;
    const social = `${node.getAttribute("data-testid") || ""} ${node.getAttribute("class") || ""}`.match(/(?:^|[-_\s])(like|unlike|collect|bookmark|follow|unfollow|retweet|repost)(?=$|[-_\s])/i)?.[1];
    const candidate: DomCandidate = { ref, role, label, kind, dom: { tag, type: String(type || ""), search: kind === "fill" ? searchFields.get(node) === true : searchTriggers.has(node) || Boolean(form && /^(搜索|查找|search|find)$/i.test(label) && Array.from(form.elements || []).some(el => searchFields.get(el as HTMLElement))), popup,
      toggle: node.getAttribute("aria-pressed") !== null, command: node.getAttribute("data-action") || node.getAttribute("data-method") || social || endpointAction(node.getAttribute("formaction") || form?.action || (tag === "A" ? (node as HTMLAnchorElement).href : "")), download: node.getAttribute("download") !== null } };
    if (form && kind === "fill") {
      const effects = Array.from(form.elements || []).filter(el => ["submit", "image"].includes((el as HTMLInputElement).type)).map(el => classify({ ref: "", role: "button", kind: "click", submit: true,
        label: `${clean(el.getAttribute?.("aria-label") || (el as HTMLElement).innerText || (el as HTMLInputElement).value)} ${endpointAction(el.getAttribute?.("formaction") || form.action || "")}` }));
      candidate.dom!.enterEffect = (["purchase", "delete", "send", "submit"] as Effect[]).find(effect => effects.includes(effect));
    }
    candidate.offscreen = rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight;
    if (tag === "INPUT") candidate.inputType = String(type || "text");
    if (tag === "A") candidate.href = linkAddress((node as HTMLAnchorElement).href);
    if (kind !== "click") candidate.value = String(node.isContentEditable ? node.innerText : (node as HTMLInputElement).value || "").slice(0, 20000);
    if (["checkbox", "radio"].includes(role)) candidate.checked = tag === "INPUT" ? (node as HTMLInputElement).checked : node.getAttribute("aria-checked") === "true";
    if (tag === "SELECT") {
      const select = node as HTMLSelectElement, options = Array.from(select.options);
      candidate.multiple = select.multiple;
      // Keep the full selection even when query/pagination limits the options.
      // select.value alone only identifies the first selected option.
      candidate.selectedValues = options.filter(o => o.selected).map(o => o.value);
      candidate.options = options.filter(o => !disabled(o) && (!slice.query || `${o.label} ${o.value}`.toLowerCase().includes(slice.query.toLowerCase()))).slice(0, 80).map(o => ({ value: o.value, label: clean(o.label), selected: o.selected }));
    }
    if ((tag === "BUTTON" || tag === "INPUT") && type === "submit" && (node as HTMLButtonElement).form) candidate.submit = true;
    candidate.dom!.effect = classify(candidate);
    candidates.push(candidate);
    // A broad section may contain the entire live feed. Bind the target to its
    // nearest record/form context and keep that container's identity as well.
    const contextNode = node.closest('label,fieldset,tr,article,[role="listitem"],[role="menu"],[role="dialog"]') || node.parentElement;
    const contextId = contextNode && contextIdentity(contextNode);
    const searchBinding = searchBindings.get(node);
    values.push(JSON.stringify([kind !== "click" ? String(node.isContentEditable ? node.innerText : (node as HTMLInputElement).value || "") : "", node.getAttribute("href"), node.getAttribute("type"), node.getAttribute("formaction"), node.getAttribute("target"), form?.action, form?.method, form?.target,
      node.getAttribute("formmethod"), node.getAttribute("role"), node.getAttribute("aria-disabled"), node.getAttribute("aria-pressed"), node.getAttribute("aria-expanded"), node.getAttribute("onclick"), node.getAttribute("onkeydown"),
      tag === "SELECT" ? Array.from((node as HTMLSelectElement).options).map(o => [o.value, o.selected, disabled(o)]) : undefined,
      form ? Array.from(form.elements || []).map(el => { const input = el as HTMLInputElement; return [input.tagName, input.type, input.name, disabled(input), input.readOnly, ["password", "hidden"].includes(input.type) ? undefined : input.value, input.getAttribute?.("formmethod"), input.getAttribute?.("formaction"), el.tagName === "SELECT" ? [(el as HTMLSelectElement).multiple, Array.from((el as HTMLSelectElement).options).map(o => [o.value, o.selected, disabled(o)])] : undefined]; }) : undefined,
      contextId, contextNode?.getAttribute?.("role"), contextNode?.getAttribute?.("aria-label"),
      searchBinding && [node.getAttribute("id"), node.getAttribute("name"), node.getAttribute("class"), node.getAttribute("aria-label"), node.getAttribute("aria-labelledby"), contextIdentity(searchBinding.root), contextIdentity(searchBinding.trigger),
        ...[searchBinding.root, searchBinding.trigger].map(el => [el.tagName, ...["id", "class", "role", "type", "aria-label", "aria-labelledby", "data-action", "data-method", "formaction", "formmethod", "onclick", "onkeydown"].map(name => el.getAttribute(name))]),
        clean(searchBinding.trigger.innerText), searchBinding.trigger.querySelector("use")?.getAttribute("href") || searchBinding.trigger.querySelector("use")?.getAttribute("xlink:href"),
        (searchBinding.trigger as HTMLButtonElement).form?.action, (searchBinding.trigger as HTMLButtonElement).form?.method,
        Array.from(searchBinding.trigger.querySelectorAll('img')).map(image => [contextIdentity(image), ...["src", "class", "alt"].map(name => image.getAttribute(name))])]]));
    contexts.push(clean(contextNode?.textContent, 350));
  }
  // Controls and nearby form context define action validity. Unrelated animated
  // page text does not invalidate a click; values and node identities do.
  // Read the composed tree in place: a shadow root replaces its host's light
  // children, and slots insert assigned nodes exactly once. Appending all
  // shadow text after body.innerText loses headings/dates and includes CSS.
  const visited = new Set<Node>();
  const textParts: Array<{ text: string; preserve: boolean }> = [];
  const appendText = (text: string, preserve = false): void => {
    if (!text) return;
    const previous = textParts.at(-1);
    if (previous?.preserve === preserve) previous.text += text;
    else textParts.push({ text, preserve });
  };
  const readText = (node: Node, preserve = false): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.nodeType === 3) { appendText(preserve ? node.textContent || "" : (node.textContent || "").replace(/\s+/g, " "), preserve); return; }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    const el = node.nodeType === 1 ? node as HTMLElement : undefined;
    let display = "", whiteSpace = preserve;
    if (el) {
      if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|HEAD|META|LINK)$/.test(el.tagName) || el.hasAttribute("data-profilepilot-overlay") || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert")) return;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return;
      display = style.display;
      whiteSpace = /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace) || preserve;
      if (el.tagName === "BR") { appendText("\n", whiteSpace); return; }
    }
    let children: Node[];
    if (el?.tagName === "SLOT") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      children = assigned.length ? assigned : Array.from(el.childNodes);
    } else if (el?.shadowRoot) children = Array.from(el.shadowRoot.childNodes);
    else children = Array.from(node.childNodes);
    if (el?.tagName === "DETAILS" && !el.hasAttribute("open")) children = children.filter(child => (child as Element).tagName === "SUMMARY");
    const block = /^(block|flow-root|flex|grid|list-item|table|table-row|table-caption)$/.test(display);
    if (block) appendText("\n");
    // Retain a local range only for date elements; their visible label may
    // already contain the machine-readable timestamp.
    const dated = el && /^(TIME|RELATIVE-TIME|LOCAL-TIME)$/.test(el.tagName);
    const startPart = textParts.length - 1, startLength = textParts.at(-1)?.text.length || 0;
    for (const child of children) readText(child, whiteSpace);
    if (dated) {
      const date = el.getAttribute("datetime");
      const content = textParts.slice(Math.max(0, startPart)).map((part, index) => index === 0 && startPart >= 0 ? part.text.slice(startLength) : part.text).join("");
      if (date && !content.includes(date)) appendText(` (${date})`, whiteSpace);
    }
    if (display === "table-cell") appendText("\t");
    if (block) appendText("\n");
  };
  if (document.body) readText(document.body);
  // Nested layout containers must not multiply paragraph separators. Keep
  // authored pre/pre-wrap/break-spaces runs separate so code indentation and
  // intentional blank lines survive normalization, including at page edges.
  for (const part of textParts) if (!part.preserve) part.text = part.text.replace(/[\t\r\f ]*\n[\t\r\f ]*/g, "\n").replace(/\n{3,}/g, "\n\n");
  if (textParts[0] && !textParts[0].preserve) textParts[0].text = textParts[0].text.trimStart();
  const lastText = textParts.at(-1);
  if (lastText && !lastText.preserve) lastText.text = lastText.text.trimEnd();
  let text = textParts.map(part => part.text).join("");
  const query = (slice.query || "").toLowerCase();
  const indices = candidates.map((_, i) => i).filter(i => !query || JSON.stringify(candidates[i]).toLowerCase().includes(query) || contexts[i].toLowerCase().includes(query));
  // Search snippets also work on a single very long line; no trailing content
  // becomes unreachable merely because it is beyond the model's first page.
  if (query) {
    const lower = text.toLowerCase(), snippets: string[] = [];
    let at = lower.indexOf(query), end = -1;
    while (at >= 0) {
      if (at >= end) { end = Math.min(text.length, at + query.length + 300); snippets.push(text.slice(Math.max(0, at - 120), end)); }
      at = lower.indexOf(query, at + Math.max(1, query.length));
    }
    text = snippets.join("\n…\n");
  }
  let hash = 2166136261;
  const source = JSON.stringify([location.href, candidates.map(c => [c.ref, c.label, c.value, c.checked, c.multiple, c.selectedValues]), text]);
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  const revision = (hash >>> 0).toString(36);
  if ((slice.document && slice.document !== cache.document) || (slice.revision && slice.revision !== revision)) throw new Error("分页内容已变化，请从头重新观察或搜索。");
  const offset = slice.offset || 0, textOffset = slice.textOffset || 0;
  const limit = Math.max(1, Math.min(120, slice.limit || 80)), textLimit = Math.max(1, Math.min(16000, slice.textLimit || 8000));
  const selected = indices.slice(offset, offset + limit);
  for (const ref of slice.refs || []) { const index = candidates.findIndex(candidate => candidate.ref === ref); if (index >= 0 && !selected.includes(index)) selected.push(index); }
  const selectedCandidates = selected.map(i => candidates[i]);
  // Scrolling/focusing a form can change offscreen and the descriptive icon
  // position without changing what will be acted on. Identity, semantics,
  // attributes and values remain guarded; hit testing validates live geometry.
  const guardCandidates = selectedCandidates.map(({ offscreen: _offscreen, ...candidate }) => {
    const node = cache.nodes.get(candidate.ref) as HTMLInputElement;
    // Only a structurally proven search may rotate its placeholder without
    // changing its purpose. Keep explicit labels and all binding facts guarded.
    const rotatingSearch = searchBindings.has(node) && !node.getAttribute("aria-label") && !node.getAttribute("aria-labelledby") && !node.labels?.length &&
      candidate.label === clean(node.getAttribute("placeholder"));
    return { ...candidate, label: rotatingSearch ? "搜索" : /^(无文字控件|下拉菜单入口)（/.test(candidate.label) ? candidate.label.replace(/（.*）$/, "") : candidate.label };
  });
  const focus = { focusedRef: cache.ids.get(active), editable: Boolean(active && ((active as HTMLElement).isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))) };
  const guard = JSON.stringify([location.href, cache.document, guardCandidates, selected.map(i => contexts[i]), selected.map(i => values[i]), focus]);
  return { document: cache.document, guard, candidates: selectedCandidates, url: location.href, title: document.title,
    text: text.slice(textOffset, textOffset + textLimit), revision, totalControls: indices.length, totalText: text.length,
    offset, textOffset, nextOffset: Math.min(indices.length, offset + limit), nextTextOffset: Math.min(text.length, textOffset + textLimit) };
}

export function readLinkGuard(guard: string, action: BrowserAction): string | undefined {
  try {
    const [url, documentId, candidates, contexts, values, focus] = JSON.parse(guard);
    if (action.kind === "scroll" && !action.ref) return JSON.stringify([url, documentId, focus?.frame]);
    if (action.kind === "press" && /^Escape$/i.test(action.value || "") && focus) return JSON.stringify([url, documentId, focus]);
    const ref = action.ref?.replace(/^@/, "") || (action.kind === "press" ? focus?.focusedRef : undefined);
    const index = candidates.findIndex((candidate: BrowserCandidate) => candidate.ref === ref);
    const candidate = candidates[index];
    if (index < 0 || typeof values[index] !== "string" || typeof contexts[index] !== "string") return;
    // Old observations have no collected DOM semantics. Preserve their narrow
    // read-only anchor/hover exception, including exact target context.
    const legacy = !candidate.dom;
    if (legacy && action.effect !== "read") return;
    const search = candidate.dom?.search === true;
    const legacyLink = legacy && candidate.role === "link" && /^https?:\/\//i.test(candidate.href || "") && !candidate.submit;
    const safe = action.kind === "hover" || (action.kind === "click" && (candidate.dom?.effect === "read" || legacyLink)) || (action.kind === "fill" && search) ||
      (action.kind === "press" && /^(Enter|Return)$/i.test(action.value || "") && search && focus?.focusedRef === ref);
    if (!safe) return;
    // Only explicit social counters are volatile for modern navigation links.
    // Do not erase arbitrary numbers, account names or hover/menu context.
    const context = !legacy && action.kind === "click" && candidate.role === "link"
      ? contexts[index].replace(/(?<![\p{L}\p{N}_])\d+(?:[.,]\d+)*(?:[kKmMbB]|万|亿)?\s+(?:likes?|bookmarks?|comments?|views?|reposts?|shares?|followers?)(?![\p{L}\p{N}_])/giu, "")
        .replace(/(?<![\p{L}\p{N}_])\d+(?:\.\d+)?(?:万|亿)?\s*(?:点赞|收藏|评论|浏览|转发|赞)(?:数)?(?![\p{L}\p{N}_])/gu, "").replace(/[\s,，·|]+/g, " ").trim()
      : contexts[index];
    return JSON.stringify([url, documentId, candidate, context, values[index], focus?.frame, action.kind === "press" ? focus?.focusedRef : undefined]);
  } catch { return; }
}

function prepareAction(expected: { document: string; guard: string }, action: BrowserAction, snapshot: () => ReturnType<typeof pageSnapshot>, linkGuard: typeof readLinkGuard, pointerPhase?: "scroll" | "validate") {
  const current = snapshot();
  const expectedLink = linkGuard(expected.guard, action);
  if (current.document !== expected.document || (current.guard !== expected.guard && (!expectedLink || expectedLink !== linkGuard(current.guard, action)))) throw new Error("页面内容已经变化，动作未执行，请重新观察。");
  const cache = (window as any).__profilepilot_jev_dom_v1;
  const ref = action.ref?.replace(/^@/, "");
  const candidate = current.candidates.find(c => c.ref === ref);
  const node = (ref ? cache.nodes.get(ref) : undefined) as HTMLElement | undefined;
  if (action.kind === "scroll") {
    const directions: Record<string, { top: number; left: number }> = { up: { top: -600, left: 0 }, down: { top: 600, left: 0 }, left: { top: 0, left: -600 }, right: { top: 0, left: 600 } };
    const offset = directions[action.value || "down"];
    if (!offset) throw new Error("不支持的滚动方向。");
    if (ref && (!node?.isConnected || !candidate)) throw new Error("目标元素已失效，滚动未执行。");
    const horizontal = offset.left !== 0;
    const page = document.scrollingElement || document.documentElement;
    let target: HTMLElement | undefined;
    if (node) {
      let ancestor: Element | null = node;
      while (ancestor && ancestor !== page && ancestor !== document.body) {
        const style = getComputedStyle(ancestor);
        const overflow = horizontal ? style.overflowX : style.overflowY;
        const extent = horizontal ? ancestor.scrollWidth - ancestor.clientWidth : ancestor.scrollHeight - ancestor.clientHeight;
        if (extent > 1 && /^(auto|scroll|overlay)$/.test(overflow)) { target = ancestor as HTMLElement; break; }
        ancestor = ancestor.assignedSlot || ancestor.parentElement || (ancestor.getRootNode() as ShadowRoot).host || null;
      }
      const pageExtent = horizontal ? (page?.scrollWidth || 0) - window.innerWidth : (page?.scrollHeight || 0) - window.innerHeight;
      if (!target && !(pageExtent > 1)) throw new Error("目标及其祖先没有可滚动区域，滚动未执行。");
    }
    const position = () => target ? { x: target.scrollLeft, y: target.scrollTop } : { x: window.scrollX || 0, y: window.scrollY || 0 };
    const before = position();
    if (target) target.scrollBy({ ...offset, behavior: "instant" });
    else window.scrollBy({ ...offset, behavior: "instant" });
    const after = position(), scroller = target || page;
    const extent = Math.max(0, horizontal ? (scroller?.scrollWidth || 0) - (target ? target.clientWidth : window.innerWidth || 0)
      : (scroller?.scrollHeight || 0) - (target ? target.clientHeight : window.innerHeight || 0));
    const rtl = horizontal && scroller && getComputedStyle(scroller).direction === "rtl";
    const coordinate = horizontal ? after.x : after.y, amount = horizontal ? offset.left : offset.top;
    const boundary = amount > 0 ? (rtl ? 0 : extent) : (rtl ? -extent : 0);
    return { done: true, scroll: { target: target ? "element" : "window", requested: { x: offset.left, y: offset.top },
      before, after, moved: { x: after.x - before.x, y: after.y - before.y }, atBoundary: Math.abs(coordinate - boundary) <= 1 } };
  }
  if (!node?.isConnected || !candidate) throw new Error("目标元素已失效，动作未执行。");
  if ((action.kind === "fill" && candidate.kind !== "fill") || (action.kind === "select" && candidate.kind !== "select") || (action.kind === "click" && candidate.kind !== "click")) throw new Error("目标类型不匹配。");
  let value = action.value || "";
  const fillInputType = action.kind === "fill" && node.tagName === "INPUT" ? (node as HTMLInputElement).type : undefined;
  const assertWritable = () => {
    if (!node.isConnected) throw new Error("目标元素已失效，动作未执行。");
    if (fillInputType !== undefined && (node as HTMLInputElement).type !== fillInputType) throw new Error("输入框类型已经变化，原值未更改，请重新观察。");
    if ((node as HTMLInputElement).disabled || node.matches?.(":disabled") || node.getAttribute("aria-disabled") === "true") throw new Error("目标已禁用，动作未执行。");
    if (action.kind === "fill" && (node as HTMLInputElement).readOnly) throw new Error("目标为只读，原值未更改。");
    if (action.kind === "select" && !Array.from((node as HTMLSelectElement).options).some(o => !o.disabled && !o.matches?.(":disabled") && o.value === value)) throw new Error("下拉选项不存在或已禁用。");
  };
  assertWritable();
  if (action.kind === "fill" && node.tagName === "INPUT" && /^(number|date|datetime-local|month|time|week)$/.test((node as HTMLInputElement).type)) {
    // Let this Chrome version validate and canonicalize its own value syntax
    // on a detached control. Do not apply live constraints such as min/step:
    // out-of-range values can still be represented by an editable input.
    const input = node as HTMLInputElement, probe = document.createElement("input");
    probe.type = input.type;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(probe, value);
    if (value !== "" && probe.value === "") throw new Error(`输入值不符合 ${input.type} 格式，原值未更改。请按观察中的 inputType 使用浏览器支持的格式。`);
    value = probe.value;
  }
  if (pointerPhase !== "validate") node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  if (pointerPhase === "scroll") return { prepared: true };
  const r = node.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit || !(node === hit || node.contains(hit))) throw new Error("目标被其他元素遮挡，动作未执行。");
  if (action.kind === "click" || action.kind === "hover") return { x, y };
  node.focus();
  // A synchronous focus handler can lock, detach or change the field. Recheck
  // before writing, without retrying or undoing the page's own state change.
  assertWritable();
  const prototype = node.tagName === "SELECT" ? HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  if (node.isContentEditable) node.textContent = value;
  else Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  node.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return { done: true };
}

export class FastBrowserPageError extends Error {
  readonly code = "FAST_BROWSER_PAGE_ERROR";
  constructor(readonly phase: "observe" | "execute", reason: string) {
    super(`${phase === "observe" ? "快速页面读取失败" : "快速页面操作失败"}：${reason}`);
    this.name = "FastBrowserPageError";
  }
}

function pageExceptionReason(details: any): string {
  const reason = details.exception?.description || details.exception?.value || details.text;
  if (typeof reason !== "string" || !reason.trim()) return "浏览器未提供具体的脚本异常信息。";
  // Keep the actual exception, without its stack, URL credentials or query parameters.
  return reason.trim().split(/\r?\n/, 1)[0]
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "[网页地址]"; }
    })
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/(Bearer\s+)\S+/gi, "$1[已隐藏]")
    .slice(0, 500);
}

export class FastBrowser {
  private readonly ready = new Set<string>();
  constructor(private readonly acquire: (task: BrowserTask) => Promise<unknown>,
    private readonly transport?: (task: BrowserTask, method: string, params: Record<string, unknown>) => Promise<any>) {}
  async raw(task: BrowserTask, method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.transport) return this.transport(task, method, params);
    if (!task.port) throw new Error("任务没有绑定浏览器端口。");
    if (!this.ready.has(task.sessionId)) { await this.acquire(task); this.ready.add(task.sessionId); }
    const homeDir = process.env.PROFILEPILOT_GATEWAY_HOME;
    const response = await requestBrowserGateway({ action: "raw-cdp", publicPort: task.port, sessionId: task.sessionId,
      daemonInstanceId: readOrCreateBrowserGatewayDaemonIdentity(task.sessionId, homeDir), method, params, timeoutMs: 15000 }, { homeDir, timeoutMs: 18000 });
    return response.result;
  }
  private async evaluate(task: BrowserTask, expression: string, phase: "observe" | "execute"): Promise<any> {
    const response = await this.raw(task, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new FastBrowserPageError(phase, pageExceptionReason(response.exceptionDetails));
    return response.result?.value;
  }
  async observe(task: BrowserTask, options: PageReadOptions = {}, range?: PageSlice): Promise<PagedObservation> {
    let slice: PageSlice = range || { query: options.query, limit: options.limit, textLimit: options.textLimit };
    if (options.cursor) {
      try { slice = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")); } catch { throw new Error("无效的分页游标。"); }
      if (!slice.document || !slice.revision || !Number.isSafeInteger(slice.offset) || !Number.isSafeInteger(slice.textOffset) || slice.offset! < 0 || slice.textOffset! < 0) throw new Error("无效的分页游标。");
    }
    const page = await this.evaluate(task, `({...(${pageSnapshot.toString()})(${JSON.stringify(randomUUID())},${Boolean(this.transport)},${JSON.stringify(slice)},${domControlEffect.toString()}), viewport: (${pageViewport.toString()})()})`, "observe");
    if (!page || typeof page.guard !== "string" || !Array.isArray(page.candidates)) throw new FastBrowserPageError("observe", "页面脚本未返回有效的页面内容和控件列表。");
    const lines = page.candidates.map((c: DomCandidate) => `- ${c.role} ${JSON.stringify(c.label)} [ref=${c.ref}] ${c.value !== undefined ? `value=${JSON.stringify(c.value)}` : ""}${c.inputType ? ` inputType=${JSON.stringify(c.inputType)}` : ""}${c.multiple ? ` multiple=true selectedValues=${JSON.stringify(c.selectedValues)}` : ""}${c.checked !== undefined ? ` checked=${c.checked}` : ""}${c.submit ? " (submit button)" : ""}${c.dom?.search ? " (search input/control)" : ""}${c.dom?.popup ? " (popup trigger; hover can reveal options)" : ""}${c.offscreen ? " (outside viewport; scroll into view)" : ""}`);
    const nextCursor = page.nextOffset < page.totalControls || page.nextTextOffset < page.totalText ? Buffer.from(JSON.stringify({ ...slice, document: page.document, revision: page.revision, offset: page.nextOffset, textOffset: page.nextTextOffset })).toString("base64url") : undefined;
    const observation: PagedObservation = { version: randomUUID(), at: new Date().toISOString(), url: page.url, title: page.title,
      fingerprint: createHash("sha256").update(page.guard).digest("hex"), snapshot: page.text + "\n\nControls:\n" + lines.join("\n"), account: "账号未确认",
      viewport: page.viewport, fast: { document: page.document, guard: page.guard, candidates: page.candidates },
      page: { nextCursor, totalControls: page.totalControls, totalText: page.totalText, offset: page.offset, textOffset: page.textOffset, query: slice.query } };
    // Kept in local execution state; the model receives candidates and page
    // metadata only. Revalidation must read the same range as the observation.
    Object.assign(observation.fast!, { slice: { ...slice, document: undefined, revision: undefined, refs: undefined } });
    if (nextCursor) observation.snapshot += "\n内容还有后续分页；用 read_page 的 cursor 继续读取，或 query 搜索。";
    return observation;
  }
  async execute(task: BrowserTask, action: BrowserAction, synchronizePointer?: () => Promise<void>): Promise<string> {
    const expected = task.observation?.fast;
    if (!expected) throw new Error("缺少有效页面观察。");
    const pointer = action.kind === "click" || action.kind === "hover";
    // The native adapter supplies its own frame barrier. Gateway on Windows
    // uses a screenshot; both must happen after scrolling the target into view.
    const synchronize = pointer ? synchronizePointer || (process.platform === "win32" && !this.transport
      ? async () => { await this.raw(task, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); } : undefined) : undefined;
    const slice = { ...(expected as typeof expected & { slice?: PageSlice }).slice, refs: expected.candidates.map(candidate => candidate.ref) };
    const prepare = (phase?: "scroll" | "validate") => this.evaluate(task, `(${prepareAction.toString()})(${JSON.stringify({ document: expected.document, guard: expected.guard })},${JSON.stringify(action)},() => (${pageSnapshot.toString()})(${JSON.stringify(randomUUID())},${Boolean(this.transport)},${JSON.stringify(slice)},${domControlEffect.toString()}),${readLinkGuard.toString()},${JSON.stringify(phase)})`, "execute");
    if (synchronize) {
      await prepare("scroll");
      await synchronize();
    }
    // Recheck identity/semantics and compute a fresh hit point after the frame
    // barrier, without another scroll that would invalidate that painted frame.
    const result = await prepare(synchronize ? "validate" : undefined);
    if (!result) throw new Error("无法验证操作结果。");
    if (action.kind === "scroll") return `滚动结果：${JSON.stringify(result.scroll)}；需要重新观察确认页面内容。`;
    if (action.kind === "hover") {
      if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) throw new Error("无效的目标位置。");
      await this.raw(task, "Input.dispatchMouseEvent", { type: "mouseMoved", x: result.x, y: result.y, button: "none" });
    } else if (action.kind === "click") {
      if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) throw new Error("无效的目标位置。");
      await this.raw(task, "Input.dispatchMouseEvent", { type: "mousePressed", x: result.x, y: result.y, button: "left", clickCount: 1 });
      await this.raw(task, "Input.dispatchMouseEvent", { type: "mouseReleased", x: result.x, y: result.y, button: "left", clickCount: 1 });
    }
    return "操作已执行；需要重新观察确认结果。";
  }
  reobserve(task: BrowserTask): Promise<PagedObservation> {
    const prior = task.observation?.fast as (NonNullable<BrowserObservation["fast"]> & { slice?: PageSlice }) | undefined;
    return this.observe(task, {}, prior ? { ...prior.slice, refs: prior.candidates.map(candidate => candidate.ref) } : undefined);
  }
  forget(task: BrowserTask): void { this.ready.delete(task.sessionId); }
}
