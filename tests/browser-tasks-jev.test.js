const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../dist/main/tasks/store");
const { TaskService } = require("../dist/main/tasks/service");
const { evaluateJevPage, jevPageState, JEV_QUESTIONS, JEV_MODEL } = require("../dist/main/tasks/jev");

const observation = () => ({ version: "page-1", fingerprint: "same", at: new Date().toISOString(), url: "https://example.test/form?token=private", title: "表单", snapshot: '- textbox "姓名" [ref=e1]\n- button "提交" [ref=e2]', account: "unknown" });
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pp-jev-test-"));
  const store = new TaskStore(root);
  const task = store.create({ prompt: "填写后让我检查", profileId: "isolated:test" }, "Test");
  let calls = 0;
  const browser = { observe: async () => observation(), execute: async () => { calls++; }, control: async () => {}, tabs: async () => [] };
  const service = new TaskService(store, { browser, apiKey: () => "main-key", jevApiKey: () => "fixture-jev-key", profileName: async () => "Test", prepareProfile: async () => ({ port: 9223, name: "Test" }), changed: () => {}, notify: () => {} });
  service.tick = async () => {};
  const run = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: "", repeatCount: 0 };
  service.runs.set(task.id, run); task.status = "running";
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, task, service, run, calls: () => calls };
}
function response(confidence = { page: 0.92, next: 0.9, consequence: 0.85 }) {
  const probabilities = (question, choice) => Object.fromEntries(Object.keys(JEV_QUESTIONS[question].criteria).map(key => [key, key === choice ? 1 : 0]));
  return { answers: {
    page: { type: "choice", choice: "form", probabilities: probabilities("page", "form") },
    next: { type: "choice", choice: "fill", probabilities: probabilities("next", "fill") },
    humanRequired: { type: "boolean", probability: 0.1 },
    consequence: { type: "score", score: 1, probabilities: { 0: 0, 1: 1, 2: 0, 3: 0 } }
  }, usage: { inputTokens: 230, outputTokens: 0 }, providerMetadata: { typesafe: { confidence } } };
}
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function directResponse(confidence) {
  const gateway = response(confidence);
  const answers = gateway.answers;
  for (const name of ["page", "next", "consequence"]) answers[name].confidence = gateway.providerMetadata.typesafe.confidence[name];
  answers.humanRequired = { type: "noul", noul: 0.1 };
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 230, output_tokens: 0 } };
}

test("TypeSafe direct is the default, uses noul, and normalizes answers and usage for the Agent", async t => {
  const f = fixture(t); let calls = 0;
  const result = await evaluateJevPage("fixture-typesafe", jevPageState(f.task, observation()), "v", { fetch: async (url, init) => {
    calls++; assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init.headers.Authorization, "Bearer fixture-typesafe"); assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "jev-latest"); assert.equal(body.questions.humanRequired.type, "noul");
    assert.equal(body.questions.page.type, "choice"); assert.equal(body.questions.consequence.type, "score");
    assert.equal(init.body.includes("fixture-typesafe"), false);
    return json(directResponse());
  } });
  assert.equal(calls, 1); assert.equal(result.status, "ready"); assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.inputTokens, 230); assert.equal(result.confidence.next, 0.9);
  assert.deepEqual(result.answers.humanRequired, { type: "boolean", probability: 0.1 });
});

