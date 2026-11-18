import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");
const { loadCli } = require("./cli-test-build.cjs");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: { write: (v) => { out += v; } },
      stderr: { write: (v) => { err += v; } }
    },
    out: () => out,
    err: () => err,
    json: () => JSON.parse(out || err)
  };
}

test("bundled preload.ts has zero relative requires and main.ts enables sandbox: true on all BrowserWindows", () => {
  const preloadOut = buildSync({
    entryPoints: [path.join(repoRoot, "src/preload.ts")],
    bundle: true,
    platform: "node",
    external: ["electron"],
    format: "cjs",
    target: "node22",
    write: false
  });
  const code = preloadOut.outputFiles[0].text;
  assert.doesNotMatch(code, /require\(["']\.\.?\//, "bundled preload must not contain relative require() calls");
  assert.match(code, /require\(["']electron["']\)/);
  for (const method of ["createProfile", "setMode", "compact", "fork", "rewind", "reviewSaveWorkflowTemplate"]) {
    assert.ok(code.includes(method), `bundled preload missing ${method}`);
  }

  const mainSource = fs.readFileSync(path.join(repoRoot, "src/main/main.ts"), "utf8");
  assert.doesNotMatch(mainSource, /sandbox:\s*false/, "main.ts must not contain sandbox: false");
  assert.equal((mainSource.match(/sandbox:\s*true/g) || []).length, 3, "all 3 BrowserWindows in main.ts must use sandbox: true");
});

test("all 6 control CLIs support pre-verb / post-verb routing flags, schema discovery, and structured ControlRecovery", async () => {
  const { parseBrowserCliRoute } = loadCli("src/main/browser-cli.ts");
  const { runElectronCli } = loadCli("src/main/electron-cli.ts");
  const { runDesktopCli } = loadCli("src/main/desktop/cli.ts");
  const { runGpuiCli } = loadCli("src/main/gpui/cli.ts");
  const { runPhoneCli } = loadCli("src/main/phones/cli.ts");
  const { runRemoteCli, parseRemoteCliArgs } = loadCli("src/main/remote-control-cli.ts");
  const { parseProfilePilotCliArgs } = loadCli("src/main/profilepilot-cli.ts");

  // 1) browser: trailing routing flags on zero-arity verbs hoist cleanly
  const hoisted = parseBrowserCliRoute(["status", "--session", "t1", "--cdp", "9222"]);
  assert.equal(hoisted.connection, "gateway");
  assert.equal(hoisted.port, 9222);
  assert.equal(hoisted.args[hoisted.commandIndex], "status");

  // Opaque arguments after page verbs are never touched
  const opaque = parseBrowserCliRoute(["--session", "t1", "--cdp", "9222", "fill", "@e1", "--cdp 9999"]);
  assert.equal(opaque.port, 9222);
  assert.deepEqual(opaque.args.slice(opaque.commandIndex), ["fill", "@e1", "--cdp 9999"]);

  // 2) profile create --browser edge
  const createCmd = parseProfilePilotCliArgs(["browser", "profile", "create", "--name", "EdgeDev", "--browser", "edge", "--json"]);
  assert.equal(createCmd.command.action, "profile.create");
  assert.equal(createCmd.command.name, "EdgeDev");
  assert.equal(createCmd.command.browserKind, "edge");

  // 3) desktop: leading --session before verb + inline --params + structured recovery
  const desktopCalls = [];
  const d1 = capture();
  assert.equal(
    await runDesktopCli(
      ["--session", "t1", "action", "--params", JSON.stringify({ version: "a".repeat(32), ref: "e1", kind: "invoke" }), "--json"],
      async (cmd) => {
        desktopCalls.push(cmd);
        return { version: 1, id: "1", ok: true, data: { executed: true } };
      },
      d1.io
    ),
    0
  );
  assert.equal(desktopCalls[0].method, "action");
  assert.equal(desktopCalls[0].session, "t1");
  assert.equal(desktopCalls[0].params.kind, "invoke");

  const dErr = capture();
  assert.equal(await runDesktopCli(["action", "--bad-flag"], async () => ({ version: 1, id: "1", ok: true, data: {} }), dErr.io), 2);
  assert.equal(dErr.json().recovery.automaticReplay, false);
  assert.equal(dErr.json().recovery.nextStep, "fix-input");

  // 4) gpui: leading --session + --params-stdin + structured recovery
  const gpuiCalls = [];
  const g1 = capture();
  assert.equal(
    await runGpuiCli(
      ["--session", "t1", "call", "--tool", "get_element", "--params-stdin", "--json"],
      async (cmd) => {
        gpuiCalls.push(cmd);
        return { version: 1, id: "1", ok: true, data: { result: { id: "btn" } } };
      },
      g1.io,
      Readable.from(['{"id":"btn"}'])
    ),
    0
  );
  assert.equal(gpuiCalls[0].session, "t1");
  assert.deepEqual(gpuiCalls[0].params, { id: "btn" });
  assert.equal(g1.json().ok, true);

  // 5) electron: logs command + leading --session on inspect + --params-stdin on configure
  const electronCalls = [];
  const eLogs = capture();
  assert.equal(
    await runElectronCli(["logs", "my-app", "--tail", "50", "--grep", "ready", "--json"], eLogs.io, {}, {
      request: async (cmd) => {
        electronCalls.push(cmd);
        return { version: 1, id: "1", ok: true, data: { id: "local-app:1", logs: "ready on 3000" } };
      }
    }),
    0
  );
  assert.deepEqual(electronCalls[0], { action: "local-app", method: "logs", selector: "my-app", tailLines: 50, grep: "ready" });

  const eCfg = capture();
  assert.equal(
    await runElectronCli(["configure", "my-app", "--params-stdin"], eCfg.io, {}, {
      stdin: Readable.from(['{"command":"npm run dev"}']),
      request: async (cmd) => {
        electronCalls.push(cmd);
        return { version: 1, id: "1", ok: true, data: { status: "configured" } };
      }
    }),
    0
  );
  assert.equal(electronCalls[1].method, "configure");
  assert.deepEqual(electronCalls[1].input, { command: "npm run dev" });

  // 6) phone: leading --device before verb works while keeping non-argv JSON contract
  const phoneCalls = [];
  const p1 = capture();
  assert.equal(
    await runPhoneCli(["--device", "pixel-8", "readiness", "--json"], async (cmd) => {
      phoneCalls.push(cmd);
      return { version: 1, id: "1", ok: true, data: { readyToStart: true } };
    }, p1.io),
    0
  );
  assert.equal(phoneCalls[0].method, "readiness");
  assert.equal(phoneCalls[0].params.id, "pixel-8");

  // 7) remote: local schema discovery + inline --params + structured recovery
  const rSchema = capture();
  assert.equal(await runRemoteCli(["schema", "window", "--json"], rSchema.io), 0);
  assert.equal(rSchema.json().result.group, "remote");
  assert.ok(rSchema.json().result.commands.window);

  const rParsed = parseRemoteCliArgs(["window", "action", "--session", "a".repeat(32), "--params", '{"kind":"invoke","ref":"e1"}']);
  assert.equal(rParsed.paramsInline, '{"kind":"invoke","ref":"e1"}');

  const rErr = capture();
  assert.equal(await runRemoteCli(["window", "action", "--bad"], rErr.io), 2);
  assert.equal(rErr.json().recovery.automaticReplay, false);
});
