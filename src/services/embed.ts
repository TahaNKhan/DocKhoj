import { embedLog as log } from '../utils/logger.js';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';

export async function embedText(text: string): Promise<number[]> {
  log.info({ textLength: text.length }, 'Starting embedding');
  const startTime = Date.now();

  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      prompt: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`);
  }

  const data = await response.json() as { embedding: number[] };
  const elapsed = Date.now() - startTime;
  log.info({ vectorLength: data.embedding.length, elapsedMs: elapsed }, 'Embedding completed');
  return data.embedding;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (const text of texts) {
    const embedding = await embedText(text);
    embeddings.push(embedding);
  }
  return embeddings;
}

export function isOllamaAvailable(): boolean {
  return true;
}