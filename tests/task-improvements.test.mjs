import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const Module = require("node:module");

const moduleCache = new Map();
function loadTs(relPath) {
  const source = path.resolve(relPath);
  if (moduleCache.has(source)) return moduleCache.get(source);
  const built = esbuild.buildSync({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["electron", "exceljs", "pdfjs-dist", "@anthropic-ai/claude-agent-sdk"],
    logLevel: "silent"
  });
  const inst = new Module(source);
  inst.filename = source;
  inst.paths = Module._nodeModulePaths(path.dirname(source));
  inst._compile(built.outputFiles[0].text, source);
  moduleCache.set(source, inst.exports);
  return inst.exports;
}

const { CURRENT_PRICE_DATE, usageCharge, costTotals } = loadTs("src/shared/task-cost.ts");
const { tokenTotals, recordReviewTokenUsage } = loadTs("src/shared/task-token-usage.ts");
const { zonedLocalToIso, nextScheduleOccurrence, nextUpcomingOccurrence } = loadTs("src/shared/task-time.ts");
const { buildAnthropicMessagesUrl, providerEnvironment } = loadTs("src/main/tasks/provider.ts");
const { providerPricing, managedPriceVersion, KIMI_PRICE_VERSION, CUSTOM_PRICE_VERSION } = loadTs("src/main/tasks/pricing.ts");
const { redactReviewText } = loadTs("src/main/review/sources.ts");
const { readTaskTable, clearTaskTableCache, taskTableCacheStats } = loadTs("src/main/tasks/files.ts");
const { pruneContextScreenshots, PRUNED_SCREENSHOT_NOTE, taskModelContext } = loadTs("src/main/tasks/model-context.ts");
const { TaskStore } = loadTs("src/main/tasks/store.ts");
const { TaskService, MAX_INLINE_SCREENSHOTS_PER_RUN } = loadTs("src/main/tasks/service.ts");

test("Nov 2026+ pricing covers DeepSeek, Kimi, Claude, OpenAI, Gemini and custom user rates while preserving historical quotes", () => {
  const at = Date.parse("2026-11-17T02:00:00Z"); // Tuesday 02:00 UTC (DeepSeek peak)
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 };

  const dsFlash = usageCharge("c1", "model", "deepseek-flash", "https://api.deepseek.com/anthropic", at, at, usage);
  assert.equal(dsFlash.estimate.priceDate, CURRENT_PRICE_DATE);
  assert.equal(dsFlash.estimate.currency, "USD");
  assert.equal(dsFlash.estimate.min, 1.506);

  const dsChat = usageCharge("c2", "model", "deepseek-chat", "https://api.deepseek.com", at, at, usage);
  assert.equal(dsChat.estimate.currency, "USD");
  assert.ok(Math.abs(dsChat.estimate.min - (0.028 + 0.28 + 0.42)) < 1e-9);

  const kimi = usageCharge("c3", "model", "kimi-k2.7-code", "https://api.kimi.com/coding", at, at, usage);
  assert.equal(kimi.estimate.currency, "CNY");
  assert.ok(Math.abs(kimi.estimate.min - (1.3 + 6.5 + 27)) < 1e-9);

  const claude = usageCharge("c4", "model", "claude-sonnet-4-6", "https://api.anthropic.com", at, at, usage);
  assert.equal(claude.estimate.currency, "USD");
  assert.ok(Math.abs(claude.estimate.min - (0.3 + 3 + 15)) < 1e-9);

  const gpt = usageCharge("c5", "review", "gpt-4.1", "https://api.openai.com/v1", at, at, usage);
  assert.equal(gpt.estimate.currency, "USD");
  assert.ok(Math.abs(gpt.estimate.min - (0.5 + 2 + 8)) < 1e-9);

  const gemini = usageCharge("c6", "helper", "gemini-2.5-flash", "https://generativelanguage.googleapis.com", at, at, usage);
  assert.equal(gemini.estimate.currency, "USD");
  assert.ok(Math.abs(gemini.estimate.min - (0.075 + 0.3 + 2.5)) < 1e-9);

  const custom = usageCharge("c7", "review", "local-qwen-72b", "https://gateway.internal.test", at, at, usage, {
    customInputUsdPerMillion: 0.5,
    customOutputUsdPerMillion: 1.5
  });
  assert.equal(custom.estimate.currency, "USD");
  // 2M total input * 0.5 + 1M output * 1.5 = 2.5 USD
  assert.ok(Math.abs(custom.estimate.min - 2.5) < 1e-9);

  // SDK host pricing overrides for Kimi & Custom
  const kimiSdk = providerPricing({ baseUrl: "https://api.moonshot.cn/anthropic", model: "kimi-k3" });
  assert.ok(kimiSdk.modelPricing.overrides["kimi-k3"].input > 0);
  assert.equal(managedPriceVersion({ baseUrl: "https://api.moonshot.cn/anthropic", model: "kimi-k3" }), KIMI_PRICE_VERSION);

  const customSdk = providerPricing({ baseUrl: "https://custom.example/anthropic", model: "my-model", customInputUsdPerMillion: 1, customOutputUsdPerMillion: 4 });
  assert.deepEqual(customSdk.modelPricing.overrides["my-model"], { input: 1, output: 4, cacheRead: 1, cacheWrite: 1 });
  assert.equal(managedPriceVersion({ baseUrl: "https://custom.example/anthropic", model: "my-model", customInputUsdPerMillion: 1, customOutputUsdPerMillion: 4 }), CUSTOM_PRICE_VERSION);
});

