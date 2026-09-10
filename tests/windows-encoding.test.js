const assert = require("node:assert/strict");
const test = require("node:test");
const { runWindowsPowerShell } = require("../dist/main/windows-platform.js");

test("Windows PowerShell preserves Unicode in actual subprocess JSON output", { skip: process.platform !== "win32" }, async () => {
  const output = await runWindowsPowerShell("[pscustomobject]@{ path='C:\\用户目录\\测试 Profile\\浏览器'; title='中文 🙂' } | ConvertTo-Json -Compress");
  assert.deepEqual(JSON.parse(output), { path: "C:\\用户目录\\测试 Profile\\浏览器", title: "中文 🙂" });
});
