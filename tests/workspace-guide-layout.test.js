const test = require('node:test');
const assert = require('node:assert/strict');
const { guidePlacement } = require('../dist/renderer/workspace-guide-layout');
const intersects = (a, b) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

test('tour card fits beside controls at every viewport edge without covering them', () => {
  for (const viewport of [{ width: 1120, height: 760 }, { width: 688, height: 480 }, { width: 448, height: 480 }]) {
    for (const target of [
      { left: 10, top: 82, width: 44, height: 45 },
      { left: viewport.width - 120, top: 80, width: 100, height: 38 },
      { left: 20, top: viewport.height - 65, width: 100, height: 38 },
      { left: 120, top: 10, width: 150, height: 35 }
    ]) {
      const card = { width: 336, height: 245 };
      const result = guidePlacement(target, card, viewport);
      assert.ok(result.left >= 12 && result.top >= 12);
      assert.ok(result.left + card.width <= viewport.width - 12);
      assert.ok(result.top + card.height <= viewport.height - 12);
      assert.equal(intersects(target, { ...result, ...card }), 0, JSON.stringify({ target, result, viewport }));
    }
  }
});

test('preferred direction is retained when it fits and changes when it would hide the target', () => {
  const card = { width: 336, height: 240 }, viewport = { width: 1120, height: 760 };
  const target = { left: 410, top: 330, width: 100, height: 40 };
  for (const side of ['left', 'right', 'top', 'bottom']) assert.equal(guidePlacement(target, card, viewport, side).side, side);
  assert.equal(guidePlacement({ ...target, left: 1000 }, card, viewport, 'right').side, 'left');
});
