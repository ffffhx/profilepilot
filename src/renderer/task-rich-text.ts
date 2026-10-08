import { taskLinkUrl } from "../shared/task-link";
import { renderTaskText } from "./task-links";

export const escapeTaskHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Deliberately small Markdown dialect: no raw HTML, images, embeds, or active URLs. */
function inline(text: string): string {
  const tokens = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let out = "", offset = 0;
  for (const match of text.matchAll(tokens)) {
    out += renderTaskText(text.slice(offset, match.index));
    if (match[1]) out += `<code>${escapeTaskHtml(match[1])}</code>`;
    else if (match[2]) { const url = taskLinkUrl(match[3]); out += url ? `<a class="task-link" data-task-link href="${escapeTaskHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeTaskHtml(match[2])}</a>` : escapeTaskHtml(match[0]); }
    else out += match[4] ? `<strong>${escapeTaskHtml(match[4])}</strong>` : `<em>${escapeTaskHtml(match[5])}</em>`;
    offset = match.index! + match[0].length;
  }
  return out + renderTaskText(text.slice(offset));
}
const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, "|"));
export function taskMarkdown(value: unknown): string {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  let out = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const block: string[] = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) block.push(lines[i++]);
      if (i < lines.length) i++;
      out += `<div class="task-code-block"><div class="actions"><small>${escapeTaskHtml(fence[2] || "代码")}</small><button type="button" data-copy-code>复制代码</button></div><pre><code>${escapeTaskHtml(block.join("\n"))}</code></pre></div>`;
      continue;
    }
    if (i + 1 < lines.length && line.includes("|") && cells(lines[i + 1]).every(c => /^:?-{3,}:?$/.test(c))) {
      const head = cells(line); i += 2; const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out += `<div class="task-table-scroll" tabindex="0" role="region" aria-label="表格，可横向滚动"><table><thead><tr>${head.map(c => `<th scope="col">${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${head.map((_, j) => `<td>${inline(row[j] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { out += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`; i++; continue; }
    if (/^\s*>/.test(line)) { const block: string[] = []; while (i < lines.length && /^\s*>/.test(lines[i])) block.push(lines[i++].replace(/^\s*>\s?/, "")); out += `<blockquote>${taskMarkdown(block.join("\n"))}</blockquote>`; continue; }
    if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) {
      const base = line.match(/^\s*/)?.[0].length || 0;
      const ordered = /^\s*\d/.test(line); const tag = ordered ? "ol" : "ul"; out += `<${tag}>`;
      while (i < lines.length) {
        const item = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!item || item[1].length !== base || /^\d/.test(item[2]) !== ordered) break;
        i++; const children: string[] = [];
        while (i < lines.length && lines[i].trim() && (lines[i].match(/^\s*/)?.[0].length || 0) > base) children.push(lines[i++].slice(base + 2));
        out += `<li>${inline(item[3])}${children.length ? taskMarkdown(children.join("\n")) : ""}</li>`;
      }
      out += `</${tag}>`; continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { out += "<hr>"; i++; continue; }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(?:#|>|`{3}|~{3}|[-+*]\s|\d+[.)]\s)/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && cells(lines[i + 1]).every(c => /^:?-{3,}:?$/.test(c)))) paragraph.push(lines[i++]);
    out += `<p>${paragraph.map(inline).join("<br>")}</p>`;
  }
  return out;
}
