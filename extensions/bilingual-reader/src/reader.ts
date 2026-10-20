import { collectBlocks, createTranslation, OWN, splitText, validTokens, type TextBlock } from "./dom";
import { NativeEngine } from "./native";
import { cacheIdentity, errorMessage, fingerprint, type PageStatus, type PublicSettings, type TranslationRequest, type TranslationResult } from "./shared";

export interface ReaderBridge {
  translate(request: TranslationRequest): Promise<TranslationResult[]>;
  cacheGet(key: string): Promise<string | undefined>;
  cachePut(key: string, text: string): Promise<void>;
  openSettings(): void;
}
type State = "waiting" | "queued" | "running" | "done" | "error";
interface RecordBlock extends TextBlock {
  id: string; state: State; revision: number; output?: HTMLElement; cached?: boolean;
}
const TOOL_CSS = `
:host{all:initial;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#203c36;font-size:13px}
*{box-sizing:border-box}button{font:inherit;cursor:pointer;border:0}button:focus-visible{outline:3px solid #dcaa65;outline-offset:3px}
.bar{position:fixed;bottom:26px;right:26px;max-width:min(420px,calc(100vw - 32px));padding:13px 15px;background:#fdfdf9;border:1px solid #d9e1dc;border-radius:15px;box-shadow:0 10px 44px #17352b26;display:flex;align-items:center;gap:12px}
.logo{background:#226653;color:white;border-radius:9px;width:32px;height:32px;display:grid;place-items:center;font-size:18px}
.info{min-width:105px;max-width:230px}.title{font-weight:700;margin-bottom:4px}.detail{font-size:11px;color:#687a70;line-height:1.5;overflow-wrap:anywhere}
.action{background:#e8f1e9;color:#24604d;padding:8px 10px;border-radius:7px;white-space:nowrap}.close{background:transparent;color:#77867d;font-size:20px}
.panel{position:fixed;right:26px;bottom:102px;width:360px;max-width:calc(100vw - 32px);max-height:60vh;overflow:auto;background:#fdfdf9;border:1px solid #d9e1dc;box-shadow:0 12px 40px #17352b26;border-radius:16px;padding:22px}
.panel h3{font-size:14px;margin:0 0 16px}.original{font-size:12px;color:#718078;line-height:1.7;max-height:100px;overflow:auto;white-space:pre-wrap}
.answer{font-size:15px;line-height:1.9;padding-top:15px;margin-top:15px;border-top:1px solid #e1e8e1;white-space:pre-wrap;overflow-wrap:anywhere}
.panel .close{position:absolute;right:13px;top:10px}.panel .action{margin-top:12px}
.select{position:fixed;padding:8px 12px;background:#226653;color:white;border-radius:8px;box-shadow:0 3px 15px #17352b33}
@media(prefers-color-scheme:dark){.bar,.panel{background:#20302b;color:#e5ede8;border-color:#3f5349}.detail,.original{color:#b0c0b5}.action{background:#344a3f;color:#dcf2e1}.answer{border-color:#40534a}}
`;

