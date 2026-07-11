const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");

// 主窗口 Profile 表格拖拽排序：加载 profiles.ts，只桩掉与排序无关的依赖。
// computeMainReorder 是纯函数；mainProfileGroups / sortByMainOrder 读取 store.state。
const store = { state: null };
const profiles = loadTsModule("src/renderer/render/profiles.ts", {
  stubs: {
    "../state": { store },
    "../busy": {},
    "./live-view": {},
    "../util": {}
  }
});
const { computeMainReorder, mainProfileGroups, sortByMainOrder } = profiles;

function group(key, memberIds) {
  return { key, memberIds };
}

// 单成员组（每个数据目录一个 isolated Profile，无子 Profile）—— 最常见形态。
function flatGroups() {
  return [group("iso:A", ["iso:A"]), group("iso:B", ["iso:B"]), group("iso:C", ["iso:C"])];
}

// 带子 Profile 的组：A 目录下有主 Profile + 两个子 Profile。
function nestedGroups() {
  return [group("iso:A", ["iso:A", "sub:A:1", "sub:A:2"]), group("iso:B", ["iso:B"])];
}

test("数据目录级：拖主行到目标组之后，整组随之移动", () => {
  const next = computeMainReorder(flatGroups(), "iso:A", "iso:C", false);
  assert.deepEqual(next, ["iso:B", "iso:C", "iso:A"]);
});

test("数据目录级：拖主行到目标组之前", () => {
  const next = computeMainReorder(flatGroups(), "iso:C", "iso:A", true);
  assert.deepEqual(next, ["iso:C", "iso:A", "iso:B"]);
});

test("数据目录级：拖主行时其下子 Profile 整块跟随", () => {
  const next = computeMainReorder(nestedGroups(), "iso:A", "iso:B", false);
  // A 组（含两个子 Profile）整体挪到 B 之后。
  assert.deepEqual(next, ["iso:B", "iso:A", "sub:A:1", "sub:A:2"]);
});

test("目录内：子 Profile 在本目录内重排", () => {
  const next = computeMainReorder(nestedGroups(), "sub:A:2", "sub:A:1", true);
  assert.deepEqual(next, ["iso:A", "sub:A:2", "sub:A:1", "iso:B"]);
});

test("目录内：子 Profile 不能排到主 Profile 之前（钳制到主行之后）", () => {
  const next = computeMainReorder(nestedGroups(), "sub:A:2", "iso:A", true);
  // 目标是主行且要插到其前，被钳制为主行之后，主 Profile 仍居首。
  assert.deepEqual(next, ["iso:A", "sub:A:2", "sub:A:1", "iso:B"]);
});

test("非法：子 Profile 拖到别的数据目录，返回 null（不跨目录）", () => {
  assert.equal(computeMainReorder(nestedGroups(), "sub:A:1", "iso:B", true), null);
});

test("非法：主行落回本组（拖到自己的子 Profile 上），返回 null", () => {
  assert.equal(computeMainReorder(nestedGroups(), "iso:A", "sub:A:1", false), null);
});

test("非法：落点即自身，返回 null", () => {
  assert.equal(computeMainReorder(flatGroups(), "iso:A", "iso:A", true), null);
});

test("mainProfileGroups：按 source+userDataDir 分组，子 Profile 归入父目录组", () => {
  store.state = {
    mainProfileOrder: [],
    profiles: [
      { id: "iso:A", source: "isolated", userDataDir: "/d/A" },
      { id: "iso:B", source: "isolated", userDataDir: "/d/B" },
      { id: "sub:A:1", source: "isolated-sub", userDataDir: "/d/A" }
    ]
  };
  const groups = mainProfileGroups(store.state.profiles);
  assert.deepEqual(
    groups.map((g) => g.memberIds),
    [["iso:A", "sub:A:1"], ["iso:B"]]
  );
  store.state = null;
});

test("sortByMainOrder：自定义顺序靠前，未列出的保持自然顺序排后", () => {
  store.state = { mainProfileOrder: ["iso:B"], profiles: [] };
  const input = [{ id: "iso:A" }, { id: "iso:B" }, { id: "iso:C" }];
  const sorted = sortByMainOrder(input).map((p) => p.id);
  assert.deepEqual(sorted, ["iso:B", "iso:A", "iso:C"]);
  store.state = null;
});
