type Reading = { top: number; bottom: boolean; anchor?: string; offset?: number; details: Record<string, boolean> };
const keyOf = (node: Node): string => {
  if (!(node instanceof Element)) return "";
  return node.getAttribute("data-editor-key") || (node.id ? `${node.tagName}#${node.id}${node.getAttribute("data-decision-id") || ""}` : ["data-task-row", "data-task", "data-nav", "data-control", "data-action", "data-message-id"].map(name => node.hasAttribute(name) ? `${node.tagName}:${name}:${node.getAttribute(name)}` : "").find(Boolean) || "");
};
const compatible = (a: Node, b: Node): boolean => a.nodeType === b.nodeType && (!(a instanceof Element) || b instanceof Element && a.tagName === b.tagName && keyOf(a) === keyOf(b));

/** The inspector can follow the conversation in normal document flow. The
 * conversation's latest position therefore ends at its composer, not the page. */
export function taskLatestScrollTop(workspace: HTMLElement): number {
  const end = workspace.querySelector<HTMLElement>("#task-thread-end") || workspace.querySelector<HTMLElement>("#steer-task") || workspace.querySelector<HTMLElement>("#events");
  const maximum = Math.max(0, workspace.scrollHeight - workspace.clientHeight);
  if (!end) return maximum;
  const viewportTop = workspace.getBoundingClientRect().top + (workspace.clientTop || 0);
  const target = workspace.scrollTop + end.getBoundingClientRect().bottom - viewportTop - workspace.clientHeight + 16;
  return Math.max(0, Math.min(maximum, target));
}
export function isAtTaskLatest(workspace: HTMLElement, tolerance = 32): boolean {
  // Reading below the composer (inside the inspector) is a saved reading
  // position, not an instruction to follow new conversation messages.
  return Math.abs(workspace.scrollTop - taskLatestScrollTop(workspace)) < tolerance;
}
export function scrollToTaskLatest(workspace: HTMLElement): void {
  // The sticky jump button participates in flow. Hide it before measuring so
  // dismissing it cannot leave the composer above the recorded follow point.
  const button = workspace.querySelector<HTMLElement>(".task-jump-latest"); if (button) button.hidden = true;
  workspace.scrollTop = taskLatestScrollTop(workspace);
}

/** The floating latest button must not cover any visible reply control. It can
 * return when the reader scrolls away from the decision. */
export function jumpOverlapsReply(workspace: HTMLElement, button: HTMLElement): boolean {
  const reply = workspace.querySelector<HTMLElement>("#reply-task"); if (!reply) return false;
  const jump = button.getBoundingClientRect();
  if (!jump.width || !jump.height) return false;
  const gap = 8;
  return [...reply.querySelectorAll<HTMLElement>("button,input,textarea,select,a")].some(control => {
    const rect = control.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && jump.left < rect.right + gap && jump.right > rect.left - gap && jump.top < rect.bottom + gap && jump.bottom > rect.top - gap;
  });
}

export function syncTaskScrollInsets(workspace: HTMLElement): void {
  const header = workspace.querySelector<HTMLElement>(".page-header");
  workspace.style.setProperty("--task-header-height", `${Math.max(0, header?.getBoundingClientRect().height || 0)}px`);
  const status = workspace.querySelector<HTMLElement>(".task-thread-status");
  workspace.style.setProperty("--task-sticky-height", `${Math.max(0, status?.getBoundingClientRect().height || 0)}px`);
}

/** Reveal a pending reply in the viewport space below the sticky header/status.
 * Explicit reply navigation prefers the editor and approval controls together;
 * an initial visit starts with the question when a long card cannot fit. */
export function revealTaskReply(workspace: HTMLElement, focus = false): void {
  const form = workspace.querySelector<HTMLElement>("#reply-task"); if (!form) return;
  syncTaskScrollInsets(workspace);
  const answer = form.querySelector<HTMLTextAreaElement>("#answer");
  if (focus) answer?.focus({ preventScroll: true });
  // A scroll can move the status bar from normal flow into its sticky position.
  // Recheck that geometry once, without a scroll-handler feedback loop.
  for (let pass = 0; pass < 2; pass++) {
    const viewportTop = workspace.getBoundingClientRect().top + (workspace.clientTop || 0), viewportBottom = viewportTop + workspace.clientHeight;
    let visibleTop = viewportTop;
    for (const bar of workspace.querySelectorAll<HTMLElement>(".page-header,.task-thread-status")) {
      const rect = bar.getBoundingClientRect();
      if (rect.bottom > viewportTop && rect.top < viewportBottom) visibleTop = Math.max(visibleTop, rect.bottom);
    }
    visibleTop = Math.min(visibleTop, viewportBottom - 48) + 12;
    const visibleBottom = viewportBottom - 16, available = visibleBottom - visibleTop;
    const card = form.getBoundingClientRect();
    let top = card.top, bottom = card.bottom;
    if (focus && answer && card.height > available) {
      const editor = answer.getBoundingClientRect(); top = editor.top; bottom = editor.bottom;
      for (const button of form.querySelectorAll<HTMLElement>('button[type="submit"]')) bottom = Math.max(bottom, button.getBoundingClientRect().bottom);
      if (bottom - top > available) bottom = editor.bottom;
    }
    const delta = bottom - top > available || top < visibleTop ? top - visibleTop : bottom > visibleBottom ? bottom - visibleBottom : 0;
    const next = Math.max(0, Math.min(Math.max(0, workspace.scrollHeight - workspace.clientHeight), workspace.scrollTop + delta));
    if (Math.abs(next - workspace.scrollTop) < 1) break;
    workspace.scrollTop = next;
  }
}

