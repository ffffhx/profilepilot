import { Reader } from "./reader";
import { DEFAULT_SETTINGS, publicSettings } from "./shared";
import { SAMPLES } from "./demo-data";
const cache = new Map<string, string>();
let previewSettings = publicSettings({ ...DEFAULT_SETTINGS, provider: "custom" });
try {
  const stored = JSON.parse(localStorage.getItem("bilingual-reader-preview") || "{}");
  if (["subtle", "card", "underline"].includes(stored.style)) previewSettings.style = stored.style;
  if (Number(stored.fontSize) >= 80 && Number(stored.fontSize) <= 140) previewSettings.fontSize = Number(stored.fontSize);
} catch {}
const reader = new Reader(previewSettings, {
  async translate(request) {
    await new Promise(resolve => setTimeout(resolve, 350));
    return request.segments.map(segment => ({
      id: segment.id,
      text: SAMPLES[segment.text] || "这是交互演示，仅内置了示例文章的译文。请安装扩展并配置引擎以翻译其他内容。",
      cached: false
    }));
  },
  async cacheGet(key) { return cache.get(key); },
  async cachePut(key, text) { cache.set(key, text); },
  openSettings() { window.open("options.html", "_blank"); }
});
const toggle = document.querySelector<HTMLButtonElement>("#demo-toggle")!;
reader.onStatus = state => { toggle.textContent = state.enabled ? "恢复原文" : "开启双语阅读 ↗"; };
toggle.onclick = () => void reader.toggle();
document.querySelector<HTMLButtonElement>("#add-paragraph")!.onclick = event => {
  const paragraph = document.createElement("p");
  paragraph.textContent = "New ideas arrive when we make room for them. Keep reading, and keep wondering.";
  document.querySelector("#dynamic-content")!.append(paragraph);
  (event.currentTarget as HTMLButtonElement).disabled = true;
};
