/** Terminal-safe Markdown and cell measurement. No terminal control codes from
 * model/tool output are ever passed through to the user's terminal. */
export type TerminalTheme = "dark" | "light" | "mono";

export interface Palette {
  reset: string; text: string; muted: string; brand: string; border: string;
  success: string; error: string; warning: string; code: string; keyword: string;
  string: string; selection: string; bold: string; italic: string;
}

const ESC = "\u001b";
export function palette(theme: TerminalTheme = "dark"): Palette {
  if (theme === "mono") return Object.fromEntries([
    "reset", "text", "muted", "brand", "border", "success", "error", "warning",
    "code", "keyword", "string", "selection", "bold", "italic"
  ].map(key => [key, ""])) as unknown as Palette;
  const light = theme === "light";
  return {
    reset: `${ESC}[0m`, text: `${ESC}[39m`, muted: `${ESC}[${light ? "90" : "38;5;245"}m`,
    brand: `${ESC}[${light ? "38;2;166;70;42" : "38;2;215;119;87"}m`, border: `${ESC}[${light ? "38;5;245" : "38;5;239"}m`,
    success: `${ESC}[${light ? "32" : "92"}m`, error: `${ESC}[${light ? "31" : "91"}m`,
    warning: `${ESC}[${light ? "33" : "93"}m`, code: `${ESC}[${light ? "35" : "38;5;180"}m`,
    keyword: `${ESC}[${light ? "34" : "38;5;111"}m`, string: `${ESC}[${light ? "32" : "38;5;150"}m`,
    selection: `${ESC}[${light ? "48;5;254" : "48;5;237"}m`, bold: `${ESC}[1m`, italic: `${ESC}[3m`
  };
}

// CSI, OSC (including hyperlinks/clipboard writes), DCS/APC/PM and C0/C1 controls.
const ansiPattern = /(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[ -/]*[@-~]/g;
export function stripAnsi(value: string): string { return value.replace(ansiPattern, ""); }
export function safeText(value: string): string {
  return stripAnsi(String(value)).replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), item => item.segment);
}
function wide(code: number): boolean {
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd));
}
export function graphemeWidth(value: string): number {
  if (!value || /^[\p{Mark}\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\u1160-\u11ff]+$/u.test(value)) return 0;
  if (/\p{Emoji_Presentation}/u.test(value) || /\uFE0F|\u20e3/.test(value)) return 2;
  const code = value.codePointAt(0) ?? 0;
  return code < 32 || (code >= 0x7f && code < 0xa0) ? 0 : wide(code) ? 2 : 1;
}
export function textWidth(value: string): number {
  let column = 0;
  for (const item of graphemes(stripAnsi(value))) column += item === "\t" ? 4 - column % 4 : graphemeWidth(item);
  return column;
}

