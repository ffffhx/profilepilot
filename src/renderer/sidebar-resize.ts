type SidebarResizeOptions = {
  id: string;
  pane: string;
  property: string;
  preference: string;
  min: number;
  max: () => number;
};

export function sidebarResizeHandle(id: string, pane: string, label: string): string {
  return `<div class="sidebar-resize-handle" data-sidebar-resize="${id}" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="${pane}" aria-label="${label}" title="拖动调整宽度，双击恢复默认"></div>`;
}

// Capture on the document root: task snapshots can replace the sidebar DOM
// during a drag, and the shell's content lives in separate iframe documents.
export function installSidebarResize(options: SidebarResizeOptions): () => void {
  const root = document.documentElement;
  const selector = `[data-sidebar-resize="${options.id}"]`;
  let preferred: number | null = null;
  let drag: { pointer: number; x: number; width: number; moved: boolean } | undefined;
  const read = (value: string | null): number | null => value !== null && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  try { preferred = read(localStorage.getItem(options.preference)); } catch { /* Use responsive defaults. */ }
  const maximum = () => Math.max(options.min, options.max());
  const clamp = (width: number) => Math.round(Math.max(options.min, Math.min(maximum(), width)));
  const pane = () => document.querySelector<HTMLElement>(options.pane);
  function refresh(): void {
    if (preferred === null) root.style.removeProperty(options.property);
    else root.style.setProperty(options.property, `${clamp(preferred)}px`);
    const width = pane()?.getBoundingClientRect().width || 0;
    document.querySelectorAll<HTMLElement>(selector).forEach(handle => {
      handle.setAttribute("aria-valuemin", String(options.min));
      handle.setAttribute("aria-valuemax", String(Math.round(maximum())));
      handle.setAttribute("aria-valuenow", String(Math.round(width)));
      handle.setAttribute("aria-valuetext", `${Math.round(width)} 像素`);
    });
  }
  function save(): void {
    try {
      if (preferred === null) localStorage.removeItem(options.preference);
      else localStorage.setItem(options.preference, String(preferred));
    } catch { /* Resizing still works for this window. */ }
  }
  function finish(): void {
    if (!drag) return;
    const ended = drag;
    drag = undefined;
    delete root.dataset.sidebarResizing;
    if (root.hasPointerCapture(ended.pointer)) root.releasePointerCapture(ended.pointer);
    if (ended.moved) save();
    window.dispatchEvent(new Event("resize"));
  }
  document.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element) || !event.target.closest(selector)) return;
    const sidebar = pane();
    if (!sidebar || !sidebar.getBoundingClientRect().width) return;
    event.preventDefault();
    drag = { pointer: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width, moved: false };
    root.setPointerCapture(event.pointerId);
    root.dataset.sidebarResizing = options.id;
  });
  document.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (!drag.moved && Math.abs(event.clientX - drag.x) < 2) return;
    drag.moved = true;
    preferred = clamp(drag.width + event.clientX - drag.x);
    refresh();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    document.addEventListener(type, event => { if (drag?.pointer === event.pointerId) finish(); });
  }
  window.addEventListener("blur", finish);
  document.addEventListener("dblclick", event => {
    // Pointer capture can retarget the click to the root even after release.
    const target = event.target === root ? document.elementFromPoint(event.clientX, event.clientY) : event.target;
    if (!(target instanceof Element) || !target.closest(selector)) return;
    preferred = null; refresh(); save();
    window.dispatchEvent(new Event("resize"));
  });
  document.addEventListener("keydown", event => {
    if (!(event.target instanceof Element) || !event.target.closest(selector) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 8;
    const width = pane()?.getBoundingClientRect().width || options.min;
    preferred = clamp(event.key === "Home" ? options.min : event.key === "End" ? maximum() : width + (event.key === "ArrowLeft" ? -step : step));
    refresh(); save();
    window.dispatchEvent(new Event("resize"));
  });
  window.addEventListener("resize", refresh);
  window.addEventListener("storage", event => {
    if (event.key !== options.preference && event.key !== null) return;
    preferred = read(event.newValue); refresh();
  });
  refresh();
  return refresh;
}