test("TypeSafe missing confidence remains uncertain; invalid enums, probabilities and usage fail closed", async t => {
  const state = jevPageState(fixture(t).task, observation());
  const uncertain = await evaluateJevPage("key", state, "v", { fetch: async () => json(directResponse({})) });
  assert.equal(uncertain.status, "uncertain"); assert.equal(uncertain.answers.next.probabilities.fill, 1);
  for (const corrupt of [
    r => { r.answers.next.choice = "execute_code"; },
    r => { r.answers.page.probabilities.form = 2; },
    r => { delete r.answers.page.probabilities.login; },
    r => { r.answers.humanRequired.noul = -1; },
    r => { r.answers.next.confidence = 3; },
    r => { r.usage.input_tokens = "230"; }
  ]) {
    const body = directResponse(); corrupt(body);
    const result = await evaluateJevPage("secret", state, "v", { fetch: async () => json(body) });
    assert.equal(result.status, "unavailable"); assert.equal(result.answers, undefined);
  }
  for (const [status, expected] of [[401, /TypeSafe API Key/], [402, /TypeSafe 余额/], [429, /限流/], [529, /暂时不可用/]]) {
    let count = 0;
    const result = await evaluateJevPage("secret", state, "v", { fetch: async () => { count++; return new Response("secret body", { status }); } });
    assert.equal(count, 1); assert.match(result.note, expected); assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});

test("real AI SDK sends typed questions with explicit Gateway credentials and preserves confidence", async t => {
  const f = fixture(t); let count = 0;
  const result = await evaluateJevPage("fixture-jev-key", jevPageState(f.task, observation()), "page-1", { provider: "vercel", fetch: async (url, init) => {
    count++; assert.equal(String(url), "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer fixture-jev-key");
    assert.equal(headers.get("ai-model-id"), JEV_MODEL);
    const body = JSON.parse(init.body);
    assert.equal(body.questions.page.type, "choice"); assert.equal(Array.isArray(body.questions.page.criteria), false);
    assert.equal(Array.isArray(body.questions.consequence.criteria), true);
    assert.equal(body.providerOptions.gateway.zeroDataRetention, true);
    assert.equal(JSON.stringify(body).includes("fixture-jev-key"), false);
    return json(response());
  } });
  assert.equal(count, 1); assert.equal(result.status, "ready");
  assert.equal(result.confidence.next, 0.9); assert.equal(result.inputTokens, 230);
  assert.equal(result.answers.next.choice, "fill");
});

test("missing confidence cannot be replaced by an option's high probability", async t => {
  const f = fixture(t);
  const result = await evaluateJevPage("key", jevPageState(f.task, observation()), "v", { provider: "vercel", fetch: async () => json(response({})) });
  assert.equal(result.answers.next.probabilities.fill, 1); assert.equal(result.status, "uncertain");
});

test("malformed answers and HTTP errors safely fall back without leaking service details", async t => {
  const f = fixture(t); const state = jevPageState(f.task, observation());
  const bad = response(); bad.answers.next.choice = "execute_arbitrary_code";
  const malformed = await evaluateJevPage("secret", state, "v", { provider: "vercel", fetch: async () => json(bad) });
  assert.equal(malformed.status, "unavailable"); assert.equal(malformed.answers, undefined);
  let calls = 0;
  const limited = await evaluateJevPage("secret", state, "v", { provider: "vercel", fetch: async () => { calls++; return new Response(JSON.stringify({ error: "secret request body" }), { status: 429, headers: { "content-type": "application/json" } }); } });
  assert.equal(limited.status, "unavailable"); assert.equal(calls, 1);
  assert.equal(JSON.stringify(limited).includes("secret"), false);
});

test("evaluation timeout aborts the transport", async t => {
  const f = fixture(t); let aborted = false;
  const keepAlive = setTimeout(() => {}, 5000); t.after(() => clearTimeout(keepAlive));
  const result = await evaluateJevPage("key", jevPageState(f.task, observation()), "v", { timeoutMs: 35, fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => { aborted = true; reject(init.signal.reason); }, { once: true });
  }) });
  assert.equal(aborted, true); assert.equal(result.status, "unavailable");
});

test("Jev context excludes files, materials, URL secrets and full conversations", t => {
  const f = fixture(t);
  f.task.materials = [{ content: "PRIVATE-MATERIAL" }]; f.task.attachments = [{ path: "PRIVATE-PATH" }];
  f.task.events.push({ kind: "assistant", text: "PRIVATE-CONVERSATION" });
  const state = JSON.stringify(jevPageState(f.task, observation()));
  for (const value of ["PRIVATE-MATERIAL", "PRIVATE-PATH", "PRIVATE-CONVERSATION", "token=private"]) assert.equal(state.includes(value), false);
});

