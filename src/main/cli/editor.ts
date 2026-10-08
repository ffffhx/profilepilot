import { graphemeWidth } from "./markdown";
/** Pure terminal input state. The controller owns stdin/raw mode and persistence. */
export interface EditorKey { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; }
export type EditorIntent = { type: "submit"; text: string } | { type: "stash"; text: string } |
  { type: "external-editor" | "image-paste" | "escape" | "interrupt" | "eof" | "complete" };
export interface EditorView { text: string; cursor: number; placeholder?: string; search?: { query: string; match: string; index: number }; }
interface PasteRange { start: number; end: number; }
interface Snapshot { text: string; cursor: number; pastes: PasteRange[]; }
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const START_PASTE = "\x1b[200~", END_PASTE = "\x1b[201~";

export class InputEditor {
  text = "";
  /** UTF-16 index, always on a grapheme boundary. */
  cursor = 0;
  private history: string[];
  private historyIndex: number;
  private historyDraft?: Snapshot;
  private pastes: PasteRange[] = [];
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private stashed?: Snapshot;
  private pasteBuffer: string[] | undefined;
  private pasteSuffix = "";
  private keyBuffer = "";
  private search?: { query: string; index: number; original: Snapshot };
  private preferredColumn?: number;
  private viewportWidth = Infinity;
  private readonly secret: boolean;
  private killRing: string[] = [];
  private yank?: { start: number; end: number; index: number };