test("Anthropic messages URL builder deduplicates /v1 and /v1/messages suffixes cleanly", () => {
  const cases = [
    ["https://api.anthropic.com", "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com/", "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com/v1", "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com/v1/", "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com/v1/messages/", "https://api.anthropic.com/v1/messages"],
    ["https://api.deepseek.com/anthropic", "https://api.deepseek.com/anthropic/v1/messages"],
    ["https://api.deepseek.com/anthropic/v1", "https://api.deepseek.com/anthropic/v1/messages"],
    ["https://api.deepseek.com/anthropic/v1/messages", "https://api.deepseek.com/anthropic/v1/messages"],
    ["https://api.kimi.com/coding/messages", "https://api.kimi.com/coding/v1/messages"]
  ];
  for (const [raw, expected] of cases) {
    assert.equal(buildAnthropicMessagesUrl(raw), expected, raw);
  }
  const env = providerEnvironment({ baseUrl: "https://api.deepseek.com/anthropic/v1/messages", model: "deepseek-chat", maxConcurrent: 2, retentionDays: 30, saveScreenshots: true, notifications: true, hasApiKey: true }, "secret", "/tmp/cwd");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
});

test("redactReviewText scrubs service URIs, JWTs, API keys, PEM blocks and query tokens", () => {
  const raw = [
    "DB=postgresql://admin:topSecret!@10.0.0.12:5432/appdb?sslmode=verify-full",
    "MONGO=mongodb+srv://svc:mongoSecret@cluster0.example.net/prod?retryWrites=true",
    "JWT=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoiYWRtaW4ifQ.signatureBytes1234567890",
    "ANTH=sk-ant-api03-SecretKeyMaterial1234567890abcdef",
    "AWS=AKIAIOSFODNN7EXAMPLE",
    "HF=hf_abcdefghijklmnopqrstuvwxyz1234",
    "NPM=npm_abcdefghijklmnopqrstuvwxyz1234",
    "URL=https://alice:pw123@dashboard.example.com/callback?code=oauthSecret#hashToken"
  ].join(" | ");
  const clean = redactReviewText(raw);
  for (const secret of ["topSecret", "sslmode", "mongoSecret", "signatureBytes1234567890", "SecretKeyMaterial", "AKIAIOSFODNN7EXAMPLE", "hf_abcdef", "npm_abcdef", "pw123", "oauthSecret", "hashToken"]) {
    assert.equal(clean.includes(secret), false, `expected ${secret} to be redacted`);
  }
  assert.match(clean, /postgresql:\/\/10\.0\.0\.12:5432\/appdb/);
  assert.match(clean, /https:\/\/dashboard\.example\.com\/callback/);
});