test("observe supplies Jev to the worker, reuses exact context, and never bypasses submission approval", async t => {
  const f = fixture(t); let count = 0;
  f.store.data.settings.jevEnabled = true;
  f.service.dependencies.evaluateJev = async (_key, state, version) => { count++; return { status: "ready", model: JEV_MODEL, version, elapsedMs: 12, inputTokens: 30, answers: response().answers, note: "advisory" }; };
  const first = await f.service.handleTool(f.task, f.run, "observe", {});
  assert.equal(JSON.parse(first.content[0].text).jev.status, "ready");
  await f.service.handleTool(f.task, f.run, "observe", {});
  assert.equal(count, 1); assert.equal(f.task.usage.jev.calls, 1);
  f.task.events.push({ kind: "user", text: "改成只读" });
  await f.service.handleTool(f.task, f.run, "observe", {}); assert.equal(count, 2);
  await f.service.handleTool(f.task, f.run, "browser_action", { version: "page-1", kind: "click", ref: "e2", effect: "submit", summary: "提交表单" });
  assert.equal(f.task.pending.kind, "confirmation"); assert.equal(f.calls(), 0);
});

test("disabled, missing-key, capped and failed Jev never block normal observation", async t => {
  const f = fixture(t); let count = 0;
  f.service.dependencies.evaluateJev = async (_key, _state, version) => { count++; return { status: "unavailable", model: JEV_MODEL, version, note: "暂不可用", elapsedMs: 10, inputTokens: 0 }; };
  await f.service.handleTool(f.task, f.run, "observe", {}); assert.equal(count, 0); assert.equal(f.task.observation.jev, undefined);
  f.store.data.settings.jevEnabled = true; f.service.dependencies.jevApiKey = () => "";
  await f.service.handleTool(f.task, f.run, "observe", {}); assert.equal(count, 0);
  f.service.dependencies.jevApiKey = () => "key"; f.task.usage.jev = { calls: 100, inputTokens: 0, elapsedMs: 0 };
  await f.service.handleTool(f.task, f.run, "observe", {}); assert.equal(count, 0);
  f.task.usage.jev.calls = 0;
  await f.service.handleTool(f.task, f.run, "observe", {}); await f.service.handleTool(f.task, f.run, "observe", {});
  assert.equal(count, 1); assert.equal(f.task.status, "running"); assert.equal(f.task.events.filter(e => e.text === "暂不可用").length, 1);
});

test("pause aborts an in-flight assessment and discards its observation", async t => {
  const f = fixture(t); f.store.data.settings.jevEnabled = true;
  let started; const ready = new Promise(resolve => { started = resolve; }); let aborted = false;
  f.service.dependencies.evaluateJev = (_key, _state, version, options) => new Promise(resolve => {
    started(); options.signal.addEventListener("abort", () => { aborted = true; resolve({ status: "unavailable", model: JEV_MODEL, version, elapsedMs: 1, inputTokens: 0, note: "stopped" }); });
  });
  const observing = f.service.handleTool(f.task, f.run, "observe", {});
  const rejected = assert.rejects(observing, /已停止/);
  await ready; await f.service.control(f.task.id, "pause"); await rejected;
  assert.equal(aborted, true); assert.equal(f.task.status, "paused"); assert.equal(f.task.observation, undefined);
});

test("provider and credential changes clear cached failures and discard stale in-flight results", async t => {
  const f = fixture(t); f.store.data.settings.jevEnabled = true; f.store.data.settings.jevProvider = "typesafe";
  const providers = [];
  f.service.dependencies.evaluateJev = async (_key, _state, version, options) => {
    providers.push(options.provider);
    return { status: "unavailable", model: "test", version, elapsedMs: 1, inputTokens: 0, note: "temporary" };
  };
  await f.service.handleTool(f.task, f.run, "observe", {});
  await f.service.handleTool(f.task, f.run, "observe", {});
  f.store.data.settings.jevProvider = "vercel";
  await f.service.handleTool(f.task, f.run, "observe", {});
  f.service.dependencies.jevApiKey = () => "replacement";
  await f.service.handleTool(f.task, f.run, "observe", {});
  assert.deepEqual(providers, ["typesafe", "vercel", "vercel"]);
  let finish; let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.service.dependencies.jevApiKey = () => "third-key";
  f.service.dependencies.evaluateJev = async () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.service.handleTool(f.task, f.run, "observe", {});
  await ready; f.store.data.settings.jevProvider = "typesafe";
  finish({ status: "ready", model: "stale-provider", elapsedMs: 1, inputTokens: 2 });
  const result = await pending;
  assert.equal(JSON.parse(result.content[0].text).jev, undefined);
});
