import DOMPurify from "dompurify";
import { escapeHtml, safeHref } from "./sanitize";

/** `code`, **bold** and [links](https://…) in one line of Markdown. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
      const href = safeHref(url.replace(/&amp;/g, "&"));
      return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
    });
}

/**
 * The Markdown release notes use: headings, paragraphs and "- " lists with
 * inline code, bold and links. Returns sanitized HTML.
 */
export function renderMarkdown(text: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    paragraph = [];
    list = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (item) {
      if (paragraph.length) flush();
      list.push(item[1]);
    } else if (!line.trim()) {
      flush();
    } else if (list.length) {
      // A wrapped list item continues on the next line.
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return DOMPurify.sanitize(out.join(""));
}