test("schedule recurrence math handles weekdays, weekly, one-shot re-enable, and 6-hour catch-up windows", async t => {
  // Friday 2026-11-20 09:00 Asia/Shanghai -> next weekdays should skip Saturday/Sunday to Monday 2026-11-23 09:00
  const friMorning = zonedLocalToIso("2026-11-20T09:00", "Asia/Shanghai");
  const nextWeekday = nextScheduleOccurrence(friMorning, "Asia/Shanghai", "weekdays", Date.parse(friMorning));
  assert.equal(nextWeekday, zonedLocalToIso("2026-11-23T09:00", "Asia/Shanghai"));

  // Weekly recurrence advances exactly 7 calendar days at the local wall-clock time
  const nextWeek = nextScheduleOccurrence(friMorning, "Asia/Shanghai", "weekly", Date.parse(friMorning));
  assert.equal(nextWeek, zonedLocalToIso("2026-11-27T09:00", "Asia/Shanghai"));

  // Re-enabling a past "once" schedule:
  // 1) When today's clock time is still ahead -> schedules for today!
  const oldOnce = zonedLocalToIso("2026-11-01T21:30", "Asia/Shanghai");
  const afternoonNow = Date.parse(zonedLocalToIso("2026-11-17T15:00", "Asia/Shanghai"));
  assert.equal(
    nextUpcomingOccurrence(oldOnce, "Asia/Shanghai", "once", afternoonNow),
    zonedLocalToIso("2026-11-17T21:30", "Asia/Shanghai")
  );
  // 2) When today's clock time has already passed -> schedules for tomorrow!
  const lateNightNow = Date.parse(zonedLocalToIso("2026-11-17T22:15", "Asia/Shanghai"));
  assert.equal(
    nextUpcomingOccurrence(oldOnce, "Asia/Shanghai", "once", lateNightNow),
    zonedLocalToIso("2026-11-18T21:30", "Asia/Shanghai")
  );

  // TaskService schedule catch-up window + re-enable integration
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-sched-imp-"));
  let clock = lateNightNow;
  const store = new TaskStore(root);
  const service = new TaskService(store, {
    browser: { control: async () => {} },
    apiKey: () => "",
    clock: () => clock,
    prepareProfile: async () => ({ name: "P", port: 9223 }),
    profileName: async () => "P",
    changed: () => {},
    notify: () => {}
  });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

  // Create a future once schedule, let it expire & disable, then re-enable without error!
  const created = service.saveSchedule({
    name: "晚间导出",
    task: { prompt: "导出今日统计", profileId: "__device__" },
    at: zonedLocalToIso("2026-11-18T21:30", "Asia/Shanghai"),
    timezone: "Asia/Shanghai",
    repeat: "once",
    enabled: true
  }, clock);
  store.data.schedules[0].at = oldOnce;
  store.data.schedules[0].enabled = false;
  const reenabled = service.saveSchedule({ ...store.data.schedules[0], enabled: true }, clock);
  assert.equal(reenabled.id, created.id);
  assert.equal(reenabled.at, zonedLocalToIso("2026-11-18T21:30", "Asia/Shanghai"));

  // Catch-up policy: 2 hours late with "run_within_window" executes; 2 hours late with "skip" skips
  store.data.schedules = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "补跑任务",
      task: { prompt: "睡眠唤醒补跑", profileId: "__device__" },
      at: new Date(clock - 2 * 3600_000).toISOString(),
      timezone: "Asia/Shanghai",
      repeat: "daily",
      catchUpPolicy: "run_within_window",
      enabled: true
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "跳过任务",
      task: { prompt: "不应补跑", profileId: "__device__" },
      at: new Date(clock - 2 * 3600_000).toISOString(),
      timezone: "Asia/Shanghai",
      repeat: "daily",
      catchUpPolicy: "skip",
      enabled: true
    }
  ];
  await service.tick();
  assert.ok(store.data.schedules[0].lastTaskId, "run_within_window caught up within 6h");
  assert.equal(store.data.schedules[0].missedAt, undefined);
  assert.equal(store.data.schedules[1].lastTaskId, undefined, "skip policy did not run 2h late");
  assert.ok(store.data.schedules[1].missedAt);
});

