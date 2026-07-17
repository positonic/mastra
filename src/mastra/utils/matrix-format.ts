import { marked } from 'marked';

/**
 * Render agent markdown to Matrix HTML (`formatted_body`,
 * format `org.matrix.custom.html`). The markdown source itself stays in the
 * event's plain-text `body` as the spec-intended fallback, so this must be a
 * pure render — no escaping tricks, no downconversion (unlike
 * markdownToWhatsApp, Matrix natively renders rich HTML).
 */
export function markdownToMatrixHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true });
  return html.trim();
}
