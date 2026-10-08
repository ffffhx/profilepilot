import os from "node:os";
import { graphemes, graphemeWidth, palette, renderMarkdown, safeText, textWidth, truncateAnsi, wrapAnsi } from "./markdown";
import type { TerminalTheme } from "./markdown";
export { textWidth, wrapAnsi, stripAnsi, safeText } from "./markdown";
export type { TerminalTheme } from "./markdown";

export interface TerminalMessage {
  id?: string;
  role: "user" | "assistant" | "tool" | "system" | "error";
  text: string;
  title?: string;
  detail?: string;
  status?: "running" | "done" | "error" | "unknown";
  /** A processed audit record remains expandable with the transcript/tool toggle. */
  collapsedText?: string;
}
export interface TerminalMenuItem { label: string; description?: string; detail?: string; shortcut?: string; disabled?: boolean }
export interface TerminalMenu { title?: string; items: TerminalMenuItem[]; selected: number; filter?: string; loading?: boolean }
export interface TerminalState {
  messages: TerminalMessage[];
  input: {
    text: string; cursor: number; placeholder?: string; masked?: boolean;
    pasteSummary?: { label: string; start: number; end: number }[];
    search?: { query: string; match: string; index: number };
  };
  model?: string;
  profile?: string;
  mode?: string;
  status?: string;
  busy?: boolean;
  footer?: string;
  menu?: TerminalMenu;
  notice?: string;
  context?: string;
  showWelcome?: boolean;
  expandedTools?: boolean;
  expandedToolIds?: ReadonlySet<string>;
  collapsedToolIds?: ReadonlySet<string>;
  transcriptVersion?: string;
}
export interface TerminalOptions { theme?: TerminalTheme; version?: string; cwd?: string; screenReader?: boolean; reducedMotion?: boolean }
interface TerminalOutput {
  write(chunk: string): unknown;
  columns?: number;
  rows?: number;
  isTTY?: boolean;
  on?(event: string, callback: () => void): unknown;
  off?(event: string, callback: () => void): unknown;
}
export interface TerminalIO { stdout: TerminalOutput }
export interface TerminalFrame {
  lines: string[];
  cursor: { row: number; column: number };
  viewport: { start: number; total: number; visible: number };
  messageRows?: Map<string, number>;
}
export interface FrameOptions extends TerminalOptions { columns: number; rows: number; scrollOffset?: number; tick?: number }

const ESC = "\u001b";
const spinner = ["✻", "✽", "✶", "✳", "✢", "✳", "✶", "✽"];
const singleLine = (value: string) => safeText(value).replace(/\n/g, " ").replace(/\t/g, " ");
function shortCwd(cwd: string): string {
  const home = os.homedir();
  return cwd === home || cwd.startsWith(home + "/") || cwd.startsWith(home + "\\") ? "~" + cwd.slice(home.length) : cwd;
}

function messageLines(message: TerminalMessage, width: number, theme: TerminalTheme, expanded: boolean, tick: number): string[] {
  const colors = palette(theme);
  const text = safeText(message.text);
  const bodyWidth = Math.max(1, width - 2);
  if (message.collapsedText && !expanded) {
    return [colors.muted + "· " + truncateAnsi(singleLine(message.collapsedText), bodyWidth) + colors.reset, ""];
  }
  if (message.role === "tool") {
    const icon = message.status === "running" ? "…" : message.status === "error" ? "×" : message.status === "done" ? "✓" : "○";
    const color = message.status === "error" ? colors.error : message.status === "running" ? colors.brand : message.status === "done" ? colors.success : colors.muted;
    const title = singleLine(message.title ?? text.split("\n")[0] ?? "Tool") + (!message.status || message.status === "unknown" ? " [状态未报告]" : "");
    const result = wrapAnsi(colors.bold + title + colors.reset, bodyWidth)
      .map((line, index) => (index ? "  " : color + icon + colors.reset + " ") + line);
    if (expanded) {
      const detail = safeText(message.detail ?? (message.title ? text : text.split("\n").slice(1).join("\n")));
      if (detail) for (const line of renderMarkdown(detail, Math.max(1, width - 4), theme)) result.push("  " + colors.muted + "│ " + colors.reset + line);
    } else {
      const detail = safeText(message.detail ?? (message.title ? text : text.split("\n").slice(1).join("\n")));
      if (detail) {
        const count = detail.split("\n").length;
        result.push("  " + colors.muted + truncateAnsi((count > 1 ? `${count} lines · ` : "") + singleLine(detail.replace(/\n/g, " · ")), bodyWidth) + colors.reset);
      }
    }
    return [...result, ""];
  }
  const symbol = message.role === "user" ? "❯" : message.role === "assistant" ? "●" : message.role === "error" ? "×" : "·";
  const color = message.role === "user" ? colors.muted : message.role === "assistant" ? colors.brand : message.role === "error" ? colors.error : colors.muted;
  const lines = message.role === "user" ? wrapAnsi(text, bodyWidth) : renderMarkdown(text, bodyWidth, theme);
  return lines.map((line, index) => (index ? "  " : color + symbol + colors.reset + " ") + line).concat("");
}

