/** Keep row menus inside the page viewport, including the last row and zoomed UI. */
export function positionProfileMenu(): void {
  const menu = document.querySelector<HTMLElement>(".action-menu");
  const trigger = menu?.parentElement?.querySelector<HTMLElement>(".menu-button");
  if (!menu || !trigger) return;
  const margin = 8, gap = 6;
  const anchor = trigger.getBoundingClientRect();
  const width = Math.min(208, innerWidth - margin * 2);
  Object.assign(menu.style, { position: "fixed", right: "auto", width: `${width}px`, minWidth: "0", maxHeight: `${innerHeight - margin * 2}px`, overflowY: "auto", overflowX: "hidden" });
  const height = menu.getBoundingClientRect().height;
  const below = innerHeight - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const top = below >= height || below >= above ? anchor.bottom + gap : anchor.top - height - gap;
  Object.assign(menu.style, {
    left: `${Math.max(margin, Math.min(anchor.right - width, innerWidth - width - margin))}px`,
    top: `${Math.max(margin, Math.min(top, innerHeight - height - margin))}px`
  });
}

let pending = false;
function schedule(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; positionProfileMenu(); });
}
window.addEventListener("resize", schedule);
document.addEventListener("scroll", schedule, true);
