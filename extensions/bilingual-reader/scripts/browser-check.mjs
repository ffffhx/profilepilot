// All browser operations stay inside the user's ProfilePilot Gateway session.
// Usage: node scripts/browser-check.mjs inspect|capture|integration --port 9225 --session NAME --extension ID
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { root } from "./build.mjs";
const argument = name => process.argv[process.argv.indexOf("--" + name) + 1];
const port = argument("port"), session = argument("session"), extension = argument("extension");
if (!/^\d+$/.test(port || "") || !session || !/^[a-p]{32}$/.test(extension || "")) throw new Error("Supply the actual Gateway port, session and loaded extension id.");
const cli = process.env.BILINGUAL_READER_PPILOT_CLI || path.resolve(root, "../../dist/main/profilepilot-cli.cjs");
const artifacts = path.join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
let controlInterrupted = false;
let restoreSettings;
function cdp(method, params = {}, target) {
  const args = [cli, "browser", "--session", session, "--cdp", port, "cdp", "call", method, "--params-stdin"];
  if (target) args.push("--target", target);
  const result = spawnSync(process.execPath, args, { input: JSON.stringify(params), encoding: "utf8", windowsHide: true, timeout: 35000, maxBuffer: 12 * 1024 * 1024 });
  if (result.error) { controlInterrupted = true; throw result.error; }
  if (result.status !== 0) { controlInterrupted = true; throw new Error(result.stderr || result.stdout); }
  const parsed = JSON.parse(result.stdout);
  if (!parsed.ok) { controlInterrupted = true; throw new Error(JSON.stringify(parsed)); }
  return parsed.result;
}
function evaluate(target, expression, userGesture = false) {
  const result = cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, target);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
