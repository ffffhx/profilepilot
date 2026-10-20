import { LANGUAGES, errorMessage, send, type PageStatus, type Settings, type Response } from "./shared";
let tabId: number | undefined;
let settings: Settings;
let status: PageStatus | undefined;
const toggle = document.querySelector<HTMLButtonElement>("#toggle-page")!;
const statusText = document.querySelector<HTMLElement>("#page-status")!;
const siteMode = document.querySelector<HTMLSelectElement>("#site-mode")!;
const source = document.querySelector<HTMLSelectElement>("#popup-source")!;
const target = document.querySelector<HTMLSelectElement>("#popup-target")!;
function showError(error: unknown) { statusText.textContent = errorMessage(error); statusText.classList.add("error"); }
async function page<T>(type: string): Promise<T> {
  if (!tabId) throw new Error("请先打开一个普通网页。");
  let result: Response<T>;
  try { result = await chrome.tabs.sendMessage(tabId, { type }); }
  catch { throw new Error("此页面无法连接。安装后请刷新网页；浏览器内部页、商店和 PDF 查看器不支持。"); }
  if (!result?.ok) throw new Error(result?.error || "网页未响应。");
  return result.data as T;
}
function render() {
  if (!status) return;
  toggle.disabled = false;
  toggle.textContent = status.enabled ? "恢复原文" : "↗  翻译此页";
  statusText.classList.remove("error");
  statusText.textContent = status.error || (status.enabled ?
    `已翻译 ${status.translated} / ${status.total} 段${status.failed ? ` · ${status.failed} 段待重试` : ""}${status.cached ? ` · ${status.cached} 段缓存` : ""}` :
    "原文留在原处，译文随阅读出现。");
  if (status.error) statusText.classList.add("error");
}
async function refresh() { status = await page<PageStatus>("page:status"); render(); }
function openOptions() { void chrome.runtime.openOptionsPage(); }
document.querySelector("#open-options")!.addEventListener("click", openOptions);
document.querySelector("#change-provider")!.addEventListener("click", openOptions);
toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  try { status = await page<PageStatus>("page:toggle"); render(); }
  catch (error) { showError(error); toggle.disabled = false; }
});
siteMode.addEventListener("change", async () => {
  try {
    if (!status?.hostname) return;
    await send("site:update", { hostname: status.hostname, mode: siteMode.value });
    settings = await send("settings:get");
    if (siteMode.value === "auto") {
      await refresh();
      if (!status.enabled) status = await page<PageStatus>("page:toggle");
    }
    await refresh();
  } catch (error) { showError(error); }
});
async function changeLanguage() {
  try {
    settings = { ...settings, sourceLanguage: source.value, targetLanguage: target.value };
    await send("settings:save", settings); await refresh();
  } catch (error) { showError(error); }
}
source.addEventListener("change", changeLanguage); target.addEventListener("change", changeLanguage);
async function main() {
  for (const [code, label] of LANGUAGES) { source.add(new Option(label, code)); target.add(new Option(label, code)); }
  settings = await send<Settings>("settings:get");
  source.value = settings.sourceLanguage; target.value = settings.targetLanguage;
  document.querySelector("#provider-name")!.textContent = settings.provider === "browser" ? "浏览器本地翻译" : settings.model;
  document.querySelector("#provider-description")!.textContent = settings.provider === "browser" ? "文本在本机处理" : "你的自定义 AI 服务";
  if (navigator.platform.includes("Mac")) document.querySelector("#popup-shortcut")!.textContent = "⌥";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  document.querySelector("#page-host")!.textContent = tab?.url ? new URL(tab.url).hostname || "当前页面" : "当前页面";
  await refresh();
  if (status?.hostname) document.querySelector("#page-host")!.textContent = status.hostname;
  siteMode.value = settings.excludedSites.includes(status!.hostname) ? "exclude" : settings.autoSites.includes(status!.hostname) ? "auto" : "manual";
  setInterval(() => { void refresh().catch(() => {}); }, 1000);
}
void main().catch(error => { toggle.disabled = true; siteMode.disabled = true; showError(error); });