  constructor(options: { text?: string; history?: string[]; secret?: boolean } = {}) {
    this.secret = Boolean(options.secret);
    this.history = [...(options.history || [])]; this.historyIndex = this.history.length;
    this.setText(options.text || "");
  }
  setText(text: string, cursor = text.length): void {
    const normalizedCursor = normalizeNewlines(text.slice(0, Math.max(0, cursor))).length;
    this.text = normalizeNewlines(text); this.cursor = boundary(this.text, normalizedCursor);
    this.pastes = []; this.search = undefined; this.preferredColumn = undefined;
    this.pasteBuffer = undefined; this.pasteSuffix = ""; this.keyBuffer = "";
    this.historyIndex = this.history.length; this.historyDraft = undefined;
    this.undoStack = []; this.redoStack = [];
  }
  /** The controller must bypass shortcuts and menus while input is captured. */
  get isCapturingInput(): boolean { return this.pasteBuffer !== undefined || Boolean(this.keyBuffer) || Boolean(this.search); }
  /** Apply completion/external edits as one undoable change. setText starts a fresh draft. */
  replaceText(text: string, cursor = text.length): void {
    this.replace(0, this.text.length, normalizeNewlines(text));
    this.move(normalizeNewlines(text.slice(0, Math.max(0, cursor))).length);
  }
  clear(): void { this.setText(""); }
  /** Secret editors are disposable and never share undo, stash, history or kill rings. */
  destroy(): void { this.setText(""); this.stashed = undefined; this.history = []; this.killRing = []; this.yank = undefined; }
  setViewportWidth(width: number): void { this.viewportWidth = Math.max(1, width); }
  setHistory(history: string[]): void {
    this.history = [...history]; this.resetHistory();
    if (this.search) { this.search.index = this.history.length; this.searchPrevious(); }
  }
  insert(text: string): void { this.replace(this.cursor, this.cursor, normalizeNewlines(text)); }
  paste(text: string): void {
    const value = normalizeNewlines(text); const start = this.cursor;
    if (this.search) { this.search.query += value; this.search.index = this.history.length; this.searchPrevious(); return; }
    this.insert(value);
    if (!this.secret && (value.length > 800 || value.split("\n").length > 3)) this.pastes.push({ start, end: this.cursor });
  }
  /** Display projection only: submit and persistence use .text, never view().text. */
  view(): EditorView {
    let text = this.text, cursor = this.cursor;
    for (const range of [...this.pastes].sort((a, b) => b.start - a.start)) {
      if (this.cursor > range.start && this.cursor < range.end) continue;
      const value = this.text.slice(range.start, range.end);
      const label = `[粘贴 ${value.split("\n").length} 行 / ${[...segmenter.segment(value)].length} 字]`;
      text = text.slice(0, range.start) + label + text.slice(range.end);
      if (this.cursor >= range.end) cursor += label.length - (range.end - range.start);
    }
    return { text, cursor, ...(this.search ? { search: { query: this.search.query, match: this.search.index < 0 ? "" : this.text, index: this.search.index }, placeholder: `历史搜索: ${this.search.query}${this.search.index < 0 ? "（无匹配）" : ""}` } : {}) };
  }
  handleKey(str: string | undefined, key: EditorKey = {}): EditorIntent[] {
    const sequence = key.sequence ?? str ?? "";
    if (this.pasteBuffer !== undefined) {
      // readline emits pasted text character by character. Only scan a small
      // suffix for a split terminator, and join the body once when paste ends.
      const buffered = this.pasteSuffix + sequence;
      const end = buffered.indexOf(END_PASTE);
      if (end < 0) {
        const keepFrom = Math.max(0, buffered.length - END_PASTE.length + 1);
        if (keepFrom) this.pasteBuffer.push(buffered.slice(0, keepFrom));
        this.pasteSuffix = buffered.slice(keepFrom); return [];
      }
      this.pasteBuffer.push(buffered.slice(0, end));
      const pasted = this.pasteBuffer.join(""); this.pasteBuffer = undefined; this.pasteSuffix = ""; this.paste(pasted);
      return buffered.length > end + END_PASTE.length ? this.handleKey(buffered.slice(end + END_PASTE.length)) : [];
    }
    const pasteStart = sequence.indexOf(START_PASTE);
    if (pasteStart >= 0) {
      if (pasteStart) this.insert(sequence.slice(0, pasteStart));
      this.pasteBuffer = []; this.pasteSuffix = "";
      return this.handleKey(sequence.slice(pasteStart + START_PASTE.length));
    }
    // readline splits modifyOtherKeys and kitty event-type suffixes across
    // keypress events. Keep those prefixes until the complete key arrives.
    const extended = this.keyBuffer + sequence; this.keyBuffer = "";
    if (/^\x1b\[(?:13;[2-8]:(?:[123])?|27;[2-8];(?:1|13)?)$/.test(extended)) { this.keyBuffer = extended; return []; }
    const modifiedEnter = /^\x1b\[(?:13;([2-8])(?::([123]))?u|27;([2-8]);13~)$/.exec(extended);
    if (modifiedEnter) {
      if (modifiedEnter[2] === "3") return []; // A key release is not another edit.
      const modifiers = Number(modifiedEnter[1] || modifiedEnter[3]) - 1;
      if (!(modifiers & 1) && modifiers !== 2) return []; // Ctrl+Enter belongs to the controller.
      if (this.search) return this.searchKey("", { name: "return" });
      this.insert("\n"); return [];
    }
    const name = key.name || keyName(sequence);
    const ctrl = key.ctrl || sequence === "\x1f" || (sequence.length === 1 && sequence.charCodeAt(0) > 0 && sequence.charCodeAt(0) < 27 && ![8, 9, 10, 13, 27].includes(sequence.charCodeAt(0)));
    if (this.secret && ((ctrl && ["r", "s", "g", "v", "y", "z", "_"].includes(name || "")) || key.meta || ["up", "down", "tab"].includes(name || ""))) return [];
    if (!(ctrl && name === "y") && !(key.meta && name === "y")) this.yank = undefined;
    if (this.search) return this.searchKey(str ?? sequence, { ...key, name, ctrl });
    if ((name === "return" || name === "enter") && (key.shift || key.meta)) { this.insert("\n"); return []; }
    if ((ctrl || key.meta) && name === "v") return [{ type: "image-paste" }];
    if (ctrl) {
      switch (name) {
        case "a": this.move(lineStart(this.text, this.cursor)); return [];
        case "e": this.move(lineEnd(this.text, this.cursor)); return [];
        case "u": this.kill(lineStart(this.text, this.cursor), this.cursor); return [];
        case "k": { const end = lineEnd(this.text, this.cursor); this.kill(this.cursor, end === this.cursor && end < this.text.length ? end + 1 : end); return []; }
        case "w": { const prefix = this.text.slice(0, this.cursor); const match = prefix.match(/(?:\S+\s*|\s+)$/u); this.kill(match ? this.cursor - match[0].length : this.cursor, this.cursor); return []; }
        case "j": this.insert("\n"); return [];
        case "r": this.search = { query: "", index: this.history.length, original: this.snapshot() }; this.searchPrevious(); return [];
        case "s": { const saved = this.snapshot(); this.remember(); this.restore(this.stashed || { text: "", cursor: 0, pastes: [] }); this.stashed = saved; this.resetHistory(); return [{ type: "stash", text: saved.text }]; }
        case "g": return [{ type: "external-editor" }];
        case "c": return [{ type: "interrupt" }];
        case "d": if (!this.text) return [{ type: "eof" }]; this.deleteForward(); return [];
        case "z": if (key.shift) this.redo(); else this.undo(); return [];
        case "_": this.undo(); return [];
        case "y": this.yankText(); return [];
        case "backspace": this.kill(this.wordBefore(), this.cursor); return [];
        case "left": this.wordBackward(); return [];
        case "right": this.wordForward(); return [];
        default: return [];
      }
    }
    if (key.meta && name === "z") { if (key.shift) this.redo(); else this.undo(); return []; }
    if (key.meta && name === "y") { this.yankText(true); return []; }
    if (key.meta && name === "d") { this.kill(this.cursor, this.wordAfter()); return []; }
    if (key.meta && name === "backspace") { this.kill(this.wordBefore(), this.cursor); return []; }
    if (key.meta && (name === "b" || name === "left")) { this.wordBackward(); return []; }
    if (key.meta && (name === "f" || name === "right")) { this.wordForward(); return []; }
    switch (name) {
      case "return": case "enter":
        if (sequence === "\n") { this.insert("\n"); return []; }
        if (this.text.slice(0, this.cursor).endsWith("\\")) { this.replace(this.cursor - 1, this.cursor, "\n"); return []; }
        return this.text.trim() ? [{ type: "submit", text: this.text }] : [];
      case "left": this.move(previousBoundary(this.text, this.cursor)); return [];
      case "right": this.move(nextBoundary(this.text, this.cursor)); return [];
      case "up": this.vertical(-1); return [];
      case "down": this.vertical(1); return [];
      case "home": this.move(lineStart(this.text, this.cursor)); return [];
      case "end": this.move(lineEnd(this.text, this.cursor)); return [];
      case "backspace": this.replace(previousBoundary(this.text, this.cursor), this.cursor, ""); return [];
      case "delete": this.deleteForward(); return [];
      case "escape": return [{ type: "escape" }];
      case "tab": return [{ type: "complete" }];
      default:
        if (!key.meta && sequence && !sequence.includes("\x1b") && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(sequence)) {
          if (sequence.length > 1 && (sequence.includes("\n") || sequence.length > 800)) this.paste(sequence); else this.insert(str ?? sequence);
        }
        return [];
    }
  }
  private searchKey(value: string, key: EditorKey): EditorIntent[] {
    if (!this.search) return [];
    if (key.name === "escape" || (key.ctrl && ["c", "g"].includes(key.name || ""))) { this.restore(this.search.original); this.search = undefined; return []; }
    if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "j")) {
      const original = this.search.original;
      if (this.text !== original.text) this.remember(original);
      this.search = undefined; this.cursor = this.text.length; this.resetHistory(); return [];
    }
    if (key.ctrl && key.name === "r") { this.searchPrevious(); return []; }
    if (key.name === "backspace") this.search.query = this.search.query.slice(0, previousBoundary(this.search.query, this.search.query.length));
    else if (!key.ctrl && !key.meta && value && !/[\x00-\x1f\x7f]/.test(value)) this.search.query += value;
    else return [];
    this.search.index = this.history.length; this.searchPrevious(); return [];
  }
  private searchPrevious(): void {
    if (!this.search) return;
    for (let index = this.search.index - 1; index >= 0; index--) if (this.history[index].toLocaleLowerCase().includes(this.search.query.toLocaleLowerCase())) {
      this.search.index = index; this.text = this.history[index]; this.cursor = this.text.length; this.pastes = []; return;
    }
    if (this.search.index === this.history.length) { this.search.index = -1; this.restore(this.search.original); }
  }
  private wordBefore(): number {
    return this.wordRanges(this.text.slice(0, this.cursor)).at(-1)?.start ?? 0;
  }
  private wordAfter(): number {
    const part = this.wordRanges(this.text.slice(this.cursor))[0];
    return part ? this.cursor + part.end : this.text.length;
  }
  private wordRanges(text: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) {
      if (/\p{Extended_Pictographic}/u.test(part.segment)) ranges.push({ start: part.index, end: part.index + part.segment.length });
      else for (const match of part.segment.matchAll(/[\p{L}\p{N}\p{M}_]+/gu)) ranges.push({ start: part.index + match.index!, end: part.index + match.index! + match[0].length });
    }
    return ranges;
  }
  private wordBackward(): void { this.move(this.wordBefore()); }
  private wordForward(): void { this.move(this.wordAfter()); }
  private kill(start: number, end: number): void {
    const value = this.text.slice(start, end);
    if (value && !this.secret) { this.killRing.unshift(value); this.killRing = this.killRing.slice(0, 20); }
    this.replace(start, end, "");
  }
  private yankText(cycle = false): void {
    if (!this.killRing.length) return;
    if (cycle && !this.yank) return;
    const start = cycle ? this.yank!.start : this.cursor;
    const end = cycle ? this.yank!.end : this.cursor;
    const index = cycle ? (this.yank!.index + 1) % this.killRing.length : 0;
    this.replace(start, end, this.killRing[index]);
    this.yank = { start, end: this.cursor, index };
  }
  private move(cursor: number, keepColumn = false): void {
    this.cursor = boundary(this.text, cursor);
    if (!keepColumn) this.preferredColumn = undefined;
  }
  private vertical(direction: -1 | 1): void {
    if (Number.isFinite(this.viewportWidth)) {
      const rows: Array<{ start: number; end: number }> = [];
      let start = 0, used = 0;
      for (const part of segmenter.segment(this.text)) {
        const size = part.segment === "\t" ? 4 - used % 4 : graphemeWidth(part.segment);
        if (part.segment !== "\n" && used && used + size > this.viewportWidth) { rows.push({ start, end: part.index }); start = part.index; used = 0; }
        if (part.segment === "\n") { rows.push({ start, end: part.index }); start = part.index + 1; used = 0; }
        else used += size;
      }
      rows.push({ start, end: this.text.length });
      if (used === this.viewportWidth) rows.push({ start: this.text.length, end: this.text.length });
      let index = rows.findIndex((row, i) => this.cursor >= row.start && (this.cursor < row.end || i === rows.length - 1 || rows[i + 1].start > this.cursor));
      if (index < 0) index = rows.length - 1;
      const target = rows[index + direction];
      if (!target) { this.browseHistory(direction); return; }
      this.preferredColumn ??= columns(this.text.slice(rows[index].start, this.cursor));
      let offset = target.start, cells = 0;
      for (const part of segmenter.segment(this.text.slice(target.start, target.end))) {
        const size = part.segment === "\t" ? 4 - cells % 4 : graphemeWidth(part.segment);
        if (cells + size > this.preferredColumn) break;
        cells += size; offset += part.segment.length;
      }
      this.move(offset, true); return;
    }
    const start = lineStart(this.text, this.cursor), end = lineEnd(this.text, this.cursor);
    if ((direction < 0 && start === 0) || (direction > 0 && end === this.text.length)) { this.browseHistory(direction); return; }
    this.preferredColumn ??= columns(this.text.slice(start, this.cursor));
    const targetStart = direction < 0 ? lineStart(this.text, start - 1) : end + 1;
    const targetEnd = lineEnd(this.text, targetStart);
    let offset = targetStart, used = 0;
    for (const part of segmenter.segment(this.text.slice(targetStart, targetEnd))) {
      const width = columns(part.segment); if (used + width > this.preferredColumn) break;
      used += width; offset += part.segment.length;
    }
    this.move(offset, true);
  }
  private browseHistory(direction: -1 | 1): void {
    if (!this.history.length) return;
    const index = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    if (index === this.historyIndex) return;
    if (this.historyIndex === this.history.length && direction < 0) this.historyDraft = this.snapshot();
    this.remember(); this.preferredColumn = undefined; this.historyIndex = index;
    if (this.historyIndex === this.history.length) this.restore(this.historyDraft || { text: "", cursor: 0, pastes: [] });
    else { this.text = this.history[this.historyIndex]; this.cursor = this.text.length; this.pastes = []; }
  }
  private deleteForward(): void { this.replace(this.cursor, nextBoundary(this.text, this.cursor), ""); }
  private replace(start: number, end: number, value: string): void {
    if (start === end && !value) return;
    this.remember();
    const delta = value.length - (end - start);
    this.pastes = this.pastes.filter(range => range.end <= start || range.start >= end).map(range => range.start >= end ? { start: range.start + delta, end: range.end + delta } : range);
    this.text = this.text.slice(0, start) + value + this.text.slice(end);
    const desired = start + value.length, before = boundary(this.text, desired);
    this.cursor = before === desired ? before : nextBoundary(this.text, before);
    this.preferredColumn = undefined; this.resetHistory();
  }
  private snapshot(): Snapshot { return { text: this.text, cursor: this.cursor, pastes: this.pastes.map(range => ({ ...range })) }; }
  private restore(snapshot: Snapshot): void { this.text = snapshot.text; this.cursor = snapshot.cursor; this.pastes = snapshot.pastes.map(range => ({ ...range })); this.preferredColumn = undefined; }
  private remember(snapshot = this.snapshot()): void { if (this.secret) return; this.undoStack.push(snapshot); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }
  private resetHistory(): void { this.historyIndex = this.history.length; this.historyDraft = undefined; }
  private undo(): void { const prior = this.undoStack.pop(); if (prior) { this.redoStack.push(this.snapshot()); this.restore(prior); this.resetHistory(); } }
  private redo(): void { const next = this.redoStack.pop(); if (next) { this.undoStack.push(this.snapshot()); this.restore(next); this.resetHistory(); } }
}

