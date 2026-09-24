import { taskLinkUrl } from "../shared/task-link";

const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Keep messages as escaped text, adding anchors only for valid web addresses. */
export function renderTaskText(value: unknown): string {
  const text = String(value ?? "");
  const pattern = /https?:\/\/[^\s<>"'`，。；！？、（）【】「」『』“”‘’]+/gi;
  let html = "", offset = 0;
  for (const match of text.matchAll(pattern)) {
    let address = match[0];
    // Prose punctuation is not part of the link; retain balanced URL brackets.
    while (address) {
      const last = address.at(-1)!;
      const opening = ({ ")": "(", "]": "[", "}": "{" } as Record<string, string>)[last];
      if (/[.,;:!?*]/.test(last) || (opening && address.split(last).length > address.split(opening).length)) address = address.slice(0, -1);
      else break;
    }
    const url = taskLinkUrl(address);
    html += escape(text.slice(offset, match.index));
    html += url ? `<a class="task-link" data-task-link href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(address)}</a>${escape(match[0].slice(address.length))}` : escape(match[0]);
    offset = match.index! + match[0].length;
  }
  return html + escape(text.slice(offset));
}

export function openTaskLink(event: MouseEvent, open: (url: string) => Promise<void>, failed: (message: string) => void): boolean {
  if (event.type === "auxclick" && event.button !== 1) return false;
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[data-task-link]");
  if (!link) return false;
  event.preventDefault();
  void open(link.href).catch(error => failed(`无法打开链接：${error instanceof Error ? error.message : String(error)}`));
  return true;
}
