export const OWN = "data-bilingual-reader";
const SKIP = `script,style,noscript,pre,textarea,input,select,button,svg,math,canvas,video,audio,nav,body>header,body>footer,[role="banner"],[role="contentinfo"],[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[aria-hidden="true"],[hidden],[${OWN}]`;
const BLOCK = "P H1 H2 H3 H4 H5 H6 LI TD TH DT DD BLOCKQUOTE FIGCAPTION DIV SECTION ARTICLE MAIN BODY".split(" ");
export interface TextBlock {
  element: HTMLElement;
  text: string;
  tokens: string[];
}
function owner(node: Node): HTMLElement | null {
  let parent = node.parentElement;
  while (parent && !BLOCK.includes(parent.tagName)) parent = parent.parentElement;
  return parent;
}
function excluded(element: Element): boolean {
  return Boolean(element.closest(SKIP));
}
export function collectBlocks(root: HTMLElement, sourceLanguage = "en"): TextBlock[] {
  const groups = new Map<HTMLElement, { parts: string[]; tokens: string[] }>();
  const visibility = new WeakMap<Element, boolean>();
  const isHidden = (element: Element): boolean => {
    const known = visibility.get(element);
    if (known !== undefined) return known;
    const style = getComputedStyle(element);
    const hidden = style.display === "none" || style.visibility === "hidden" ||
      Boolean(element.parentElement && isHidden(element.parentElement));
    visibility.set(element, hidden);
    return hidden;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  const seenCodes = new Set<Element>();
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || excluded(parent)) continue;
    const element = owner(node);
    if (!element || excluded(element)) continue;
    let group = groups.get(element);
    if (!group) { group = { parts: [], tokens: [] }; groups.set(element, group); }
    const code = parent.closest("code,kbd,samp");
    if (code) {
      if (seenCodes.has(code)) continue;
      seenCodes.add(code);
      const index = group.tokens.push(code.textContent || "") - 1;
      group.parts.push(` ⟦BR${index}⟧ `);
    } else {
      group.parts.push(node.textContent);
    }
  }
  const output: TextBlock[] = [];
  for (const [element, group] of groups) {
    const text = group.parts.join(" ").replace(/\s+/g, " ").trim();
    if (text.length < 3 || !/\p{L}/u.test(text.replace(/⟦BR\d+⟧/g, ""))) continue;
    if (sourceLanguage === "en" && !/[a-zA-Z]{2}/.test(text.replace(/⟦BR\d+⟧/g, ""))) continue;
    if (isHidden(element)) continue;
    output.push({ element, text, tokens: group.tokens });
  }
  return output;
}
export function splitText(text: string, max = 5500): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let at = rest.lastIndexOf(" ", max);
    if (at < max / 2) at = max;
    const tokenStart = rest.lastIndexOf("⟦", at);
    if (tokenStart >= 0 && rest.indexOf("⟧", tokenStart) >= at) at = tokenStart || max;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
export function createTranslation(text: string, tokens: string[]): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute(OWN, "translation");
  span.className = "br-translation";
  // Model output is always text. Only code nodes created here enter the DOM.
  const expression = /⟦BR(\d+)⟧/g;
  let start = 0;
  for (const match of text.matchAll(expression)) {
    span.append(document.createTextNode(text.slice(start, match.index)));
    const code = document.createElement("code");
    code.textContent = tokens[Number(match[1])] ?? match[0];
    span.append(code);
    start = match.index! + match[0].length;
  }
  span.append(document.createTextNode(text.slice(start)));
  return span;
}
export function validTokens(text: string, tokens: string[]): boolean {
  return tokens.every((_, index) => text.includes(`⟦BR${index}⟧`));
}
