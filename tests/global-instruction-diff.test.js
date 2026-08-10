const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");

function loadRenderer() {
  const store = {
    busy: false,
    state: { profiles: [] },
    selectedExtensionIds: new Set()
  };
  return loadTsModule("src/renderer/render/modals.ts", {
    stubs: {
      "../state": { store },
      "src/renderer/state": { store },
      "../busy": { isBusyAction: () => false },
      "src/renderer/busy": { isBusyAction: () => false }
    }
  });
}

test("global instruction editor renders a bounded add/remove preview", () => {
  const { renderGlobalInstructionDiff } = loadRenderer();
  const html = renderGlobalInstructionDiff(
    "first\nold rule\nlast",
    "first\nnew <rule>\nlast"
  );

  assert.match(html, /保存预览/);
  assert.match(html, /\+1 \/ −1 行/);
  assert.match(html, /class="remove">− old rule/);
  assert.match(html, /class="add">\+ new &lt;rule&gt;/);
});

test("global instruction editor makes a no-op save visible", () => {
  const { renderGlobalInstructionDiff } = loadRenderer();
  assert.match(renderGlobalInstructionDiff("same", "same"), /没有改动/);
});
