import { cacheClear, cacheGet, cachePut, cacheStats, pruneCache } from "./cache";
import { translateRemote, validateRequest } from "./provider";
import { DEFAULT_SETTINGS, TEST_SENTENCES, cacheIdentity, errorMessage, fingerprint, publicSettings, validateSettings, type Settings, type TranslationRequest, type TranslationResult } from "./shared";

async function settings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  return validateSettings({ ...DEFAULT_SETTINGS, ...stored.settings });
}
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "translate-selection", title: "用双语伴读翻译选中文字", contexts: ["selection"] });
  });
  if (reason === "install") await chrome.runtime.openOptionsPage();
});
chrome.commands.onCommand.addListener(async command => {
  if (command !== "toggle-translation") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "page:toggle" }).catch(() => {});
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "translate-selection" && tab?.id && info.selectionText) {
    await chrome.tabs.sendMessage(tab.id, { type: "page:selection", text: info.selectionText.slice(0, 10000) }).catch(() => {});
  }
});
const inFlight = new Map<string, Promise<TranslationResult[]>>();
let lastPrune = 0;
async function translate(request: TranslationRequest): Promise<TranslationResult[]> {
  const s = await settings();
  if (s.provider !== "custom") throw new Error("请在网页中启用本地翻译。");
  if (request.sourceLanguage !== s.sourceLanguage || request.targetLanguage !== s.targetLanguage) throw new Error("翻译设置已改变，请重新开启翻译。");
  const allowed = await chrome.permissions.contains({ origins: [new URL(s.endpoint).origin + "/*"] });
  if (!allowed) throw new Error("尚未授权翻译接口，请在设置中保存并授权。");
  const keys = await Promise.all(request.segments.map(segment => fingerprint(cacheIdentity(s, segment.text, request.context, request.sourceLanguage, request.targetLanguage))));
  const cached = await Promise.all(keys.map(key => cacheGet(key)));
  const missing = request.segments.filter((_, index) => !cached[index]);
  const translated = new Map<string, string>();
  if (missing.length) {
    const identity = await fingerprint([keys, missing.map(segment => segment.id)]);
    let task = inFlight.get(identity);
    if (!task) {
      task = translateRemote(s, { ...request, segments: missing });
      inFlight.set(identity, task);
    }
    try { for (const result of await task) translated.set(result.id, result.text); }
    finally { inFlight.delete(identity); }
  }
  const results: TranslationResult[] = [];
  for (let i = 0; i < request.segments.length; i++) {
    const segment = request.segments[i];
    const text = cached[i] || translated.get(segment.id);
    if (!text) throw new Error("翻译结果不完整。");
    if (!cached[i]) await cachePut(keys[i], text);
    results.push({ id: segment.id, text, cached: Boolean(cached[i]) });
  }
  if (Date.now() - lastPrune > 60000) { lastPrune = Date.now(); await pruneCache(); }
  return results;
}
async function dispatch(message: { type: string; payload?: any }, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) throw new Error("未知消息来源。");
  // An options page opened in a tab also has sender.tab. Trust its browser-provided
  // extension URL, never the absence of a tab or a field supplied by the message.
  const trusted = Boolean(sender.url?.startsWith(chrome.runtime.getURL("")));
  switch (message.type) {
    case "settings:public": return publicSettings(await settings());
    case "settings:get":
      if (!trusted) throw new Error("仅设置页面可以读取密钥。");
      return settings();
    case "settings:save": {
      if (!trusted) throw new Error("仅设置页面可以更新配置。");
      const next = validateSettings(message.payload);
      await chrome.storage.local.set({ settings: next });
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) if (tab.id) void chrome.tabs.sendMessage(tab.id, { type: "page:settings", settings: publicSettings(next) }).catch(() => {});
      return publicSettings(next);
    }
    case "site:update": {
      if (!trusted) throw new Error("仅扩展页面可以修改站点规则。");
      const s = await settings();
      const { hostname, mode } = message.payload || {};
      if (typeof hostname !== "string" || !["manual", "auto", "exclude"].includes(mode)) throw new Error("无效站点规则。");
      s.autoSites = s.autoSites.filter(site => site !== hostname);
      s.excludedSites = s.excludedSites.filter(site => site !== hostname);
      if (mode === "auto") s.autoSites.push(hostname);
      if (mode === "exclude") s.excludedSites.push(hostname);
      return dispatch({ type: "settings:save", payload: s }, sender);
    }
    case "translate": return translate(validateRequest(message.payload));
    case "cache:get": {
      if (typeof message.payload?.key !== "string" || !/^[a-f0-9]{64}$/.test(message.payload.key)) throw new Error("无效缓存键。");
      return cacheGet(message.payload.key);
    }
    case "cache:put": {
      const { key, text } = message.payload || {};
      if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) || typeof text !== "string" || text.length > 40000) throw new Error("无效缓存内容。");
      await cachePut(key, text);
      if (Date.now() - lastPrune > 60000) { lastPrune = Date.now(); await pruneCache(); }
      return null;
    }
    case "cache:stats":
      if (!trusted) throw new Error("仅扩展页面可以管理缓存。");
      return cacheStats();
    case "cache:clear":
      if (!trusted) throw new Error("仅扩展页面可以管理缓存。");
      await cacheClear(); return null;
    case "provider:test": {
      if (!trusted) throw new Error("仅设置页面可以测试接口。");
      const s = validateSettings(message.payload);
      if (s.provider !== "custom") throw new Error("本地引擎请在设置页面直接测试。");
      if (!await chrome.permissions.contains({ origins: [new URL(s.endpoint).origin + "/*"] })) throw new Error("请先授权接口域名。");
      return translateRemote(s, { segments: [{ id: "test", text: TEST_SENTENCES[s.sourceLanguage] }], context: "", sourceLanguage: s.sourceLanguage, targetLanguage: s.targetLanguage });
    }
    case "options:open": await chrome.runtime.openOptionsPage(); return null;
    default: throw new Error("未知扩展操作。");
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== "string" || message.type.startsWith("page:")) return;
  dispatch(message, sender).then(data => reply({ ok: true, data }), error => reply({ ok: false, error: errorMessage(error) }));
  return true;
});
