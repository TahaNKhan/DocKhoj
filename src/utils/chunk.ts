export interface Chunk {
  text: string;
  index: number;
  startChar: number;
  endChar: number;
}

function findSentenceBoundary(text: string, start: number, targetEnd: number): number {
  // Look for sentence-ending punctuation followed by space or newline
  // . ! ? followed by space/newline
  for (let i = targetEnd - 1; i >= start + Math.floor((targetEnd - start) / 2); i--) {
    const ch = text[i];
    if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === ' ' || next === '\n' || next === '\r') {
        return i + 1; // Return position after the punctuation
      }
    }
  }
  return -1;
}

function findParagraphBoundary(text: string, start: number, targetEnd: number): number {
  // Look for double newline or paragraph break
  for (let i = targetEnd - 1; i >= start + Math.floor((targetEnd - start) / 2); i--) {
    if (text[i] === '\n' && i + 1 < text.length && text[i + 1] === '\n') {
      return i + 2;
    }
  }
  return -1;
}

function findWordBoundary(text: string, start: number, targetEnd: number): number {
  // Look for space before targetEnd
  const lastSpace = text.lastIndexOf(' ', targetEnd);
  if (lastSpace > start) {
    return lastSpace;
  }
  return -1;
}

export function chunkText(
  text: string,
  chunkSize: number = 500,
  overlap: number = 50
): Chunk[] {
  const chunks: Chunk[] = [];

  if (text.length <= chunkSize) {
    if (text.trim().length > 0) {
      chunks.push({ text: text.trim(), index: 0, startChar: 0, endChar: text.length });
    }
    return chunks;
  }

  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    // Clamp to text length
    if (end >= text.length) {
      end = text.length;
    } else {
      // Try to find a good break point, working backwards from ideal end
      // Priority: sentence -> paragraph -> word -> character

      let breakPoint = -1;

      // 1. Try sentence boundary
      const sentenceBreak = findSentenceBoundary(text, start, end);
      if (sentenceBreak > start) {
        breakPoint = sentenceBreak;
      }

      // 2. Try paragraph boundary
      if (breakPoint === -1) {
        const paraBreak = findParagraphBoundary(text, start, end);
        if (paraBreak > start) {
          breakPoint = paraBreak;
        }
      }

      // 3. Try word boundary
      if (breakPoint === -1) {
        const wordBreak = findWordBoundary(text, start, end);
        if (wordBreak > start + chunkSize / 3) {
          breakPoint = wordBreak;
        }
      }

      if (breakPoint > start) {
        end = breakPoint;
      }
      // If no good break found, use character boundary (end as calculated)
    }

    const chunkText = text.slice(start, end).trim();
    if (chunkText.length > 0) {
      chunks.push({
        text: chunkText,
        index: chunks.length,
        startChar: start,
        endChar: end,
      });
    }

    // Move start forward with overlap
    // Always make progress: at least 1 character
    const nextStart = end - overlap;
    start = Math.max(nextStart, start + 1);
  }

  return chunks;
}

export function combineChunks(chunks: Chunk[], maxLength: number = 2000): string {
  let result = '';
  for (const chunk of chunks) {
    const needed = result.length + chunk.text.length + (result.length > 0 ? 1 : 0);
    if (needed <= maxLength) {
      result += (result.length > 0 ? ' ' : '') + chunk.text;
    } else {
      break;
    }
  }
  return result;
}