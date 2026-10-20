import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DEFAULT_SETTINGS, publicSettings, normalizeEndpoint, validateSettings, cacheIdentity, fingerprint, collectBlocks, splitText, createTranslation, Reader, parseTranslations, translateRemote, validateRequest, NativeEngine } from "../artifacts/test-lib.mjs";

function dom(html) {
  const window = new JSDOM(`<!doctype html><html lang="en"><head><title>Test article</title></head><body>${html}</body></html>`, { url: "https://article.example/read", pretendToBeVisual: true }).window;
  for (const key of ["window", "document", "Node", "NodeFilter", "Element", "HTMLElement", "MutationObserver", "location"]) globalThis[key] = key === "window" ? window : window[key];
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.innerWidth = 1280; globalThis.innerHeight = 900;
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.closed = false; }
    observe(target) { queueMicrotask(() => { if (!this.closed) this.callback([{ target, isIntersecting: true }]); }); }
    unobserve() {}
    disconnect() { this.closed = true; }
  };
  return window;
}
const custom = () => publicSettings({ ...DEFAULT_SETTINGS, provider: "custom", endpoint: "https://model.example/v1/chat/completions", model: "test" });
function bridge(handler) {
  const requests = [];
  return {
    requests,
    async translate(request) { requests.push(request); return handler ? handler(request) : request.segments.map(s => ({ id: s.id, text: "译文：" + s.text })); },
    async cacheGet() {}, async cachePut() {}, openSettings() {}
  };
}
async function until(condition, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!condition()) { if (Date.now() > deadline) throw new Error("Timed out waiting for observed state"); await new Promise(resolve => setTimeout(resolve, 15)); }
}

