import { reconcileChildren } from "../dom-reconcile";

function key(node: Node): string {
  if (!(node instanceof Element)) return "";
  if (node.hasAttribute("data-dom-key")) return `view:${node.getAttribute("data-dom-key")}`;
  // Domain/profile changes must not reuse a different entity's form draft.
  const context = ["data-profile-id", "data-id", "data-domain", "data-dir", "data-browser-preview"].map(name => node.getAttribute(name) || "").join("|");
  if (node.id) return `${node.tagName}#${node.id}:${context}`;
  if (node.hasAttribute("data-action")) return `${node.tagName}:${node.getAttribute("data-action")}:${context}`;
  return context.replaceAll("|", "") ? `${node.tagName}:${context}` : "";
}

/** Keep existing controls, focus, selection, undo and scroll position. Only a
 * changed rendered value replaces a draft; ordinary status updates do not. */
export function patchBrowserDom(root: HTMLElement, markup: string): void {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const focused = root.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const patch = (current: Node, next: Node): void => {
    if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    if (!(current instanceof Element) || !(next instanceof Element)) return;
    // The live preview controller owns its frame, independently of app state.
    if (current.hasAttribute("data-browser-preview")) return;
    if (current.isEqualNode(next)) return;
    const input = current instanceof HTMLInputElement && next instanceof HTMLInputElement;
    const textarea = current instanceof HTMLTextAreaElement && next instanceof HTMLTextAreaElement;
    const select = current instanceof HTMLSelectElement && next instanceof HTMLSelectElement;
    const unchangedValue = input ? current.getAttribute("value") === next.getAttribute("value")
      : textarea ? current.defaultValue === next.defaultValue
      : select ? JSON.stringify([...current.options].filter(o => o.defaultSelected).map(o => o.value)) === JSON.stringify([...next.options].filter(o => o.defaultSelected).map(o => o.value)) : false;
    const selectedValue = select ? current.value : undefined;
    const unchangedChecked = input && current.defaultChecked === next.defaultChecked;
    const checked = input ? current.checked : false;
    for (const attr of [...current.attributes]) {
      if (current instanceof HTMLDetailsElement && attr.name === "open") continue;
      if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    }
    for (const attr of [...next.attributes]) {
      if (current instanceof HTMLDetailsElement && attr.name === "open") continue;
      if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    }
    if (input) {
      if (!unchangedValue && current.type !== "file" && current.value !== next.value) current.value = next.value;
      current.checked = unchangedChecked ? checked : next.checked;
      return;
    }
    if (textarea) {
      if (!unchangedValue) {
        // Avoid assigning the same value: it resets native editing history.
        if (current.value !== next.value) current.value = next.value;
        current.defaultValue = next.defaultValue;
      }
      return;
    }
    reconcileChildren(current, next, { key, patch });
    if (select) current.value = unchangedValue && [...current.options].some(o => o.value === selectedValue) ? selectedValue! : next.value;
  };
  reconcileChildren(root, template.content, { key, patch });
  if (focused?.isConnected && document.activeElement !== focused && !focused.matches(":disabled")) focused.focus({ preventScroll: true });
}
