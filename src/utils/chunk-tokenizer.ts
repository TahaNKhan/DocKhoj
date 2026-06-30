import { countTokens as cl100kCount } from 'gpt-tokenizer/encoding/cl100k_base';

export function countTokens(text: string): number {
  if (!text) return 0;
  return cl100kCount(text);
}

const SENTENCE_TERMINATORS = /(?<=[.!?])\s+(?=[A-Z"\u2018\u201C(\[])|(?<=[.!?])$|(?<=[。！？])\s*/g;

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'vs', 'etc', 'eg', 'ie', 'am', 'pm',
  'usa', 'uk', 'us', 'eu', 'un',
  'e.g', 'i.e', 'u.s', 'u.k', 'u.s.a',
]);

function isAbbreviationBeforeDot(text: string, dotIndex: number): boolean {
  let i = dotIndex - 1;
  while (i >= 0 && /[a-z.]/i.test(text[i] ?? '')) i--;
  const word = text.slice(i + 1, dotIndex).toLowerCase();
  return ABBREVIATIONS.has(word);
}

function isDecimalNumber(text: string, dotIndex: number): boolean {
  const before = text[dotIndex - 1];
  const after = text[dotIndex + 1];
  return /[0-9]/.test(before ?? '') && /[0-9]/.test(after ?? '');
}

function isInsideAcronym(text: string, dotIndex: number): boolean {
  const before = text[dotIndex - 1];
  const after = text[dotIndex + 1];
  return /[A-Z]/.test(before ?? '') && /[A-Z]/.test(after ?? '');
}

export function splitOnSentences(text: string): string[] {
  if (!text) return [];

  const boundaries: number[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    if (ch === '.' && i > 0) {
      if (isAbbreviationBeforeDot(text, i)) continue;
      if (isDecimalNumber(text, i)) continue;
      if (isInsideAcronym(text, i)) continue;
    }

    const nextCh = text[i + 1];
    if (nextCh !== undefined && /[a-z]/.test(nextCh)) continue;

    const prevCh = text[i - 1];
    if (prevCh !== undefined && /[A-Z]/.test(prevCh) && ch === '.' && i > 0) {
      const charBeforePrev = text[i - 2];
      if (charBeforePrev !== undefined && /[A-Z]/.test(charBeforePrev)) continue;
    }

    boundaries.push(i + 1);
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '。' || ch === '！' || ch === '？') {
      boundaries.push(i + 1);
    }
  }

  boundaries.sort((a, b) => a - b);

  const sentences: string[] = [];
  let prev = 0;
  for (const pos of boundaries) {
    const sentence = text.slice(prev, pos).trim();
    if (sentence) sentences.push(sentence);
    prev = pos;
  }
  const tail = text.slice(prev).trim();
  if (tail) sentences.push(tail);

  return sentences;
}

export function takeLastSentences(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0 || !text) return '';
  const sentences = splitOnSentences(text);
  const result: string[] = [];
  let total = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i] ?? '';
    const tokens = countTokens(sentence);
    if (total + tokens > budgetTokens) {
      if (result.length > 0) break;
      return '';
    }
    result.unshift(sentence);
    total += tokens;
    if (total >= budgetTokens) break;
  }
  return result.join(' ');
}

export function takeFirstSentences(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0 || !text) return '';
  const sentences = splitOnSentences(text);
  const result: string[] = [];
  let total = 0;
  for (const sentence of sentences) {
    const tokens = countTokens(sentence);
    if (total + tokens > budgetTokens) {
      if (result.length > 0) break;
      return '';
    }
    result.push(sentence);
    total += tokens;
    if (total >= budgetTokens) break;
  }
  return result.join(' ');
}

void SENTENCE_TERMINATORS;