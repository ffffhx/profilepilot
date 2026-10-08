const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execPortableCommand } = require("../dist/main/portable-command.js");
const options = { encoding: "utf8", windowsHide: true, timeout: 3000 };

test("a slow CLI probe leaves the event loop responsive", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const output = await execPortableCommand(process.execPath, ["-e", "setTimeout(() => console.log('probe 1.2.3'), 200)"], options);
    assert.equal(output.trim(), "probe 1.2.3");
    assert.ok(ticks > 0, "other main-process work must run while a CLI is being inspected");
  } finally { clearInterval(timer); }
});

test("CLI probe failures and timeouts reject instead of reporting an installed version", async () => {
  await assert.rejects(execPortableCommand(process.execPath, ["-e", "process.stderr.write('probe failed'); process.exitCode = 7"], options), error => error.code === 7 && /probe failed/.test(error.message));
  await assert.rejects(execPortableCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, timeout: 100 }), error => error.killed === true);
});

test("Windows CLI shims with spaces still use the portable command route", { skip: process.platform !== "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profilepilot async probe "));
  try {
    const shim = path.join(directory, "fake tool.cmd");
    await fs.writeFile(shim, "@echo off\r\nif not \"%~1\"==\"--version\" exit /b 7\r\necho shim 2.3.4\r\n");
    assert.equal((await execPortableCommand(shim, ["--version"], options)).trim(), "shim 2.3.4");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
