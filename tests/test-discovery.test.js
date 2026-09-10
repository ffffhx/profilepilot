const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { discoverTestFiles } = require("../scripts/test-files.cjs");

test("test discovery includes new and nested tests without executing index or helpers", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-test-discovery-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "nested"));
  for (const file of ["new.test.js", "nested/other.test.js", "index.js", "helper.js"]) {
    await fs.writeFile(path.join(root, file), "");
  }
  assert.deepEqual(discoverTestFiles(root).map(f => path.relative(root, f).replaceAll("\\", "/")), ["nested/other.test.js", "new.test.js"]);
});
