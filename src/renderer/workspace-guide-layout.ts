export type GuideRect = { left: number; top: number; width: number; height: number };
export type GuideSide = "right" | "left" | "bottom" | "top";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

/** Prefer a nearby side, but avoid covering the highlighted control at viewport edges. */
export function guidePlacement(target: GuideRect, card: { width: number; height: number }, viewport: { width: number; height: number }, preferred: GuideSide = "right") {
  const margin = 12, gap = 16;
  const cx = target.left + target.width / 2, cy = target.top + target.height / 2;
  const positions = {
    right: { left: target.left + target.width + gap, top: cy - card.height / 2 },
    left: { left: target.left - card.width - gap, top: cy - card.height / 2 },
    bottom: { left: cx - card.width / 2, top: target.top + target.height + gap },
    top: { left: cx - card.width / 2, top: target.top - card.height - gap }
  };
  const order = [preferred, ...(["right", "left", "bottom", "top"] as GuideSide[]).filter(side => side !== preferred)];
  const candidates = order.map((side, priority) => {
    const ideal = positions[side];
    const left = clamp(ideal.left, margin, viewport.width - card.width - margin);
    const top = clamp(ideal.top, margin, viewport.height - card.height - margin);
    const overlap = Math.max(0, Math.min(left + card.width, target.left + target.width + 6) - Math.max(left, target.left - 6))
      * Math.max(0, Math.min(top + card.height, target.top + target.height + 6) - Math.max(top, target.top - 6));
    return { left, top, side,
      score: overlap * 10000 + Math.abs(left - ideal.left) + Math.abs(top - ideal.top) + priority };
  });
  return candidates.sort((a, b) => a.score - b.score)[0];
}
