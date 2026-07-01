// Markdown rendering for assistant chat bubbles.
//
// FR-33: LLM responses are markdown. We render them with `marked.parse`
// and then run the result through `DOMPurify.sanitize` so an adversarial
// `<script>` (or any other dangerous tag / attribute) in the response
// cannot reach the DOM.
//
// Streaming note: this function is called once per `token` tick with
// the accumulated text. Both `marked.parse` and `DOMPurify.sanitize`
// are cheap on small inputs; the per-token cost is fine.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(text: string): string {
  if (!text) return '';
  // marked.parse returns a string for synchronous mode (the default).
  // We disable async extensions so the return type stays a string.
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}