const messageCache = new WeakMap<TerminalMessage, { key: string; lines: string[] }>();
const layoutCache = new WeakMap<TerminalMessage[], { key: string; lines: string[]; positions: Map<string, number> }>();
function transcriptLayout(state: TerminalState, options: FrameOptions, width: number, theme: TerminalTheme): { lines: string[]; positions: Map<string, number> } {
  const key = `${state.transcriptVersion}:${width}:${theme}:${state.expandedTools}:${[...(state.expandedToolIds || [])].join(",")}:${[...(state.collapsedToolIds || [])].join(",")}:${state.showWelcome}:${state.model}:${state.profile}:${options.cwd}`;
  const prior = layoutCache.get(state.messages);
  if (state.transcriptVersion !== undefined && prior?.key === key) return prior;
  const colors = palette(theme), lines: string[] = [], positions = new Map<string, number>();
  if (state.showWelcome !== false) {
    lines.push("", truncateAnsi(colors.brand + " ▐▛███▜▌  " + colors.bold + `ppilot v${singleLine(options.version ?? "0.1.0")}` + colors.reset, width),
      truncateAnsi(`▝▜█████▛▘  ${singleLine(state.model ?? "Agent")} · ${singleLine(state.profile || "Profile 待选择")}`, width),
      truncateAnsi(`  ▘▘ ▝▝   ${singleLine(shortCwd(options.cwd ?? process.cwd()))}`, width), "");
  }
  for (const message of state.messages) {
    if (message.id) positions.set(message.id, lines.length);
    const expanded = Boolean(state.expandedTools && !state.collapsedToolIds?.has(message.id || "") || state.expandedToolIds?.has(message.id || ""));
    const messageKey = `${width}:${theme}:${expanded}:${message.status}:${message.title}:${message.text}:${message.detail}:${message.collapsedText}`;
    let cached = messageCache.get(message);
    if (cached?.key !== messageKey) { cached = { key: messageKey, lines: messageLines(message, width, theme, expanded, 0) }; messageCache.set(message, cached); }
    for (const line of cached.lines) lines.push(line);
  }
  const result = { key, lines, positions };
  if (state.transcriptVersion !== undefined) layoutCache.set(state.messages, result);
  return result;
}

/** Map editor UTF-16 offsets to visible terminal cells, preserving grapheme clusters. */
function inputLines(text: string, cursor: number, width: number): { lines: string[]; row: number; column: number } {
  const lines: string[] = [];
  let line = "", column = 0, offset = 0, cursorRow = 0, cursorColumn = 0;
  cursor = Math.max(0, Math.min(text.length, cursor));
  for (const item of graphemes(text)) {
    if (item === "\t" && column === width) { lines.push(line); line = ""; column = 0; }
    const size = item === "\t" ? 4 - column % 4 : graphemeWidth(item);
    if (item !== "\n" && item !== "\t" && column && column + size > width) { lines.push(line); line = ""; column = 0; }
    if (offset <= cursor) { cursorRow = lines.length; cursorColumn = column; }
    if (item === "\n") { lines.push(line); line = ""; column = 0; }
    else if (item === "\t") {
      for (let i = 0; i < size; i++) {
        if (column === width) { lines.push(line); line = ""; column = 0; }
        line += " "; column++;
      }
    } else { line += size > width ? "�" : item; column += Math.min(width, size); }
    offset += item.length;
    if (offset <= cursor) { cursorRow = lines.length; cursorColumn = column; }
  }
  lines.push(line);
  // A cursor at the exact right margin needs its own continuation row.
  if (cursorColumn >= width) {
    cursorRow++;
    cursorColumn = 0;
    // At a hard newline this row belongs before the next logical line; otherwise
    // the caret would cover that line's first character while editing the prior one.
    lines.splice(cursorRow, 0, "");
  }
  return { lines, row: cursorRow, column: cursorColumn };
}

