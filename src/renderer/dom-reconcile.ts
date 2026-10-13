export interface ReconcileOptions {
  key(node: Node): string;
  patch(current: Node, next: Node, created?: boolean): void;
  recover?(next: Node): Node | undefined;
}

/** Reuse keyed children across insertions/reordering. Each view decides which
 * attributes and child content it owns; the reconciliation algorithm is shared. */
export function reconcileChildren(parent: Node, nextParent: Node, options: ReconcileOptions): void {
  const compatible = (a: Node, b: Node): boolean => a.nodeType === b.nodeType &&
    (!(a instanceof Element) || b instanceof Element && a.tagName === b.tagName && (a.namespaceURI || null) === (b.namespaceURI || null) && options.key(a) === options.key(b));
  const keyed = new Map<string, Node[]>();
  for (const node of [...parent.childNodes]) {
    const key = options.key(node);
    if (key) keyed.set(key, [...(keyed.get(key) || []), node]);
  }
  let cursor = parent.firstChild;
  for (const next of [...nextParent.childNodes]) {
    const key = options.key(next);
    let current = key ? keyed.get(key)?.shift() : cursor && compatible(cursor, next) ? cursor : undefined;
    if (current && !compatible(current, next)) current = undefined;
    if (!current) current = options.recover?.(next);
    if (current) {
      if (current !== cursor) parent.insertBefore(current, cursor);
      options.patch(current, next);
    } else {
      current = next.cloneNode(false);
      parent.insertBefore(current, cursor);
      options.patch(current, next, true);
    }
    cursor = current.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; parent.removeChild(cursor); cursor = next; }
}
