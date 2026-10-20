import { NativeEngine } from "./native";
import { DEFAULT_SETTINGS, LANGUAGES, TEST_SENTENCES, errorMessage, publicSettings, send, validateSettings, type Settings, type TranslationResult } from "./shared";

const extension = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const status = document.querySelector<HTMLElement>("#save-status")!;
const testResult = document.querySelector<HTMLElement>("#test-result")!;
let saved = { ...DEFAULT_SETTINGS };
const native = new NativeEngine();
function field(name: string) { return form.elements.namedItem(name) as HTMLInputElement; }
function announce(text: string, error = false) { status.textContent = text; status.classList.toggle("error", error); }
function fillLanguages(select: HTMLSelectElement, selected: string) {
  select.replaceChildren(...LANGUAGES.map(([value, label]) => {
    const option = new Option(label, value); option.selected = value === selected; return option;
  }));
}
function populate(settings: Settings) {
  for (const [name, value] of Object.entries(settings)) {
    if (name === "provider" || name === "style") {
      const input = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
      if (input) input.checked = true;
    } else {
      const input = field(name);
      if (!input) continue;
      if (input.type === "checkbox") input.checked = Boolean(value);
      else input.value = Array.isArray(value) ? value.join("\n") : String(value);
    }
  }
  updatePreview();
}
function collect(): Settings {
  const data = new FormData(form);
  return validateSettings({
    provider: data.get("provider") as Settings["provider"],
    sourceLanguage: String(data.get("sourceLanguage")),
    targetLanguage: String(data.get("targetLanguage")),
    endpoint: String(data.get("endpoint") || ""), model: String(data.get("model") || ""),
    apiKey: String(data.get("apiKey") || ""), glossary: String(data.get("glossary") || ""),
    style: data.get("style") as Settings["style"],
    fontSize: Number(data.get("fontSize")), concurrency: Number(data.get("concurrency")),
    selectionEnabled: data.has("selectionEnabled"),
    autoSites: String(data.get("autoSites") || "").split(/\r?\n/),
    excludedSites: String(data.get("excludedSites") || "").split(/\r?\n/)
  });
}
function updatePreview() {
  const provider = (form.querySelector('input[name="provider"]:checked') as HTMLInputElement).value;
  document.querySelector<HTMLElement>("#custom-fields")!.hidden = provider !== "custom";
  document.querySelector<HTMLElement>("#native-info")!.hidden = provider !== "browser";
  const style = (form.querySelector('input[name="style"]:checked') as HTMLInputElement).value;
  const size = Number(field("fontSize").value);
  document.querySelector("#font-output")!.textContent = size + "%";
  const sample = document.querySelector<HTMLElement>("#sample-translation")!;
  sample.style.cssText = `font-size:${13 * size / 100}px;`;
  if (style === "card") Object.assign(sample.style, { background: "#e9f0e3", padding: "10px", borderRadius: "5px" });
  if (style === "underline") Object.assign(sample.style, { borderLeft: "none", paddingLeft: "0", borderBottom: "1px dashed #a5b497", paddingBottom: "9px" });
}
async function grant(settings: Settings) {
  if (!extension || settings.provider !== "custom") return;
  // This call is made directly from the save/test click to preserve user activation.
  const granted = await chrome.permissions.request({ origins: [new URL(settings.endpoint).origin + "/*"] });
  if (!granted) throw new Error("接口域名未授权，设置尚未保存。");
}
async function updateCacheCount() {
  const count = extension ? (await send<{ count: number }>("cache:stats")).count : 0;
  document.querySelector("#cache-count")!.textContent = `${count.toLocaleString()} 条翻译缓存 · 导出文件不包含 API Key`;
}
form.addEventListener("input", () => { updatePreview(); announce("有未保存的更改"); });
form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = document.querySelector<HTMLButtonElement>("#save-button")!;
  try {
    const settings = collect();
    const permission = grant(settings);
    button.disabled = true;
    await permission;
    if (extension) await send("settings:save", settings);
    else localStorage.setItem("bilingual-reader-preview", JSON.stringify(settings));
    saved = settings;
    announce(extension ? "已保存，打开的网页已更新。" : "已保存到预览。安装后的扩展需单独配置。");
  } catch (error) { announce(errorMessage(error), true); }
  finally { button.disabled = false; }
});
document.querySelector("#show-key")!.addEventListener("click", event => {
  const key = field("apiKey"); key.type = key.type === "password" ? "text" : "password";
  (event.target as HTMLElement).textContent = key.type === "password" ? "显示" : "隐藏";
});
document.querySelector("#test-provider")!.addEventListener("click", async () => {
  const button = document.querySelector<HTMLButtonElement>("#test-provider")!;
  try {
    const settings = collect();
    const permission = grant(settings);
    button.disabled = true; testResult.className = "test-result"; testResult.textContent = "正在连接，请稍候…";
    await permission;
    let text: string;
    if (settings.provider === "browser") {
      await native.prepare(settings.sourceLanguage, settings.targetLanguage, value => {
        testResult.textContent = `正在下载本地语言包 ${Math.round(value * 100)}%`;
      });
      text = await native.translate(TEST_SENTENCES[settings.sourceLanguage]);
    } else {
      if (!extension) throw new Error("请加载扩展后测试自定义接口；网页预览不会发送你的 API Key。");
      text = (await send<TranslationResult[]>("provider:test", settings))[0].text;
    }
    testResult.textContent = "连接成功 · " + text;
    testResult.className = "test-result success";
  } catch (error) { testResult.textContent = errorMessage(error); testResult.className = "test-result error"; }
  finally { button.disabled = false; }
});
document.querySelector("#clear-cache")!.addEventListener("click", async () => {
  try { if (extension) await send("cache:clear"); await updateCacheCount(); announce("翻译缓存已清空。"); }
  catch (error) { announce(errorMessage(error), true); }
});
document.querySelector("#export-settings")!.addEventListener("click", () => {
  try {
    const exportData = { format: "bilingual-reader", version: 1, settings: publicSettings(collect()) };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "bilingual-reader-settings.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); announce("已导出配置，未包含 API Key。");
  } catch (error) { announce(errorMessage(error), true); }
});
const importFile = document.querySelector<HTMLInputElement>("#import-file")!;
document.querySelector("#import-settings")!.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    if (file.size > 100000) throw new Error("配置文件过大。");
    const data = JSON.parse(await file.text());
    if (data?.format !== "bilingual-reader" || data.version !== 1 || typeof data.settings !== "object") throw new Error("不是有效的双语伴读配置。");
    populate(validateSettings({ ...data.settings, apiKey: field("apiKey").value }));
    announce("配置已导入，检查后点击保存。");
  } catch (error) { announce(errorMessage(error), true); }
  finally { importFile.value = ""; }
});
document.querySelectorAll<HTMLAnchorElement>(".nav-item").forEach(link => {
  link.onclick = () => {
    document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
    link.classList.add("active");
  };
});
async function init() {
  fillLanguages(document.querySelector("#source-language")!, "en");
  fillLanguages(document.querySelector("#target-language")!, "zh");
  if (!extension) {
    document.querySelector<HTMLElement>("#preview-notice")!.hidden = false;
    try { saved = validateSettings(JSON.parse(localStorage.getItem("bilingual-reader-preview") || "{}")); } catch {}
  } else saved = await send<Settings>("settings:get");
  populate(saved); await updateCacheCount();
  if (navigator.platform.includes("Mac")) document.querySelector("#shortcut-key")!.textContent = "⌥";
  const state = await native.availability(saved.sourceLanguage, saved.targetLanguage).catch(() => "unavailable");
  document.querySelector("#native-availability")!.textContent = state === "available" ? " 当前语言包已就绪。" : state === "unavailable" ? " 当前环境未就绪，可选择自定义接口。" : " 点击测试以下载并启用语言包。";
}
void init().catch(error => announce(errorMessage(error), true));