/** Pure renderer: every line stays within terminal width and the cursor within its input viewport. */
export function renderTerminalFrame(state: TerminalState, options: FrameOptions): TerminalFrame {
  const columns = Math.max(4, Math.floor(options.columns || 80));
  const rows = Math.max(4, Math.floor(options.rows || 24));
  // Leave the terminal's final cell unused to avoid autowrap/scroll on Windows ConPTY.
  const width = columns - 1;
  const theme = options.theme ?? "dark";
  const colors = palette(theme);
  const tick = options.reducedMotion ? 0 : options.tick ?? 0;
  const rawInput = safeText(state.input.text);
  // The editor reports offsets into its original text, before controls/CRLF are removed.
  const sourceCursor = Math.max(0, Math.min(state.input.text.length, state.input.cursor));
  const rawCursor = safeText(state.input.text.slice(0, sourceCursor)).length;
  const cleanInput = state.input.masked ? graphemes(rawInput).map(char => char === "\n" ? "\n" : "•").join("") : rawInput;
  let cleanCursor = rawCursor;
  if (state.input.masked) {
    cleanCursor = 0;
    let offset = 0;
    for (const char of graphemes(rawInput)) {
      offset += char.length;
      if (offset > rawCursor) break;
      cleanCursor++;
    }
  }
  const input = inputLines(cleanInput, cleanCursor, Math.max(1, width - 2));
  const inputHeight = Math.min(input.lines.length, Math.max(1, Math.min(7, Math.floor(rows / 3))));
  const inputStart = Math.max(0, Math.min(input.row - inputHeight + 1, input.lines.length - inputHeight));
  const bottom: string[] = [];
  const border = colors.border + "─".repeat(width) + colors.reset;
  const clipping = input.lines.length > inputHeight ? ` ↑${inputStart} · ${inputStart + 1}–${inputStart + inputHeight}/${input.lines.length} 行 · ↓${input.lines.length - inputStart - inputHeight} ` : "";
  bottom.push(clipping ? colors.border + truncateAnsi(clipping + "─".repeat(width), width) + colors.reset : border);
  for (let index = 0; index < inputHeight; index++) {
    const line = input.lines[inputStart + index] ?? "";
    const placeholder = !cleanInput && index === 0 ? colors.muted + singleLine(state.input.placeholder ?? 'Try "打开我的工作浏览器"') + colors.reset : line;
    bottom.push((index === 0 && inputStart === 0 ? colors.brand + "❯ " + colors.reset : "  ") + truncateAnsi(placeholder, width - 2));
  }
  bottom.push(border);

  const menu = state.menu;
  // Always reserve at least one conversation row when the terminal permits it.
  const conversationReserve = state.messages.length || state.showWelcome !== false ? Math.min(3, Math.max(1, rows - bottom.length - 3)) : 1;
  const menuBudget = Math.max(0, rows - bottom.length - 3 - conversationReserve - Number(Boolean(state.notice)));
  const menuLines: string[] = [];
  if (menu && menuBudget > 0) {
    const header = `${menu.loading ? "加载中…" : menu.items.length ? `${menu.selected + 1}/${menu.items.length}` : "无匹配"} · ${singleLine(menu.title || "选择")}${menu.filter ? " · " + singleLine(menu.filter) : ""}`;
    menuLines.push("  " + colors.bold + truncateAnsi(header, width - 2) + colors.reset);
    const preview = menu.items[menu.selected]?.detail;
    const previewRows = preview ? Math.min(3, Math.max(0, menuBudget - 3)) : 0;
    const count = Math.min(8, menu.items.length, Math.max(0, menuBudget - 1 - previewRows));
    const selected = Math.max(0, Math.min(menu.items.length - 1, menu.selected));
    const start = Math.max(0, Math.min(selected - Math.floor(count / 2), menu.items.length - count));
    for (let i = start; i < start + count; i++) {
      const item = menu.items[i];
      const label = singleLine(item.label);
      const description = item.description ? "  " + singleLine(item.description) : "";
      const shortcut = item.shortcut ? "  " + singleLine(item.shortcut) : "";
      const budget = Math.max(1, width - 4);
      const suffix = textWidth(shortcut) < budget / 2 ? shortcut : "";
      const metadata = description ? truncateAnsi(description, Math.floor(budget * .55)) : "";
      const content = truncateAnsi(label, Math.max(1, budget - textWidth(metadata) - textWidth(suffix))) + metadata + suffix;
      menuLines.push((i === selected ? colors.selection + colors.brand + "❯ " : "  ") + (item.disabled ? colors.muted : "") + "  " + content + colors.reset);
    }
    if (previewRows) menuLines.push(...wrapAnsi(safeText(preview!), Math.max(1, width - 2)).slice(0, previewRows).map(line => "  " + colors.muted + line + colors.reset));
  }
  const defaultFooter = state.input.search
    ? `历史搜索: ${singleLine(state.input.search.query)}${state.input.search.index < 0 ? "（无匹配）" : ""} · Ctrl+R 下一个 · Esc 返回`
    : `${state.mode ?? "manual mode"} · ? shortcuts · / commands${state.expandedTools ? " · ctrl+o collapse" : state.messages.some(message => message.role === "tool") ? " · ctrl+o tools" : ""}`;
  bottom.push(colors.muted + truncateAnsi(singleLine(state.input.search ? defaultFooter : state.footer ?? defaultFooter), width) + colors.reset);
  const context = state.context ? " · " + truncateAnsi(singleLine(state.context), Math.floor(width / 2)) : "";
  bottom.push(colors.muted + truncateAnsi(singleLine((state.busy ? (options.reducedMotion ? "运行中 " : spinner[tick % spinner.length] + " ") : "") + (state.status || "就绪")), Math.max(1, width - textWidth(context))) + context + colors.reset);
  const identity = [state.model, state.profile, shortCwd(options.cwd ?? process.cwd())].map(value => truncateAnsi(singleLine(value || "—"), Math.max(2, Math.floor((width - 6) / 3)))).join(" · ");
  bottom.push(colors.muted + truncateAnsi(identity, width) + colors.reset);
  // Menus and notices consume transcript space, keeping the editor at a stable row.
  if (state.notice) bottom.unshift(colors.muted + truncateAnsi(singleLine(state.notice), width) + colors.reset);
  bottom.unshift(...menuLines);
  const layout = transcriptLayout(state, options, width, theme), content = layout.lines;
  const transcriptHeight = Math.max(0, rows - bottom.length);
  const requestedScroll = Math.max(0, Math.floor(options.scrollOffset ?? 0));
  const scrolling = requestedScroll > 0 && content.length > transcriptHeight && transcriptHeight > 1;
  const visible = transcriptHeight - Number(scrolling);
  const scroll = scrolling ? Math.min(requestedScroll, Math.max(0, content.length - visible)) : 0;
  const start = Math.max(0, content.length - visible - scroll);
  const transcript = content.slice(start, start + visible);
  while (transcript.length < visible) transcript.push("");
  if (scrolling) transcript.unshift(colors.muted + truncateAnsi(`↑ transcript · ${Math.max(0, content.length - start - visible)} lines below · PgDn to return`, width) + colors.reset);
  // Locate the first border rather than infer menu/status height for tiny terminals.
  const borderIndex = bottom.length - inputHeight - 5;
  const lines = [...transcript, ...bottom].slice(-rows).map(line => truncateAnsi(line, width));
  const overflow = Math.max(0, transcript.length + bottom.length - rows);
  return {
    lines,
    cursor: {
      row: Math.max(1, Math.min(rows, transcriptHeight + borderIndex + 2 + input.row - inputStart - overflow)),
      column: Math.max(1, Math.min(width, input.column + 3))
    },
    viewport: { start, total: content.length, visible }, messageRows: layout.positions
  };
}

