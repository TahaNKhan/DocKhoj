import { decode, encode } from 'gpt-tokenizer/encoding/cl100k_base';

// Phase 03 / p3-T07 — token-aware text budget helper for the agent
// loop (FR-17). Reuses the same cl100k_base tokenizer the chunker
// uses, so the budget reflects what the chunker would have seen.
//
// The agent loop applies a per-iteration total cap on tool-result
// text (TOOL_RESULT_TOKEN_CAP, default 10K tokens) incrementally: as
// each tool result is concatenated to the running total, once the
// total would exceed the cap the *remainder* of that one result is
// truncated. truncateToTokenBudget is the truncation primitive.

/** Count tokens in `text` using cl100k_base. Empty string → 0. */
export function countTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

/**
 * Truncate `text` so the resulting string is at most `budget` tokens
 * (cl100k_base). If `budget <= 0`, returns ''. If `text` already fits,
 * returns it unchanged. Otherwise encodes, slices, and decodes back
 * to a string. The decode round-trip is exact for valid UTF-8 inputs
 * — the cl100k_base BPE always decodes to the same byte sequence
 * given the same token list.
 */
export function truncateToTokenBudget(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (!text) return '';
  const tokens = encode(text);
  if (tokens.length <= budget) return text;
  return decode(tokens.slice(0, budget));
}