test("Excel/CSV workbook cache reuses parsed workbooks across paginated reads and invalidates on file change or TTL", async t => {
  const Excel = require("exceljs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-xlsx-cache-"));
  t.after(() => { clearTaskTableCache(); fs.rmSync(dir, { recursive: true, force: true }); });
  clearTaskTableCache();

  const xlsxPath = path.join(dir, "items.xlsx");
  const wb = new Excel.Workbook();
  const sheet = wb.addWorksheet("清单");
  sheet.addRow(["编号", "名称"]);
  for (let i = 1; i <= 10; i++) sheet.addRow([`ID-${i}`, `条目 ${i}`]);
  await wb.xlsx.writeFile(xlsxPath);

  const task = {
    id: "task-xlsx",
    attachments: [{ id: "att-1", name: "items.xlsx", path: xlsxPath, size: fs.statSync(xlsxPath).size }],
    outputs: []
  };

  const t0 = 1_700_000_000_000;
  const page1 = await readTaskTable(task, { attachmentId: "att-1", startRow: 1, count: 4 }, t0);
  assert.equal(page1.totalRows, 11);
  assert.equal(page1.nextRow, 5);
  assert.deepEqual(taskTableCacheStats(), { hits: 0, misses: 1, size: 1 });

  const page2 = await readTaskTable(task, { attachmentId: "att-1", startRow: 5, count: 4 }, t0 + 5_000);
  assert.equal(page2.rows[0][0], "ID-4");
  assert.deepEqual(taskTableCacheStats(), { hits: 1, misses: 1, size: 1 });

  // Expired after 60s TTL -> re-reads workbook
  await readTaskTable(task, { attachmentId: "att-1", startRow: 9, count: 4 }, t0 + 61_000);
  assert.deepEqual(taskTableCacheStats(), { hits: 1, misses: 2, size: 1 });
});