/** Owns the alternate screen and redraw lifecycle, never stdin or task control. */
export class TerminalUI {
  private state?: TerminalState;
  private options: TerminalOptions;
  private active = false;
  private suspended = false;
  private tick = 0;
  private scrollOffset = 0;
  private timer?: ReturnType<typeof setInterval>;
  private lastFrame?: TerminalFrame;
  private readonly spoken = new Map<string, string>();
  private spokenStatus = "";
  private spokenMenu = "";
  private spokenInput = "";
  private readonly resized = () => { this.lastFrame = undefined; this.draw(); };

  constructor(private readonly io: TerminalIO, options: TerminalOptions = {}) { this.options = options; }
  start(): void {
    if (this.active) return;
    this.active = true;
    this.io.stdout.on?.("resize", this.resized);
    if (this.io.stdout.isTTY !== false && !this.options.screenReader) this.io.stdout.write(`${ESC}[?1049h${ESC}[?2004h${ESC}[?25l${ESC}[0m${ESC}[2J${ESC}[H`);
    this.timer = setInterval(() => { if (this.state?.busy && !this.suspended && !this.options.reducedMotion && !this.options.screenReader) { this.tick++; this.draw(); } }, 120);
    this.timer.unref?.();
    this.draw();
  }
  render(state: TerminalState): void { this.state = state; if (!this.active) this.start(); else this.draw(); }
  setTheme(theme: TerminalTheme): void { this.options.theme = theme; this.lastFrame = undefined; this.draw(); }
  setAccessibility(screenReader: boolean, reducedMotion: boolean): void {
    const wasActive = this.active;
    if (wasActive) this.stop();
    this.options.screenReader = screenReader; this.options.reducedMotion = reducedMotion;
    if (wasActive) this.start();
  }
  scrollToMessage(id: string): void {
    if (!this.state) return;
    const frame = renderTerminalFrame(this.state, { ...this.options, columns: this.io.stdout.columns || 80, rows: this.io.stdout.rows || 24 });
    const row = frame.messageRows?.get(id); if (row === undefined) return;
    this.scrollOffset = Math.max(0, frame.viewport.total - frame.viewport.visible - row + 1);
    this.lastFrame = undefined; this.draw();
    if (this.options.screenReader) {
      const message = this.state.messages.find(item => item.id === id);
      if (message) this.io.stdout.write(`\n[历史 ${safeText(id)}] ${safeText(message.text)}\n`);
    }
  }
  scroll(delta: number): void {
    // The pure renderer clamps after reserving the scroll banner's own row.
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.draw();
  }
  scrollToBottom(): void { this.scrollOffset = 0; this.draw(); }
  suspend(): void {
    if (!this.active || this.suspended) return;
    this.suspended = true;
    if (this.io.stdout.isTTY !== false && !this.options.screenReader) this.io.stdout.write(`${ESC}[?2026l${ESC}[0m${ESC}[?25h${ESC}[?2004l${ESC}[?1049l`);
  }
  resume(): void {
    if (!this.active || !this.suspended) return;
    this.suspended = false;
    this.lastFrame = undefined;
    if (this.io.stdout.isTTY !== false && !this.options.screenReader) this.io.stdout.write(`${ESC}[?1049h${ESC}[?2004h${ESC}[?25l${ESC}[0m${ESC}[2J${ESC}[H`);
    this.draw();
  }
  stop(): void {
    if (!this.active) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.io.stdout.off?.("resize", this.resized);
    if (!this.suspended && this.io.stdout.isTTY !== false && !this.options.screenReader) this.io.stdout.write(`${ESC}[?2026l${ESC}[0m${ESC}[?25h${ESC}[?2004l${ESC}[?1049l`);
    this.active = false;
    this.suspended = false;
    this.lastFrame = undefined;
  }
  private draw(): void {
    if (!this.active || this.suspended || !this.state) return;
    if (this.options.screenReader) { this.drawLinear(this.state); return; }
    const options = { ...this.options, columns: this.io.stdout.columns ?? 80, rows: this.io.stdout.rows ?? 24, scrollOffset: this.scrollOffset, tick: this.tick };
    let frame = renderTerminalFrame(this.state, options);
    if (this.scrollOffset && this.lastFrame) {
      // Keep the same transcript lines visible when streaming appends new rows.
      this.scrollOffset = Math.max(0, this.scrollOffset + frame.viewport.total - this.lastFrame.viewport.total);
      if (this.scrollOffset !== options.scrollOffset) frame = renderTerminalFrame(this.state, { ...options, scrollOffset: this.scrollOffset });
    }
    this.scrollOffset = Math.max(0, frame.viewport.total - frame.viewport.visible - frame.viewport.start);
    if (this.io.stdout.isTTY === false) { this.lastFrame = frame; return; }
    let output = "";
    for (let i = 0; i < frame.lines.length; i++) {
      if (this.lastFrame?.lines[i] !== frame.lines[i]) output += `${ESC}[${i + 1};1H${ESC}[0m${ESC}[2K${frame.lines[i]}${ESC}[0m`;
    }
    const cursorChanged = this.lastFrame?.cursor.row !== frame.cursor.row || this.lastFrame?.cursor.column !== frame.cursor.column;
    if (output || cursorChanged) {
      this.io.stdout.write(`${ESC}[?2026h${ESC}[?25l${output}${ESC}[${frame.cursor.row};${frame.cursor.column}H${ESC}[?25h${ESC}[?2026l`);
    }
    // Refresh viewport metadata even when polling produces no visible changes.
    this.lastFrame = frame;
  }