test("endpoint normalization supports full URLs, v1 bases and localhost; rejects credential/query/non-HTTPS leaks", () => {
  assert.equal(normalizeEndpoint("https://model.example/v1/"), "https://model.example/v1/chat/completions");
  assert.equal(normalizeEndpoint("https://model.example/api/v1/chat/completions"), "https://model.example/api/v1/chat/completions");
  assert.equal(normalizeEndpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1/chat/completions");
  for (const url of ["http://remote.example", "https://user:secret@model.example", "https://model.example?key=secret", "file:///etc/passwd"]) assert.throws(() => normalizeEndpoint(url));
});
test("public settings and exports omit credentials; cache identity separates context, glossary, model and language", async () => {
  const settings = { ...DEFAULT_SETTINGS, apiKey: "SECRET" };
  assert.equal(JSON.stringify(publicSettings(settings)).includes("SECRET"), false);
  const key = await fingerprint(cacheIdentity(settings, "Hello", "Title", "en", "zh"));
  for (const [change, context, source, target] of [
    [{ model: "other" }, "Title", "en", "zh"], [{ glossary: "Hello = 你好" }, "Title", "en", "zh"],
    [{}, "Other title", "en", "zh"], [{}, "Title", "en", "ja"]
  ]) assert.notEqual(await fingerprint(cacheIdentity({ ...settings, ...change }, "Hello", context, source, target)), key);
  assert.throws(() => validateSettings({ sourceLanguage: "en", targetLanguage: "en" }));
  assert.throws(() => validateSettings({ provider: "custom" }));
  assert.throws(() => validateSettings({ excludedSites: ["https://private.example"] }), /站点规则/);
  assert.throws(() => validateSettings({ excludedSites: ["private.example:443"] }), /站点规则/);
});
test("extracts semantic paragraphs once, preserves inline code tokens and excludes UI/editor/code/navigation", () => {
  const window = dom(`<nav>Navigation links</nav><article><h1>A useful heading</h1>
  <p>Hello <strong>brave</strong> readers. Use <code>request()</code> today.</p>
  <div><p>Nested content stays together.</p></div><ul><li>First item</li><li>Second item</li></ul>
  <pre>let secret = 1;</pre><textarea>Draft message</textarea><div contenteditable="true">Editable draft</div>
  <p translate="no">Do not translate</p><p hidden>Hidden content</p><div data-bilingual-reader="translation">Existing translated text</div></article>`);
  const blocks = collectBlocks(document.body);
  assert.equal(blocks.length, 5);
  assert.ok(blocks.find(b => b.text.includes("brave") && b.text.includes("⟦BR0⟧") && b.tokens[0] === "request()"));
  assert.equal(blocks.filter(b => b.text.includes("Nested")).length, 1);
  assert.ok(!blocks.some(b => /Navigation|Draft|Editable|secret|Hidden|Existing/.test(b.text)));
  window.close();
});
test("model text cannot inject markup or scripts; code placeholders render as local code nodes", () => {
  const window = dom("");
  const translation = createTranslation('<img src=x onerror="alert(1)"> ⟦BR0⟧', ["<script>evil()</script>"]);
  document.body.append(translation);
  assert.equal(translation.querySelector("img"), null);
  assert.equal(translation.querySelector("script"), null);
  assert.equal(translation.querySelector("code").textContent, "<script>evil()</script>");
  window.close();
});
test("article headers remain translatable and descendants of hidden containers are excluded", () => {
  const window = dom('<header>Global menu</header><article><header><h1>Article title</h1></header><div style="display:none"><p>Hidden drawer content.</p></div><p>Visible article body.</p></article>');
  const texts = collectBlocks(document.body).map(block => block.text);
  assert.deepEqual(texts, ["Article title", "Visible article body."]);
  window.close();
});
test("long paragraphs retain all non-space content across bounded chunks", () => {
  const source = ("A long paragraph has meaningful content and ⟦BR0⟧. ").repeat(1200);
  const chunks = splitText(source);
  assert.ok(chunks.length > 8);
  assert.ok(chunks.every(c => c.length <= 5500));
  assert.equal(chunks.join("").replace(/\s/g, ""), source.replace(/\s/g, ""));
});
test("translation results are aligned by id; missing, duplicate and extra results are rejected", () => {
  const good = '```json\n{"translations":[{"id":"b","text":"乙"},{"id":"a","text":"甲"}]}\n```';
  assert.deepEqual(parseTranslations(good, ["a", "b"]), [{ id: "a", text: "甲" }, { id: "b", text: "乙" }]);
  for (const content of ['{}', 'not JSON', '[{"id":"a","text":"甲"},{"id":"a","text":"乙"}]', '[{"id":"a","text":""}]']) assert.throws(() => parseTranslations(content, ["a", "b"]));
  assert.throws(() => validateRequest({ segments: [{ id: "x", text: "A" }, { id: "x", text: "B" }], context: "", sourceLanguage: "en", targetLanguage: "zh" }));
});
test("remote provider sends only intended context, refuses redirects, reports authentication errors without echoing secrets", async () => {
  const settings = { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "https://model.example/v1", model: "test-model", apiKey: "SECRET" };
  const request = { segments: [{ id: "x", text: "Hello" }], context: "Article", sourceLanguage: "en", targetLanguage: "zh" };
  const translated = await translateRemote(settings, request, async (url, options) => {
    assert.equal(url, "https://model.example/v1/chat/completions");
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, "Bearer SECRET");
    assert.equal(JSON.parse(options.body).messages[1].content.includes("SECRET"), false);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"translations":[{"id":"x","text":"你好"}]}' } }] }));
  });
  assert.equal(translated[0].text, "你好");
  let calls = 0;
  await assert.rejects(translateRemote(settings, request, async () => { calls++; return new Response("SECRET", { status: 401 }); }), /401/);
  assert.equal(calls, 1);
});
test("reader translates, preserves original clickable nodes and restores the original DOM", async () => {
  const window = dom('<article><h1>Hello world</h1><p>Read <a href="/docs">the docs</a> with <code>fetch()</code>.</p></article>');
  const original = document.body.innerHTML;
  const link = document.querySelector("a"); let clicks = 0;
  link.addEventListener("click", event => { event.preventDefault(); clicks++; });
  const adapter = bridge(); const reader = new Reader(custom(), adapter);
  await reader.start(); await until(() => reader.status.translated === 2);
  assert.equal(document.querySelector("a"), link); link.click(); assert.equal(clicks, 1);
  assert.equal(document.querySelectorAll('[data-bilingual-reader="translation"]').length, 2);
  assert.ok(adapter.requests.length < 3);
  reader.stop(); assert.equal(document.body.innerHTML, original);
  reader.destroy(); window.close();
});
test("dynamic additions and source edits translate once, with no observer feedback loop", async () => {
  const window = dom('<main><p id="first">The first paragraph.</p></main>');
  const adapter = bridge(); const reader = new Reader(custom(), adapter);
  await reader.start(); await until(() => reader.status.translated === 1);
  const paragraph = document.createElement("p"); paragraph.textContent = "A dynamically loaded paragraph.";
  document.querySelector("main").append(paragraph);
  await until(() => reader.status.translated === 2);
  document.querySelector("#first").firstChild.textContent = "Changed source text.";
  await until(() => document.querySelector("#first .br-translation")?.textContent.includes("Changed source"));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(adapter.requests.flatMap(r => r.segments).length, 3);
  assert.equal(document.querySelectorAll(".br-translation").length, 2);
  reader.destroy(); window.close();
});
test("late response after disabling translation never modifies the page", async () => {
  const window = dom("<p>Slow model response.</p>");
  let release;
  const adapter = bridge(request => new Promise(resolve => { release = () => resolve(request.segments.map(s => ({ id: s.id, text: "延迟结果" }))); }));
  const reader = new Reader(custom(), adapter);
  await reader.start(); await until(() => Boolean(release)); reader.stop(); release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(document.querySelectorAll(".br-translation").length, 0);
  reader.destroy(); window.close();
});
test("late response for changed source is discarded and replaced by translation of the new content", async () => {
  const window = dom('<p id="changing">Old content.</p>');
  let release;
  const adapter = bridge(request => {
    if (request.segments.some(s => s.text === "Old content.")) return new Promise(resolve => { release = () => resolve(request.segments.map(s => ({ id: s.id, text: "OLD" }))); });
    return request.segments.map(s => ({ id: s.id, text: "NEW:" + s.text }));
  });
  const reader = new Reader(custom(), adapter);
  await reader.start(); await until(() => Boolean(release));
  document.querySelector("#changing").textContent = "New content.";
  await until(() => document.querySelector(".br-translation")?.textContent.startsWith("NEW:"));
  release(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(document.querySelectorAll(".br-translation").length, 1);
  assert.equal(document.querySelector(".br-translation").textContent, "NEW:New content.");
  reader.destroy(); window.close();
});
test("failed requests expose retry and successful retry replaces the failure", async () => {
  const window = dom("<p>Retry this paragraph.</p>");
  let attempts = 0;
  const adapter = bridge(request => {
    if (++attempts === 1) throw new Error("Temporary failure");
    return request.segments.map(s => ({ id: s.id, text: "已重试" }));
  });
  const reader = new Reader(custom(), adapter);
  await reader.start(); await until(() => reader.status.failed === 1);
  assert.equal(reader.status.error, "Temporary failure");
  reader.retry(); await until(() => reader.status.translated === 1);
  assert.equal(reader.status.failed, 0);
  reader.destroy(); window.close();
});
test("excluded sites never start translation", async () => {
  const window = dom("<p>Keep this site private.</p>");
  const adapter = bridge();
  const reader = new Reader({ ...custom(), excludedSites: ["article.example"] }, adapter);
  await assert.rejects(reader.start(), /排除/);
  assert.equal(adapter.requests.length, 0);
  reader.destroy(); window.close();
});
test("native translation protects inline code locally even when the model rewrites sentinels", async () => {
  const calls = [];
  globalThis.Translator = {
    async availability() { return "available"; },
    async create() { return { async translate(text) { calls.push(text); return "译:" + text.replace(/⟦.*?⟧/g, "corrupted"); }, destroy() {} }; }
  };
  const native = new NativeEngine();
  await native.prepare("en", "zh");
  const result = await native.translate("Call ⟦BR0⟧ to fetch data.");
  assert.ok(result.includes("⟦BR0⟧"));
  assert.ok(calls.every(text => !text.includes("⟦")));
  native.destroy(); delete globalThis.Translator;
});
test("AI responses with damaged code placeholders fail before entering the cache", async () => {
  const settings = { ...DEFAULT_SETTINGS, endpoint: "https://model.example/v1", model: "test" };
  await assert.rejects(translateRemote(settings, {
    segments: [{ id: "code", text: "Use ⟦BR0⟧." }], context: "", sourceLanguage: "en", targetLanguage: "zh"
  }, async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"translations":[{"id":"code","text":"请使用已破坏的标记"}]}' } }] }))), /代码标记/);
});