test("device-only tasks skip browser preparation, run multi-device tools, prune 20 screenshots, and record review tokens", async t => {
  // 1) Context screenshot pruning: 20 consecutive screenshot observations -> only last 3 retain base64
  const fakeBase64 = "data:image/png;base64," + "A".repeat(400);
  const twentyObservations = Array.from({ length: 20 }, (_, i) => ({
    id: `obs-${i}`,
    kind: "system",
    at: new Date().toISOString(),
    text: `Step ${i}: ${fakeBase64}`
  }));
  const pruned = pruneContextScreenshots(twentyObservations);
  assert.equal(pruned.length, 20);
  const withRawImage = pruned.filter(item => item.text.includes("AAAA"));
  const withNote = pruned.filter(item => item.text.includes(PRUNED_SCREENSHOT_NOTE));
  assert.equal(withRawImage.length, 3, "only the 3 most recent screenshots keep base64 bytes");
  assert.equal(withNote.length, 17, "older 17 screenshots are summarized");
  assert.equal(pruned[19].text.includes("AAAA"), true);
  assert.equal(pruned[0].text.includes("AAAA"), false);

  // Plain events keep exact reference identity for SDK transcript digests
  const plainEvent = { id: "u1", kind: "user", at: new Date().toISOString(), text: "普通文本消息" };
  assert.equal(pruneContextScreenshots([plainEvent])[0], plainEvent);

  // 2) Device-only task execution + multi-device tool bridge + live screenshot cap + review token ledger
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-device-bridge-"));
  const store = new TaskStore(root);
  Object.assign(store.data.settings, { jevEnabled: true, jevMode: "driver", hasApiKey: true });

  const cliCalls = [];
  let prepareBrowserCalled = false;
  let jevCalled = false;
  const service = new TaskService(store, {
    browser: {
      observe: async () => ({
        version: "v1",
        fingerprint: "fp1",
        at: new Date().toISOString(),
        url: "https://example.test",
        title: "Page",
        snapshot: "快照文本",
        account: "",
        screenshotDataUrl: fakeBase64
      }),
      observeFast: async () => { jevCalled = true; throw new Error("must skip Jev for __device__"); },
      execute: async () => "ok",
      tabs: async () => [],
      control: async () => {}
    },
    apiKey: () => "test-api-key",
    jevApiKey: () => "test-jev-key",
    prepareProfile: async () => { prepareBrowserCalled = true; return { name: "Browser", port: 9222 }; },
    profileName: async () => { throw new Error("must not look up browser profile for __device__"); },
    deviceRunner: async (args) => {
      cliCalls.push(args);
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, windows: [{ id: "win-1", title: "记事本 - 已就绪" }] }), stderr: "" };
    },
    worker: (_task, start) => {
      const child = new EventEmitter();
      child.connected = true; child.exitCode = null; child.signalCode = null;
      child.send = msg => {
        if (msg.kind === "start") {
          assert.equal(start.task.profileId, "__device__");
          queueMicrotask(() => {
            child.emit("message", { kind: "tool", id: "t1", name: "desktop_control", args: { operation: "windows" } });
          });
        } else if (msg.kind === "tool_result" && msg.id === "t1") {
          child.emit("message", { kind: "tool", id: "t2", name: "finish", args: { status: "completed", summary: "已读取桌面窗口", evidence: ["记事本 - 已就绪"], remaining: [] } });
        } else if (msg.kind === "tool_result" && msg.id === "t2") {
          child.emit("message", { kind: "result", success: true, result: "完成", costUsd: 0.01, inputTokens: 100, outputTokens: 30 });
          child.connected = false; child.exitCode = 0; child.emit("exit", 0);
        }
      };
      child.kill = () => { child.connected = false; child.exitCode = 0; child.emit("exit", 0); };
      return child;
    },
    changed: () => {},
    notify: () => {}
  });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const task = await service.create({ prompt: "打开并查看桌面窗口列表", profileId: "__device__" });
  for (let i = 0; i < 100 && service.runs.has(task.id); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(prepareBrowserCalled, false, "__device__ task never launches a browser");
  assert.equal(jevCalled, false, "__device__ task skips Jev fast-driver");
  assert.equal(task.status, "completed");
  assert.equal(cliCalls.length, 1);
  assert.ok(cliCalls[0].includes(`task-${task.id}`), "binds --session to task-<id>");
  assert.ok(cliCalls[0].includes("--task-id") && cliCalls[0].includes(task.id), "binds --task-id to task.id");

  // Verify live run inline screenshot cap on 20 consecutive observe(screenshot:true) calls
  const browserTask = store.create({ prompt: "截图巡检", profileId: "isolated:test" }, "Test");
  browserTask.port = 9222; browserTask.status = "running";
  const liveRun = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: "", repeatCount: 0 };
  service.runs.set(browserTask.id, liveRun);
  let imageBlocks = 0;
  for (let i = 0; i < 20; i++) {
    const obsRes = await service.handleTool(browserTask, liveRun, "observe", { screenshot: true });
    if (obsRes.content.some(b => b.type === "image")) imageBlocks++;
  }
  service.runs.delete(browserTask.id);
  browserTask.status = "completed";
  assert.equal(imageBlocks, MAX_INLINE_SCREENSHOTS_PER_RUN, "caps consecutive inline base64 screenshots per run");

  // Verify UsageReview token ledger integration in TaskStore
  store.data.tokenRecords = recordReviewTokenUsage(store.data.tokenRecords || [], {
    reportId: "33333333-3333-4333-8333-333333333333",
    kind: "daily",
    model: "claude-sonnet-4-6",
    inputTokens: 800,
    outputTokens: 200,
    charge: usageCharge("rev-1", "review", "claude-sonnet-4-6", "https://api.anthropic.com", Date.parse("2026-11-17T02:00:00Z"), Date.parse("2026-11-17T02:00:05Z"), { input_tokens: 800, output_tokens: 200 }),
    at: "2026-11-17T02:00:05.000Z"
  });
  store.save([]);
  assert.deepEqual(tokenTotals(store.data.tokenRecords, "review"), { input: 800, output: 200, total: 1000 });
  assert.equal(costTotals(store.data.tokenRecords, "review").calls, 1);
  assert.ok(taskModelContext(task).instruction.includes("不绑定浏览器"));
});