function targets() { return cdp("Target.getTargets").targetInfos; }
const optionsUrl = `chrome-extension://${extension}/options.html`;
const options = targets().find(target => target.url === optionsUrl);
const optionsId = options?.targetId || cdp("Target.createTarget", { url: optionsUrl }).targetId;
const rpc = (type, payload) => evaluate(optionsId, `chrome.runtime.sendMessage(${JSON.stringify({ type, payload })})`);
async function waitFor(check, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Timed out: " + description);
}
async function capture(target, filename) {
  const screenshot = cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, target);
  await writeFile(path.join(artifacts, filename), Buffer.from(screenshot.data, "base64"));
  return filename;
}
const mode = process.argv[2];
await waitFor(() => evaluate(optionsId, "document.readyState==='complete' && Boolean(document.querySelector('#settings-form'))"), "options page");
try {
if (mode === "state") {
  console.log(JSON.stringify(evaluate(optionsId, `(async()=>({test:document.querySelector('#test-result').textContent,testDisabled:document.querySelector('#test-provider').disabled,save:document.querySelector('#save-status').textContent,permission:await chrome.permissions.contains({origins:['http://127.0.0.1:43821/*']}),native:typeof Translator==='undefined'?'missing':await Translator.availability({sourceLanguage:'en',targetLanguage:'zh'})}))()`), null, 2));
} else if (mode === "inspect") {
  console.log(JSON.stringify(evaluate(optionsId, `(async()=>({title:document.title,body:document.body.innerText,dimensions:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth},native:typeof Translator==='undefined'?'missing':await Translator.availability({sourceLanguage:'en',targetLanguage:'zh'}),userAgent:navigator.userAgent}))()`), null, 2));
  console.log(await capture(optionsId, "settings.png"));
} else if (mode === "capture") {
  console.log(await capture(optionsId, "settings.png"));
} else if (mode === "native") {
  evaluate(optionsId, `document.querySelector('#test-provider').click();true`, true);
  console.log("Native test started. Inspect the same page for the download/result state.");
} else if (mode === "popup") {
  const original = rpc("settings:get");
  assert.equal(original.ok, true);
  restoreSettings = original.data;
  assert.equal(rpc("settings:save", { ...original.data, provider: "browser", sourceLanguage: "en", targetLanguage: "zh", autoSites: [], excludedSites: [] }).ok, true);
  const previousTargets = new Set(targets().map(target => target.targetId));
  const created = evaluate(optionsId, `chrome.tabs.create({url:'http://127.0.0.1:43821/fixture.html?popup',active:true})`);
  evaluate(optionsId, `chrome.windows.update(${created.windowId},{focused:true}).then(()=>true)`);
  const fixture = await waitFor(() => targets().find(target => target.url.endsWith("/fixture.html?popup") && !previousTargets.has(target.targetId)), "popup fixture");
  const page = type => evaluate(optionsId, `chrome.tabs.sendMessage(${created.id},${JSON.stringify({ type })}).catch(e=>({ok:false,error:e.message}))`);
  await waitFor(() => page("page:status").ok, "popup fixture content script");
  evaluate(optionsId, `chrome.action.openPopup({windowId:${created.windowId}}).then(()=>true)`, true);
  const popup = await waitFor(() => targets().find(target => target.url === `chrome-extension://${extension}/popup.html`), "action popup");
  const inspect = () => evaluate(popup.targetId, `({text:document.querySelector('#page-status').textContent,disabled:document.querySelector('#toggle-page').disabled,source:document.querySelector('#popup-source').value,target:document.querySelector('#popup-target').value,host:document.querySelector('#page-host').textContent})`);
  const initial = await waitFor(() => { const state = inspect(); return !state.disabled ? state : null; }, "popup ready");
  assert.equal(initial.source, "en"); assert.equal(initial.target, "zh");
  assert.equal(initial.host, "127.0.0.1");
  evaluate(popup.targetId, `document.querySelector('#toggle-page').click();true`, true);
  await waitFor(() => { const state = page("page:status").data; return state?.translated > 0 && state.pending === 0; }, "popup translation", 20000);
  await waitFor(() => evaluate(popup.targetId, `document.querySelector('#toggle-page').textContent==='恢复原文'`), "popup active label");
  try { await capture(popup.targetId, "popup.png"); } catch (error) { console.log("Screenshot unavailable: " + error.message); }
  evaluate(popup.targetId, `(()=>{const select=document.querySelector('#site-mode');select.value='exclude';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`, true);
  await waitFor(() => page("page:status").data?.enabled === false, "popup exclusion");
  assert.ok(rpc("settings:get").data.excludedSites.includes("127.0.0.1"));
  evaluate(popup.targetId, `(()=>{const select=document.querySelector('#site-mode');select.value='auto';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`, true);
  await waitFor(() => page("page:status").data?.enabled === true, "popup automatic translation");
  evaluate(popup.targetId, `document.querySelector('#toggle-page').click();true`, true);
  await waitFor(() => page("page:status").data?.enabled === false, "popup restores original");
  assert.equal(evaluate(fixture.targetId, "document.querySelectorAll('.br-translation').length"), 0);
  assert.equal(rpc("settings:save", original.data).ok, true);
  restoreSettings = undefined;
  const result = { date: new Date().toISOString(), initial, translation: true, exclusion: true, automaticTranslation: true, restored: true };
  await writeFile(path.join(artifacts, "popup-verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  evaluate(popup.targetId, "window.close();true");
} else if (mode === "prepare-remote") {
  evaluate(optionsId, `chrome.tabs.getCurrent().then(tab=>chrome.tabs.update(tab.id,{active:true})).then(()=>true)`);
  console.log(evaluate(optionsId, `(()=>{const provider=document.querySelector('input[name=provider][value=custom]');provider.click();document.querySelector('[name=endpoint]').value='http://127.0.0.1:43821/v1';document.querySelector('[name=model]').value='deterministic-test-fixture';document.querySelector('[name=apiKey]').value='';document.querySelector('#settings-form').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#test-provider').click();return 'Endpoint permission requested through the settings UI.';})()`, true));
} else if (mode === "live") {
  const results = [];
  for (const url of ["https://example.com/", "https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver", "https://www.typescriptlang.org/docs/handbook/intro.html"]) {
    const previousTargets = new Set(targets().map(target => target.targetId));
    const created = evaluate(optionsId, `chrome.tabs.create({url:${JSON.stringify(url)},active:true})`);
    const target = await waitFor(() => targets().find(target => target.type === "page" && !previousTargets.has(target.targetId) && target.url.startsWith(new URL(url).origin)), "public page target", 20000);
    const page = type => evaluate(optionsId, `chrome.tabs.sendMessage(${created.id},${JSON.stringify({ type })}).catch(e=>({ok:false,error:e.message}))`);
    await waitFor(() => page("page:status").ok, "public content script", 20000);
    await waitFor(() => evaluate(target.targetId, "document.readyState==='complete'"), "public page loaded", 20000);
    await new Promise(resolve => setTimeout(resolve, 600));
    const original = evaluate(target.targetId, `({code:[...document.querySelectorAll('pre')].map(e=>e.textContent),links:[...document.querySelectorAll('a')].map(e=>e.href)})`);
    assert.equal(page("page:toggle").ok, true);
    const status = await waitFor(() => {
      const state = page("page:status").data;
      if (state?.error) throw new Error(state.error);
      return state?.translated > 0 && state.pending === 0 ? state : null;
    }, "public page translation", 20000);
    const translated = evaluate(target.targetId, `({title:document.title,count:document.querySelectorAll('.br-translation').length,han:[...document.querySelectorAll('.br-translation')].some(e=>/\\p{Script=Han}/u.test(e.textContent)),code:[...document.querySelectorAll('pre')].map(e=>e.textContent),codeTranslations:document.querySelectorAll('pre .br-translation').length,links:[...document.querySelectorAll('a')].map(e=>e.href)})`);
    assert.ok(translated.han); assert.ok(translated.count > 0);
    assert.ok(original.code.every(text => translated.code.includes(text)));
    assert.ok(original.links.every(href => translated.links.includes(href)));
    assert.equal(translated.codeTranslations, 0);
    assert.equal(page("page:toggle").ok, true);
    assert.equal(evaluate(target.targetId, "document.querySelectorAll('.br-translation').length"), 0);
    results.push({ url, title: translated.title, status, restored: true, linksAndCodePreserved: true });
    console.log(JSON.stringify(results.at(-1)));
    await writeFile(path.join(artifacts, "live-site-verification.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  }
  await writeFile(path.join(artifacts, "live-site-verification.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
} else if (mode === "native-integration") {
  const settings = rpc("settings:get").data;
  restoreSettings = settings;
  assert.equal(rpc("settings:save", { ...settings, provider: "browser", sourceLanguage: "en", targetLanguage: "zh", autoSites: [], excludedSites: [] }).ok, true);
  assert.equal(rpc("cache:clear").ok, true);
  const previousTargets = new Set(targets().map(target => target.targetId));
  const created = evaluate(optionsId, `chrome.tabs.create({url:'http://127.0.0.1:43821/fixture.html?native',active:true})`);
  evaluate(optionsId, `chrome.windows.update(${created.windowId},{focused:true}).then(()=>true)`);
  const fixture = await waitFor(() => targets().find(target => target.url.endsWith("/fixture.html?native") && !previousTargets.has(target.targetId)), "native fixture tab");
  const fixtureId = fixture.targetId;
  const page = type => evaluate(optionsId, `chrome.tabs.sendMessage(${created.id},${JSON.stringify({ type })}).catch(e=>({ok:false,error:e.message}))`);
  await waitFor(() => page("page:status").ok, "native content script");
  assert.equal(page("page:toggle").ok, true);
  let lastNativeStatus;
  const first = await waitFor(() => {
    const status = page("page:status").data;
    lastNativeStatus = status;
    if (status?.error) throw new Error(status.error);
    return status?.translated > 2 && status.pending === 0 ? status : null;
  }, "native viewport translation", 20000).catch(error => {
    console.log(JSON.stringify({ lastNativeStatus, page: evaluate(fixtureId, `({visibility:document.visibilityState,focused:document.hasFocus(),ui:document.querySelector('[data-bilingual-reader="ui"]')?.shadowRoot?.textContent.slice(-2000)})`) }, null, 2));
    throw error;
  });
  evaluate(fixtureId, "window.scrollTo(0,document.body.scrollHeight);true");
  const final = await waitFor(() => {
    const status = page("page:status").data;
    if (status?.error) throw new Error(status.error);
    return status?.translated === status?.total ? status : null;
  }, "native full article", 20000);
  const evidence = evaluate(fixtureId, `({translations:[...document.querySelectorAll('.br-translation')].map(e=>e.textContent),code:document.querySelector('pre').textContent,link:document.querySelector('main a').href,inlineCode:document.querySelector('.br-translation code')?.textContent})`);
  assert.ok(evidence.translations.every(text => /\p{Script=Han}/u.test(text)));
  assert.equal(evidence.inlineCode, "requestAnimationFrame()");
  evaluate(fixtureId, "document.querySelector('#add-paragraph').click();true", true);
  await waitFor(() => page("page:status").data.translated > final.translated, "native dynamic paragraph", 20000);
  assert.equal(page("page:toggle").ok, true);
  assert.equal(evaluate(fixtureId, "document.querySelectorAll('.br-translation').length"), 0);
  assert.equal(page("page:toggle").ok, true);
  const cached = await waitFor(() => {
    const status = page("page:status").data;
    return status.cached > 0 && status.pending === 0 ? status : null;
  }, "native cache reuse");
  evaluate(fixtureId, "window.scrollTo(0,0);true");
  await writeFile(path.join(artifacts, "native-verification.json"), JSON.stringify({ date: new Date().toISOString(), first, final, cached, evidence }, null, 2));
  console.log(JSON.stringify({ first, final, cached, evidence }, null, 2));
  try { console.log(await capture(fixtureId, "native-translation.png")); } catch (error) { console.log("Screenshot unavailable: " + error.message); }
} else if (mode === "integration") {
  const results = [];
  const original = rpc("settings:get");
  assert.equal(original.ok, true);
  restoreSettings = original.data;
  const testSettings = { ...original.data, provider: "custom", endpoint: "http://127.0.0.1:43821/v1/chat/completions", apiKey: "", model: "deterministic-test-fixture", sourceLanguage: "en", targetLanguage: "zh", autoSites: [], excludedSites: [] };
  // The user grants this exact endpoint through the settings page before this check.
  const granted = evaluate(optionsId, `chrome.permissions.contains({origins:['http://127.0.0.1:43821/*']})`);
  assert.equal(granted, true, "Test endpoint permission must be granted");
  assert.equal(rpc("settings:save", testSettings).ok, true);
  assert.equal(rpc("cache:clear").ok, true);
  const previousTargets = new Set(targets().map(target => target.targetId));
  const created = evaluate(optionsId, `chrome.tabs.create({url:'http://127.0.0.1:43821/fixture.html',active:true})`);
  evaluate(optionsId, `chrome.windows.update(${created.windowId},{focused:true}).then(()=>true)`);
  const fixture = await waitFor(() => targets().find(target => target.url === "http://127.0.0.1:43821/fixture.html" && !previousTargets.has(target.targetId)), "fixture tab");
  const fixtureId = fixture.targetId;
  const tab = created.id;
  const page = type => evaluate(optionsId, `chrome.tabs.sendMessage(${tab},${JSON.stringify({ type })}).catch(e=>({ok:false,error:e.message}))`);
  await waitFor(() => page("page:status").ok, "content script");
  const before = evaluate(fixtureId, `({html:document.querySelector('main').innerHTML,code:document.querySelector('pre').textContent,href:document.querySelector('main a').getAttribute('href')})`);
  assert.equal(page("page:toggle").ok, true);
  const first = await waitFor(() => {
    const response = page("page:status");
    if (response.data?.failed) throw new Error(response.data.error);
    return response.data?.translated > 2 && response.data.pending === 0 ? response.data : null;
  }, "first translated viewport");
  results.push({ check: "extension content script → service worker → HTTP provider → DOM", pass: true, first });
  evaluate(fixtureId, "window.scrollTo(0,document.body.scrollHeight);true");
  await waitFor(() => { const s = page("page:status").data; return s.translated === s.total && s.pending === 0; }, "remaining paragraphs");
  assert.equal(evaluate(fixtureId, "document.querySelector('pre').textContent"), before.code);
  assert.equal(evaluate(fixtureId, "document.querySelector('main a').getAttribute('href')"), before.href);
  assert.ok(evaluate(fixtureId, `document.querySelector('main').textContent.includes('专注的艺术')`));
  results.push({ check: "scroll loading, original links and code blocks", pass: true });
  await capture(fixtureId, "translated-article.png");
  const firstCount = page("page:status").data.translated;
  evaluate(fixtureId, "document.querySelector('#add-paragraph').click();true", true);
  await waitFor(() => page("page:status").data.translated > firstCount, "dynamic paragraph");
  results.push({ check: "dynamic DOM insertion", pass: true });
  evaluate(fixtureId, `document.querySelector('main>p').firstChild.textContent='A changed paragraph should receive a fresh translation.';true`);
  evaluate(fixtureId, `document.querySelector('main>p').scrollIntoView({block:'center'});true`);
  await waitFor(() => evaluate(fixtureId, `document.querySelector('main>p .br-translation')?.textContent==='发生变化的段落应当获得新的译文。'`), "changed source");
  results.push({ check: "source mutation invalidates translation", pass: true });
  const selection = evaluate(optionsId, `chrome.tabs.sendMessage(${tab},{type:'page:selection',text:'Reading opens a window to the world.'})`);
  assert.equal(selection.ok, true);
  assert.ok(evaluate(fixtureId, `document.querySelector('[data-bilingual-reader="ui"]').shadowRoot.querySelector('.answer').textContent.includes('阅读为我们')`));
  results.push({ check: "selection translation", pass: true });
  assert.equal(page("page:toggle").ok, true);
  assert.equal(evaluate(fixtureId, "document.querySelectorAll('.br-translation').length"), 0);
  assert.equal(evaluate(fixtureId, "document.querySelector('pre').textContent"), before.code);
  results.push({ check: "restore original DOM", pass: true });
  const requestsBefore = await fetch("http://127.0.0.1:43821/health").then(r => r.json()).then(r => r.requests);
  assert.equal(page("page:toggle").ok, true);
  await waitFor(() => { const s = page("page:status").data; return s.translated > 0 && s.pending === 0; }, "cache replay");
  const cachedStatus = page("page:status").data;
  const requestsAfter = await fetch("http://127.0.0.1:43821/health").then(r => r.json()).then(r => r.requests);
  assert.ok(cachedStatus.cached > 0);
  assert.equal(requestsAfter, requestsBefore);
  results.push({ check: "IndexedDB cache reuses translations without a new API request", pass: true, cached: cachedStatus.cached });
  assert.equal(rpc("site:update", { hostname: "127.0.0.1", mode: "exclude" }).ok, true);
  await waitFor(() => page("page:status").data.enabled === false, "site exclusion");
  assert.equal(page("page:toggle").ok, false);
  results.push({ check: "site exclusion stops and prevents translation", pass: true });
  // Restore the actual user-facing provider, not the deterministic integration fixture.
  assert.equal(rpc("settings:save", original.data).ok, true);
  restoreSettings = undefined;
  assert.equal(rpc("cache:clear").ok, true);
  cdp("Page.reload", {}, optionsId);
  await waitFor(() => evaluate(optionsId, "document.readyState==='complete'"), "options reload");
  const readback = rpc("settings:get");
  assert.equal(readback.data.provider, original.data.provider);
  assert.equal(readback.data.endpoint, original.data.endpoint);
  results.push({ check: "settings persist and fixture configuration restored", pass: true });
  await writeFile(path.join(artifacts, "browser-verification.json"), JSON.stringify({ date: new Date().toISOString(), extension, results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} else throw new Error("Unknown mode.");
} finally {
  // Never perform cleanup through a takeover, timeout, disconnect or Gateway stop.
  // Credentials stay in process memory; no settings object is written as evidence.
  if (restoreSettings && !controlInterrupted) {
    assert.equal(rpc("settings:save", restoreSettings).ok, true, "Restore original settings after verification");
  }
}