/** Patch unchanged message nodes in place, and retain textarea instances between views.
 * This preserves native editing history instead of replacing it with a string cache. */
export class TaskDom {
  private editors = new Map<string, HTMLTextAreaElement>();
  private reading = new Map<string, Reading>();
  private page = "";
  private previousDecision = "";
  constructor(private root: HTMLElement) {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem("profilepilot-task-reading") || "[]");
      if (Array.isArray(saved)) for (const entry of saved) if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1]?.top === "number" && entry[1]?.details && typeof entry[1].details === "object") this.reading.set(entry[0], entry[1]);
    } catch { /* Reading positions are optional; message drafts are independent. */ }
  }
  capture(): void {
    if (!this.page) return;
    for (const node of this.root.querySelectorAll<HTMLTextAreaElement>("textarea[data-editor-key]")) if (!node.closest("[data-task-chat-owned]")) this.editors.set(node.dataset.editorKey!, node);
    const workspace = this.root.querySelector<HTMLElement>(".workspace"); if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    const anchor = [...workspace.querySelectorAll<HTMLElement>("[data-message-id], details[id]")].find(node => node.getBoundingClientRect().bottom > rect.top + 60);
    this.reading.set(this.page, { top: workspace.scrollTop, bottom: isAtTaskLatest(workspace), anchor: anchor?.id, offset: anchor ? anchor.getBoundingClientRect().top - rect.top : undefined, details: Object.fromEntries([...workspace.querySelectorAll<HTMLDetailsElement>("details[id]")].map(node => [node.id, node.open])) });
    try { sessionStorage.setItem("profilepilot-task-reading", JSON.stringify([...this.reading])); } catch { /* Memory restoration remains available. */ }
  }
  update(markup: string, page: string): void {
    this.capture();
    this.previousDecision = this.page === page ? this.root.querySelector<HTMLFormElement>("#reply-task")?.dataset.decisionId || "" : "";
    // Custom select controls are rebuilt by TaskSelects. Unwrap their source first.
    for (const wrapper of this.root.querySelectorAll(".select-field")) { const select = wrapper.querySelector("select"); if (select) { const clean = select.cloneNode(true) as HTMLSelectElement; clean.value = select.value; wrapper.replaceWith(clean); } }
    const template = document.createElement("template"); template.innerHTML = markup;
    const patch = (old: Node, fresh: Node): void => {
      if (old.nodeType === Node.TEXT_NODE) { if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue; return; }
      if (!(old instanceof Element) || !(fresh instanceof Element)) return;
      // React owns this subtree, including textarea composition and undo history.
      if (old.hasAttribute("data-task-chat-owned") && fresh.hasAttribute("data-task-chat-owned")) return;
      // TaskPreviewView owns the live bitmap, dimensions and hidden state.
      // Resetting canvas attributes during a task snapshot erases its frame.
      if (old.tagName.toLowerCase() === "canvas" && old.getAttribute("class")?.split(/\s+/).includes("live-canvas")) return;
      if (old.isEqualNode(fresh)) return;
      const editor = old instanceof HTMLTextAreaElement && old.hasAttribute("data-editor-key");
      for (const attr of [...old.attributes]) if (!fresh.hasAttribute(attr.name) && !(editor && attr.name === "style")) old.removeAttribute(attr.name);
      for (const attr of [...fresh.attributes]) if (old.getAttribute(attr.name) !== attr.value && !(editor && attr.name === "style")) old.setAttribute(attr.name, attr.value);
      if (editor) return;
      children(old, fresh);
    };
    const children = (old: Node, fresh: Node): void => {
      const keyed = new Map([...old.childNodes].map(node => [keyOf(node), node]));
      let cursor = old.firstChild;
      for (const next of [...fresh.childNodes]) {
        const key = keyOf(next);
        let match: Node | undefined = key ? keyed.get(key) : cursor && compatible(cursor, next) ? cursor : undefined;
        if (match && !compatible(match, next)) match = undefined;
        if (key) keyed.delete(key);
        if (!match && next instanceof HTMLTextAreaElement && next.dataset.editorKey) match = this.editors.get(next.dataset.editorKey);
        if (match) { if (match !== cursor) old.insertBefore(match, cursor); patch(match, next); }
        else { match = next.cloneNode(false); old.insertBefore(match, cursor); patch(match, next); }
        cursor = match.nextSibling;
      }
      while (cursor) { const next = cursor.nextSibling; old.removeChild(cursor); cursor = next; }
    };
    children(this.root, template.content);
    this.page = page;
    for (const node of this.root.querySelectorAll<HTMLTextAreaElement>("textarea[data-editor-key]")) if (!node.closest("[data-task-chat-owned]")) this.editors.set(node.dataset.editorKey!, node);
  }
  restore(follow = true): void {
    const workspace = this.root.querySelector<HTMLElement>(".workspace"); if (!workspace) return;
    const saved = this.reading.get(this.page);
    if (saved) for (const detail of workspace.querySelectorAll<HTMLDetailsElement>("details[id]")) if (detail.id in saved.details) detail.open = saved.details[detail.id];
    // DOM patching removes workspace inline styles; restore these measurements
    // on every render before native scrolling or explicit reply positioning.
    syncTaskScrollInsets(workspace);
    const decision = workspace.querySelector<HTMLFormElement>("#reply-task")?.dataset.decisionId || "";
    if (decision && decision !== this.previousDecision && (!saved || saved.bottom)) revealTaskReply(workspace);
    else if (!saved && workspace.querySelector("#reply-task")) revealTaskReply(workspace);
    else if (saved?.bottom && follow || !saved && workspace.querySelector("#events")) scrollToTaskLatest(workspace);
    else if (saved) {
      workspace.scrollTop = saved.top;
      const anchor = saved.anchor && document.getElementById(saved.anchor);
      if (anchor && saved.offset !== undefined) workspace.scrollTop += anchor.getBoundingClientRect().top - workspace.getBoundingClientRect().top - saved.offset;
    } else workspace.scrollTop = 0;
  }
  forgetEditor(key: string): void { this.editors.delete(key); }
}

