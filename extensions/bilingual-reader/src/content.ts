import { Reader } from "./reader";
import { send, errorMessage, type PublicSettings, type TranslationResult } from "./shared";

async function main() {
  const settings = await send<PublicSettings>("settings:public");
  const reader = new Reader(settings, {
    translate: request => send<TranslationResult[]>("translate", request),
    cacheGet: key => send<string | undefined>("cache:get", { key }),
    cachePut: async (key, text) => { await send("cache:put", { key, text }); },
    openSettings: () => { void send("options:open"); }
  });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    let task: Promise<unknown> | undefined;
    switch (message?.type) {
      case "page:toggle": task = reader.toggle(); break;
      case "page:status": reply({ ok: true, data: reader.status }); return;
      case "page:retry": reader.retry(); reply({ ok: true, data: reader.status }); return;
      case "page:settings": task = reader.update(message.settings); break;
      case "page:selection": task = reader.translateSelection(message.text || ""); break;
      default: return;
    }
    task.then(data => reply({ ok: true, data }), error => reply({ ok: false, error: errorMessage(error) }));
    return true;
  });
  let url = location.href;
  const auto = () => {
    if (reader.settings.autoSites.includes(location.hostname) && !reader.settings.excludedSites.includes(location.hostname)) {
      void reader.start().catch(() => {});
    }
  };
  const navigation = setInterval(() => {
    if (location.href === url) return;
    const wasEnabled = reader.status.enabled;
    url = location.href; reader.stop();
    if (wasEnabled) void reader.start().catch(() => {});
    else auto();
  }, 800);
  window.addEventListener("pagehide", event => {
    reader.stop();
    if (!event.persisted) { clearInterval(navigation); reader.destroy(); }
  });
  window.addEventListener("pageshow", auto);
  auto();
}
void main().catch(() => {});