export class Reader {
  private records = new Map<HTMLElement, RecordBlock>();
  private visible = new Set<HTMLElement>();
  private observer?: MutationObserver;
  private intersection?: IntersectionObserver;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private host?: HTMLElement;
  private shadow?: ShadowRoot;
  private styles?: HTMLStyleElement;
  private native = new NativeEngine();
  private generation = 0;
  private sequence = 0;
  private activeJobs = 0;
  private nativeReady = false;
  private enabled = false;
  private error = "";
  private selectionButton?: HTMLButtonElement;
  private selectionGeneration = 0;
  private lastSelection = "";
  private preparing = false;
  private selectionHandler = () => this.offerSelection();
  onStatus?: (status: PageStatus) => void;
  constructor(public settings: PublicSettings, private bridge: ReaderBridge) {
    document.addEventListener("mouseup", this.selectionHandler);
  }
  get status(): PageStatus {
    const records = [...this.records.values()];
    return {
      enabled: this.enabled, translated: records.filter(r => r.state === "done").length,
      total: records.length, failed: records.filter(r => r.state === "error").length,
      pending: records.filter(r => r.state === "queued" || r.state === "running").length,
      cached: records.filter(r => r.cached).length, error: this.error, hostname: location.hostname
    };
  }
  async toggle() { if (this.enabled) this.stop(); else await this.start(); return this.status; }
  async start() {
    if (this.enabled) return;
    if (this.settings.excludedSites.includes(location.hostname)) throw new Error("此站点已排除，请先在扩展菜单中修改站点规则。");
    this.enabled = true;
    const generation = ++this.generation;
    this.error = "";
    this.ensureUI(); this.applyStyle();
    this.intersection = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) this.visible.add(entry.target as HTMLElement);
        else this.visible.delete(entry.target as HTMLElement);
        const r = this.records.get(entry.target as HTMLElement);
        if (r && entry.isIntersecting && r.state === "waiting") r.state = "queued";
      }
      this.pump();
    }, { rootMargin: "500px 0px" });
    this.observer = new MutationObserver(changes => {
      const external = changes.some(change => {
        const parent = change.target instanceof Element ? change.target : change.target.parentElement;
        if (parent?.closest(`[${OWN}]`)) return false;
        if (change.type === "childList") {
          return [...change.addedNodes, ...change.removedNodes].some(node =>
            !(node instanceof Element && node.hasAttribute(OWN)));
        }
        return true;
      });
      if (!external) return;
      clearTimeout(this.scanTimer);
      this.scanTimer = setTimeout(() => this.scan(), 180);
    });
    this.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "aria-hidden"] });
    if (this.settings.provider === "browser") {
      try {
        const state = await this.native.availability(this.settings.sourceLanguage, this.settings.targetLanguage);
        if (generation !== this.generation) return;
        if (state === "available") {
          await this.native.prepare(this.settings.sourceLanguage, this.settings.targetLanguage);
          if (generation !== this.generation) return;
          this.nativeReady = true;
        } else {
          this.error = state === "unavailable" ? "本地引擎不可用，请在设置中更换服务。" : "首次使用需要下载语言包。点击「启用」开始。";
        }
      } catch (error) { if (generation === this.generation) this.error = errorMessage(error); }
    }
    if (generation !== this.generation) return;
    this.scan();
  }
  stop() {
    this.enabled = false; ++this.generation; ++this.selectionGeneration;
    this.observer?.disconnect(); this.intersection?.disconnect();
    clearTimeout(this.scanTimer);
    for (const record of this.records.values()) record.output?.remove();
    this.records.clear(); this.visible.clear();
    this.styles?.remove(); this.styles = undefined;
    this.host?.remove(); this.host = undefined; this.shadow = undefined;
    this.selectionButton = undefined; this.error = "";
    this.onStatus?.(this.status);
  }
  destroy() {
    this.stop(); this.native.destroy();
    document.removeEventListener("mouseup", this.selectionHandler);
  }
  async update(settings: PublicSettings) {
    const restart = this.enabled;
    this.stop(); this.native.destroy(); this.nativeReady = false;
    this.settings = settings;
    if (restart && !settings.excludedSites.includes(location.hostname)) await this.start();
  }
  private applyStyle() {
    if (!this.styles) {
      this.styles = document.createElement("style");
      this.styles.setAttribute(OWN, "styles");
      document.documentElement.append(this.styles);
    }
    const decoration = this.settings.style === "card" ?
      "background:light-dark(#edf4ee,#243c30);padding:10px 14px;border-radius:7px;border-left:3px solid #82a88e;" :
      this.settings.style === "underline" ? "border-bottom:1px dashed #8aa895;padding-bottom:5px;" :
      "border-left:2px solid #97b6a1;padding-left:12px;";
    this.styles.textContent = `[${OWN}="translation"]{display:block!important;color:light-dark(#38614e,#a8d2b5)!important;font-size:${this.settings.fontSize / 100}em!important;font-weight:400!important;line-height:1.8!important;margin:9px 0 13px!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;${decoration}}[${OWN}="translation"] code{font:0.88em ui-monospace,monospace!important;background:transparent!important;color:inherit!important}`;
    this.styles.textContent += `:is(h1,h2,h3,h4,h5,h6)>[${OWN}="translation"]{font-size:${this.settings.fontSize / 100 * .75}em!important;line-height:1.5!important}`;
  }
  private scan() {
    if (!this.enabled) return;
    const blocks = collectBlocks(document.body, this.settings.sourceLanguage);
    const found = new Set(blocks.map(block => block.element));
    for (const [element, record] of this.records) {
      if (!element.isConnected || !found.has(element)) {
        record.output?.remove(); this.intersection?.unobserve(element);
        this.records.delete(element); this.visible.delete(element);
      }
    }
    for (const block of blocks) {
      let record = this.records.get(block.element);
      if (record && record.text === block.text && JSON.stringify(record.tokens) === JSON.stringify(block.tokens)) continue;
      if (record) {
        record.output?.remove();
        record = { ...block, id: record.id, state: this.visible.has(block.element) ? "queued" : "waiting", revision: record.revision + 1 };
      } else {
        record = { ...block, id: `b${++this.sequence}`, state: "waiting", revision: 0 };
        this.intersection?.observe(block.element);
      }
      this.records.set(block.element, record);
    }
    this.renderStatus(); this.pump();
  }
  private pump() {
    if (!this.enabled || (this.settings.provider === "browser" && !this.nativeReady)) return;
    const limit = this.settings.provider === "browser" ? 1 : this.settings.concurrency;
    while (this.activeJobs < limit) {
      const queued = [...this.records.values()].filter(record => record.state === "queued")
        .sort((a, b) => a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top);
      if (!queued.length) break;
      const batch: RecordBlock[] = [];
      let size = 0;
      for (const record of queued) {
        if (batch.length && (batch.length >= 4 || size + record.text.length > 10000)) break;
        batch.push(record); size += record.text.length; record.state = "running";
      }
      const generation = this.generation;
      this.activeJobs++;
      void this.run(batch, generation).finally(() => { this.activeJobs--; this.renderStatus(); this.pump(); });
    }
    this.renderStatus();
  }
  private current(record: RecordBlock, generation: number) {
    return this.enabled && generation === this.generation && this.records.get(record.element) === record && record.element.isConnected;
  }
  private async run(records: RecordBlock[], generation: number) {
    const context = [document.title, document.querySelector("h1")?.childNodes[0]?.textContent || ""].join(" — ").slice(0, 800);
    const s = this.settings;
    const results = new Map<string, string>();
    const hits = new Set<string>();
    try {
      const segments = records.flatMap(record => splitText(record.text).map((text, index) => ({ id: `${record.id}r${record.revision}p${index}`, text })));
      if (s.provider === "browser") {
        for (const segment of segments) {
          if (generation !== this.generation) return;
          const key = await fingerprint(cacheIdentity(s, segment.text, "", s.sourceLanguage, s.targetLanguage));
          const cached = await this.bridge.cacheGet(key);
          const text = cached || await this.native.translate(segment.text);
          if (cached) hits.add(segment.id); else await this.bridge.cachePut(key, text);
          results.set(segment.id, text);
        }
      } else {
        // Cap both paragraph count and payload size. Long blocks are split without dropping content.
        let batch: typeof segments = [];
        let size = 0;
        const flush = async () => {
          if (!batch.length || generation !== this.generation) return;
          const translated = await this.bridge.translate({ segments: batch, context, sourceLanguage: s.sourceLanguage, targetLanguage: s.targetLanguage });
          for (const item of translated) { results.set(item.id, item.text); if (item.cached) hits.add(item.id); }
          batch = []; size = 0;
        };
        for (const segment of segments) {
          if (batch.length >= 8 || size + segment.text.length > 18000) await flush();
          if (generation !== this.generation) return;
          batch.push(segment); size += segment.text.length;
        }
        await flush();
      }
      for (const record of records) {
        if (!this.current(record, generation)) continue;
        const ids = splitText(record.text).map((_, index) => `${record.id}r${record.revision}p${index}`);
        if (ids.some(id => !results.has(id))) throw new Error("服务返回的翻译不完整，请重试。");
        const text = ids.map(id => results.get(id)).join("\n");
        if (!validTokens(text, record.tokens)) { record.state = "error"; this.error = "部分段落的代码标记未保留，可以重试或更换模型。"; continue; }
        const output = createTranslation(text, record.tokens);
        output.lang = s.targetLanguage;
        record.output?.remove(); record.element.append(output); record.output = output;
        record.cached = ids.every(id => hits.has(id));
        record.state = "done";
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = errorMessage(error);
      for (const record of records) if (this.current(record, generation) && record.state !== "done") record.state = "error";
    }
  }
  retry() {
    this.error = "";
    for (const record of this.records.values()) if (record.state === "error") record.state = "queued";
    this.pump();
  }
  private ensureUI() {
    if (this.host?.isConnected) return;
    this.host = document.createElement("div");
    this.host.setAttribute(OWN, "ui");
    this.host.style.cssText = "all:initial;position:fixed;z-index:2147483647;pointer-events:auto";
    this.shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style"); style.textContent = TOOL_CSS;
    this.shadow.append(style);
    document.documentElement.append(this.host);
  }
  private renderStatus() {
    const status = this.status;
    this.onStatus?.(status);
    if (!this.enabled) return;
    this.ensureUI();
    let bar = this.shadow!.querySelector<HTMLDivElement>(".bar");
    if (!bar) {
      bar = document.createElement("div"); bar.className = "bar"; bar.setAttribute("role", "region"); bar.setAttribute("aria-label", "双语伴读工具条");
      bar.innerHTML = '<span class="logo" aria-hidden="true">译</span><div class="info"><div class="title">双语伴读</div><div class="detail" aria-live="polite"></div></div><button class="action primary"></button><button class="action settings" title="翻译设置">设置</button><button class="close" aria-label="关闭翻译">×</button>';
      bar.querySelector(".settings")!.addEventListener("click", () => this.bridge.openSettings());
      bar.querySelector(".close")!.addEventListener("click", () => this.stop());
      bar.querySelector(".primary")!.addEventListener("click", () => {
        if (this.settings.provider === "browser" && !this.nativeReady) void this.prepareNative();
        else if (this.status.failed) this.retry();
        else this.stop();
      });
      this.shadow!.append(bar);
    }
    bar.querySelector(".detail")!.textContent = this.error || `${status.translated} / ${status.total} 段 · ${status.pending ? "正在翻译" : "随滚动继续"}${status.cached ? ` · ${status.cached} 段缓存` : ""}`;
    const primary = bar.querySelector<HTMLButtonElement>(".primary")!;
    primary.textContent = this.preparing ? "准备中…" : this.settings.provider === "browser" && !this.nativeReady ? "启用" : status.failed ? "重试" : "原文";
    primary.disabled = this.preparing;
  }
  private async prepareNative() {
    if (this.preparing) return;
    const generation = this.generation;
    this.preparing = true; this.error = "正在准备本地语言包…"; this.renderStatus();
    try {
      await this.native.prepare(this.settings.sourceLanguage, this.settings.targetLanguage, value => {
        if (generation !== this.generation) return;
        this.error = `下载语言包 ${Math.round(value * 100)}%`; this.renderStatus();
      });
      if (generation !== this.generation) return;
      this.nativeReady = true; this.error = ""; this.pump();
    } catch (error) { if (generation === this.generation) this.error = errorMessage(error); }
    finally { this.preparing = false; this.renderStatus(); }
  }
  private offerSelection() {
    this.selectionButton?.remove();
    if (!this.settings.selectionEnabled || this.settings.excludedSites.includes(location.hostname)) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!selection?.rangeCount || !text || text.length < 2 || text.length > 10000) return;
    const parent = selection.anchorNode?.parentElement;
    if (parent?.closest(`[${OWN}],input,textarea,[contenteditable]:not([contenteditable="false"])`)) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    this.ensureUI(); this.lastSelection = text;
    const button = document.createElement("button");
    button.className = "select"; button.textContent = "译 · 翻译选中内容";
    button.style.left = Math.max(8, Math.min(innerWidth - 170, rect.right - 150)) + "px";
    button.style.top = Math.max(8, Math.min(innerHeight - 45, rect.bottom + 8)) + "px";
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => { void this.translateSelection(this.lastSelection); button.remove(); });
    this.shadow!.append(button); this.selectionButton = button;
  }
  async translateSelection(text: string) {
    if (this.settings.excludedSites.includes(location.hostname)) return;
    if (!text.trim() || text.length > 10000) return;
    const generation = ++this.selectionGeneration;
    this.ensureUI();
    this.shadow!.querySelector(".panel")?.remove();
    const panel = document.createElement("section"); panel.className = "panel";
    panel.innerHTML = '<button class="close" aria-label="关闭划词翻译">×</button><h3>划词翻译</h3><div class="original"></div><div class="answer" aria-live="polite">正在翻译…</div>';
    panel.querySelector(".original")!.textContent = text;
    panel.querySelector(".close")!.addEventListener("click", () => { ++this.selectionGeneration; panel.remove(); });
    this.shadow!.append(panel);
    try {
      let translated: string;
      if (this.settings.provider === "browser") {
        await this.native.prepare(this.settings.sourceLanguage, this.settings.targetLanguage);
        this.nativeReady = true;
        translated = await this.native.translate(text);
      } else {
        const results = await this.bridge.translate({
          segments: [{ id: "selection", text }], context: document.title.slice(0, 800),
          sourceLanguage: this.settings.sourceLanguage, targetLanguage: this.settings.targetLanguage
        });
        translated = results[0].text;
      }
      if (generation !== this.selectionGeneration) return;
      panel.querySelector(".answer")!.textContent = translated;
      const copy = document.createElement("button"); copy.className = "action"; copy.textContent = "复制译文";
      copy.onclick = () => { void navigator.clipboard.writeText(translated).then(() => { copy.textContent = "已复制"; }, () => { copy.textContent = "请手动选择译文复制"; }); };
      panel.append(copy);
    } catch (error) {
      if (generation !== this.selectionGeneration) return;
      panel.querySelector(".answer")!.textContent = errorMessage(error);
      const retry = document.createElement("button"); retry.className = "action"; retry.textContent = "重试 / 启用本地引擎";
      retry.onclick = () => void this.translateSelection(text);
      panel.append(retry);
    }
  }
}