function keyName(sequence: string): string | undefined {
  const known: Record<string, string> = { "\r": "return", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\b": "backspace", "\x1b": "escape", "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\x1b[H": "home", "\x1b[F": "end", "\x1b[3~": "delete" };
  if (known[sequence]) return known[sequence];
  if (sequence === "\x1f") return "_";
  if (sequence.length === 1 && sequence.charCodeAt(0) >= 1 && sequence.charCodeAt(0) <= 26) return String.fromCharCode(sequence.charCodeAt(0) + 96);
  return sequence.length === 1 ? sequence : undefined;
}
function normalizeNewlines(text: string): string { return text.replace(/\r\n?/g, "\n"); }
function lineStart(text: string, cursor: number): number { return cursor <= 0 ? 0 : text.lastIndexOf("\n", cursor - 1) + 1; }
function lineEnd(text: string, cursor: number): number { const end = text.indexOf("\n", cursor); return end < 0 ? text.length : end; }
function boundary(text: string, cursor: number): number { let previous = 0; for (const part of segmenter.segment(text)) { if (part.index > cursor) return previous; previous = part.index; } return cursor >= text.length ? text.length : previous; }
function previousBoundary(text: string, cursor: number): number { return boundary(text, Math.max(0, cursor - 1)); }
function nextBoundary(text: string, cursor: number): number { for (const part of segmenter.segment(text)) if (part.index > cursor) return part.index; return text.length; }
function columns(text: string): number { let width = 0; for (const { segment } of segmenter.segment(text)) { const cp = segment.codePointAt(0) || 0; width += /\p{Extended_Pictographic}/u.test(segment) || cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xff01 && cp <= 0xff60 || cp >= 0x20000) ? 2 : 1; } return width; }