/** Wrap only trusted SGR ANSI produced by this module. Call safeText on raw text. */
export function wrapAnsi(value: string, width: number): string[] {
  width = Math.max(1, Math.floor(width));
  const tokens = value.split(/(\u001b\[[0-9;]*m)/g);
  const lines: string[] = [];
  let line = "", cells = 0, styles = "";
  const flush = () => { lines.push(line + (styles ? `${ESC}[0m` : "")); line = styles; cells = 0; };
  for (const token of tokens) {
    if (/^\u001b\[[0-9;]*m$/.test(token)) {
      line += token;
      styles = token === `${ESC}[0m` || token === `${ESC}[m` ? "" : styles + token;
      continue;
    }
    for (const item of graphemes(token.replace(/\r\n/g, "\n"))) {
      if (item === "\n") { flush(); continue; }
      if (item === "\t") {
        if (cells === width) flush();
        const spaces = 4 - cells % 4;
        for (let i = 0; i < spaces; i++) {
          if (cells === width) flush();
          line += " "; cells++;
        }
        continue;
      }
      const size = graphemeWidth(item);
      if (cells && cells + size > width) flush();
      // A two-cell grapheme cannot be printed in a one-cell viewport safely.
      const rendered = size > width ? "�" : item;
      line += rendered;
      cells += Math.min(size, width);
    }
  }
  lines.push(line + (styles ? `${ESC}[0m` : ""));
  return lines;
}

export function truncateAnsi(value: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (textWidth(value) <= width) return value;
  const budget = Math.max(0, width - textWidth(ellipsis));
  if (!budget) return textWidth(ellipsis) <= width ? ellipsis : "";
  // Truncation must never replace a wide grapheme just to fill the final cell.
  let result = "", cells = 0, styled = false;
  for (const token of value.split(/(\u001b\[[0-9;]*m)/g)) {
    if (/^\u001b\[[0-9;]*m$/.test(token)) { result += token; styled = true; continue; }
    for (const item of graphemes(token)) {
      const size = item === "\t" ? 4 - cells % 4 : graphemeWidth(item);
      if (item === "\n" || cells + size > budget) return result + ellipsis + (styled ? `${ESC}[0m` : "");
      result += item === "\t" ? " ".repeat(size) : item;
      cells += size;
    }
  }
  return result + ellipsis + (styled ? `${ESC}[0m` : "");
}

function inline(value: string, colors: Palette, base = ""): string {
  const restore = colors.reset + base;
  return value.replace(/(`+)([^`]+)\1|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\(([^)]+)\)|(?<!\*)\*([^*]+)\*(?!\*)/g,
    (_all, _ticks, code, bold, underlineBold, label, url, italic) => {
      if (code) return colors.code + code + restore;
      if (bold || underlineBold) return colors.bold + (bold || underlineBold) + restore;
      if (label) return colors.keyword + label + restore + colors.muted + ` (${url})` + restore;
      return colors.italic + italic + restore;
    });
}
function highlightCode(value: string, language: string, colors: Palette): string {
  if (language === "diff" || language === "patch") {
    const color = /^(?:@@|diff --git|index |--- |\+\+\+ )/.test(value) ? colors.keyword
      : value.startsWith("+") ? colors.success : value.startsWith("-") ? colors.error : colors.muted;
    return color + value + colors.reset;
  }
  return value.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|(\b(?:const|let|var|function|return|async|await|class|if|else|for|while|import|from|export|def|True|False|None|true|false|null|new|throw|try|catch|interface|type|public|private|void|select|SELECT|FROM|WHERE)\b)|(\b\d+(?:\.\d+)?\b)|(\/\/.*$|^\s*#.*$)/g,
    (_all, string, keyword, number, comment) => (string ? colors.string + string : keyword ? colors.keyword + keyword : number ? colors.brand + number : colors.muted + comment) + colors.reset);
}

export function renderMarkdown(value: string, width: number, theme: TerminalTheme = "dark"): string[] {
  const colors = palette(theme);
  const result: string[] = [];
  let fence = "", language = "", rawDiff = false;
  const available = Math.max(1, Math.floor(width));
  const sources = safeText(value).split("\n");
  const prefixed = (body: string, prefix: string, continuation = prefix) => {
    const prefixWidth = textWidth(prefix);
    if (available <= prefixWidth) { result.push(...wrapAnsi(body, available)); return; }
    result.push(...wrapAnsi(body, available - prefixWidth).map((line, index) => (index ? continuation : prefix) + line));
  };
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    const marker = source.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const closes = marker && fence && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim();
    const opens = marker && !fence && (marker[1][0] !== "`" || !marker[2].includes("`"));
    if (closes || opens) {
      if (fence) { result.push(truncateAnsi(colors.border + "╰" + "─".repeat(Math.max(0, available - 1)) + colors.reset, available)); fence = ""; }
      else { fence = marker![1]; language = marker![2].trim().split(/\s+/)[0].toLowerCase(); result.push(truncateAnsi(colors.border + "╭─ " + language + colors.reset, available)); }
      rawDiff = false;
      continue;
    }
    if (fence) {
      const body = highlightCode(source, language, colors);
      prefixed(body, colors.border + "│ " + colors.reset);
      continue;
    }
    if (/^(?:diff --git |@@ )/.test(source) || (source.startsWith("--- ") && sources[index + 1]?.startsWith("+++ "))) rawDiff = true;
    if (rawDiff && /^(?:[ +\-\\]|@@|diff --git |index )/.test(source)) {
      result.push(...wrapAnsi(highlightCode(source, "diff", colors), available)); continue;
    }
    rawDiff = false;
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(source)) {
      result.push(colors.border + "─".repeat(available) + colors.reset); continue;
    }
    const heading = source.match(/^#{1,6}\s+(.*)$/);
    const quote = source.match(/^ {0,3}>\s?(.*)$/);
    const list = source.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    let rendered: string;
    if (heading) rendered = colors.bold + inline(heading[1], colors, colors.bold) + colors.reset;
    else if (quote) {
      prefixed(colors.muted + inline(quote[1], colors, colors.muted) + colors.reset, colors.border + "│ " + colors.reset); continue;
    } else if (list) {
      const indent = " ".repeat(Math.min(textWidth(list[1]), Math.max(0, available - 4)));
      const prefix = indent + colors.muted + (/^\d/.test(list[2]) ? list[2] : "•") + " " + colors.reset;
      prefixed(inline(list[3], colors), prefix, " ".repeat(textWidth(prefix))); continue;
    }
    else rendered = inline(source, colors);
    result.push(...wrapAnsi(rendered, available));
  }
  // Streaming Markdown may leave a fence open; still frame the currently available content.
  if (fence) result.push(colors.border + "╰" + "─".repeat(Math.max(0, available - 1)) + colors.reset);
  return result;
}