  private drawLinear(state: TerminalState): void {
    for (let i = 0; i < state.messages.length; i++) {
      const message = state.messages[i], id = message.id || `${i}:${message.role}`;
      const text = safeText(message.role === "tool" ? `${message.title || message.text}\n${message.detail || ""}\n状态：${message.status || "未报告"}` : message.text);
      const prior = this.spoken.get(id);
      if (prior !== text) { this.io.stdout.write(prior && text.startsWith(prior) ? text.slice(prior.length) : `\n[${message.role}] ${text}\n`); this.spoken.set(id, text); }
    }
    const status = safeText([state.model, state.profile, state.status || (state.busy ? "处理中" : "就绪"), state.context, state.notice].filter(Boolean).join(" · "));
    if (status !== this.spokenStatus) { this.io.stdout.write(`\n[状态] ${status}\n`); this.spokenStatus = status; }
    const menu = state.menu;
    const item = menu?.items[menu.selected];
    const selection = menu ? safeText(`[菜单] ${menu.title} · ${menu.items.length ? `${menu.selected + 1}/${menu.items.length} ${item?.label} ${item?.description || ""}\n${item?.detail || ""}` : menu.loading ? "加载中" : "无匹配"} · ↑/↓ 选择，Enter 确认，Esc 返回`) : "";
    if (selection !== this.spokenMenu) { if (selection) this.io.stdout.write(`\n${selection}\n`); this.spokenMenu = selection; }
    const input = state.input.masked ? "[隐藏输入]" : safeText(state.input.text);
    if (input !== this.spokenInput) { this.io.stdout.write(input.startsWith(this.spokenInput) ? input.slice(this.spokenInput.length) : `\n[输入] ${input}`); this.spokenInput = input; }
    if (state.input.search) {
      const search = `历史搜索 ${safeText(state.input.search.query)} ${state.input.search.index < 0 ? "无匹配" : "匹配 " + safeText(state.input.search.match)}`;
      if (this.spoken.get("input-search") !== search) { this.io.stdout.write(`\n${search}\n`); this.spoken.set("input-search", search); }
    } else this.spoken.delete("input-search");
  }
}