const measuredHeights = new WeakMap<HTMLTextAreaElement, number>();
export function autoGrow(field: HTMLTextAreaElement): void {
  if (!field.matches("[data-autogrow]")) return;
  const previous = measuredHeights.get(field), actual = field.getBoundingClientRect().height;
  if (previous && Math.abs(previous - actual) > 3 && actual > previous) field.dataset.manualHeight = String(actual);
  const manual = Number(field.dataset.manualHeight || 0);
  const minimum = field.dataset.autogrowMin === "44" ? 44 : 87;
  const limit = Math.max(100, Math.min(360, Math.round(window.innerHeight * .45)));
  const scroll = field.scrollTop;
  field.style.height = "auto";
  const height = Math.max(Math.min(manual, limit), Math.min(limit, Math.max(minimum, field.scrollHeight + 2)));
  field.style.height = `${height}px`; field.style.maxHeight = `${limit}px`; field.style.overflowY = field.scrollHeight > height ? "auto" : "hidden";
  field.scrollTop = scroll; measuredHeights.set(field, height);
}

export function installTaskTooltips(root: HTMLElement): () => void {
  let tip: HTMLElement | undefined, described: HTMLElement | undefined, oldDescription: string | null;
  const close = () => { tip?.remove(); tip = undefined; if (described) { if (oldDescription) described.setAttribute("aria-describedby", oldDescription); else described.removeAttribute("aria-describedby"); } described = undefined; };
  const show = (event: Event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[title]");
    if (!target?.title || !target.isConnected) return;
    if (described === target) return; close();
    tip = document.createElement("div"); tip.id = "task-focus-tooltip"; tip.className = "task-tooltip"; tip.setAttribute("role", "tooltip"); tip.textContent = target.title;
    document.body.append(tip); const rect = target.getBoundingClientRect();
    Object.assign(tip.style, { position: "fixed", left: `${Math.max(8, Math.min(rect.left, window.innerWidth - tip.offsetWidth - 8))}px`, top: `${Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - tip.offsetHeight - 8))}px`, zIndex: "1000" });
    described = target; oldDescription = target.getAttribute("aria-describedby"); target.setAttribute("aria-describedby", [oldDescription, tip.id].filter(Boolean).join(" "));
  };
  root.addEventListener("focusin", show); root.addEventListener("pointerover", show);
  root.addEventListener("focusout", close);
  root.addEventListener("pointerout", event => { if (!described?.contains(event.relatedTarget as Node | null)) close(); });
  root.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  document.addEventListener("pointerdown", close);
  document.addEventListener("visibilitychange", close);
  document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  new MutationObserver(() => {
    if (described && (!described.isConnected || !root.contains(described) || described.title !== tip?.textContent)) close();
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
  return close;
}
