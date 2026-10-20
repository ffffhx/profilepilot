interface TranslatorSession {
  translate(text: string): Promise<string>;
  destroy(): void;
}
interface TranslatorFactory {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: {
    sourceLanguage: string; targetLanguage: string;
    monitor?: (monitor: EventTarget) => void;
  }): Promise<TranslatorSession>;
}
export function nativeFactory(): TranslatorFactory | undefined {
  return (globalThis as typeof globalThis & { Translator?: TranslatorFactory }).Translator;
}
export class NativeEngine {
  private session?: TranslatorSession;
  private pair = "";
  private revision = 0;
  async availability(source: string, target: string): Promise<string> {
    return nativeFactory()?.availability({ sourceLanguage: source, targetLanguage: target }) ?? "unavailable";
  }
  async prepare(source: string, target: string, progress?: (value: number) => void) {
    const pair = source + ":" + target;
    if (this.session && this.pair === pair) return;
    const revision = ++this.revision;
    const factory = nativeFactory();
    if (!factory) throw new Error("此浏览器未提供本地翻译 API。请在设置中选择自定义 AI 接口，或使用支持该功能的 Chrome。");
    const state = await factory.availability({ sourceLanguage: source, targetLanguage: target });
    if (state === "unavailable") throw new Error("当前设备或语言组合不支持本地翻译，请更换语言或使用自定义 AI 接口。");
    const session = await factory.create({
      sourceLanguage: source, targetLanguage: target,
      monitor(monitor) { monitor.addEventListener("downloadprogress", event => progress?.((event as Event & { loaded: number }).loaded)); }
    });
    if (revision !== this.revision) { session.destroy(); throw new Error("翻译设置已更改，请重新启用。"); }
    this.session?.destroy();
    this.session = session;
    this.pair = pair;
  }
  async translate(text: string): Promise<string> {
    if (!this.session) throw new Error("请点击阅读工具条中的「启用本地翻译」。");
    // The browser's translation model can rewrite arbitrary sentinel tokens.
    // Translate the surrounding prose and carry protected code through locally.
    const pieces = text.split(/(⟦BR\d+⟧)/g);
    if (pieces.length === 1) return this.session.translate(text);
    const output: string[] = [];
    for (const piece of pieces) {
      if (/^⟦BR\d+⟧$/.test(piece)) output.push(piece);
      else if (piece.trim()) output.push(await this.session.translate(piece));
    }
    return output.join(" ");
  }
  destroy() { ++this.revision; this.session?.destroy(); this.session = undefined; this.pair = ""; }
}
