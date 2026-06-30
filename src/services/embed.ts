import pLimit from 'p-limit';
import { embedLog as log } from '../utils/logger.js';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const DEFAULT_CONCURRENCY = parseInt(process.env.EMBEDDING_CONCURRENCY || '4', 10);
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 250;
const HEALTHCHECK_TIMEOUT_MS = 2000;

interface OllamaEmbeddingResponse {
  embedding: number[];
}

interface OllamaErrorResponse {
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

async function embedTextOnce(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      prompt: text,
    }),
  });

  if (!response.ok) {
    if (isTransientStatus(response.status)) {
      throw new Error(`Ollama API transient error: ${response.status}`);
    }
    let errorMessage = `Ollama API error: ${response.status}`;
    try {
      const errBody = (await response.json()) as OllamaErrorResponse;
      if (errBody.error) errorMessage = `${errorMessage} ${errBody.error}`;
    } catch {
      // ignore JSON parse failures
    }
    throw new Error(errorMessage);
  }

  const data = (await response.json()) as OllamaEmbeddingResponse;
  return data.embedding;
}

export async function embedText(text: string): Promise<number[]> {
  log.debug({ textLength: text.length }, 'Starting embedding');
  const startTime = Date.now();

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const embedding = await embedTextOnce(text);
      log.debug(
        { vectorLength: embedding.length, elapsedMs: Date.now() - startTime },
        'Embedding completed'
      );
      return embedding;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isTransient = lastError.message.includes('transient')
        || lastError.message.includes('fetch failed')
        || lastError.message.includes('ECONNRESET')
        || lastError.message.includes('ETIMEDOUT');
      if (!isTransient || attempt === MAX_RETRIES - 1) break;
      const backoff = BASE_BACKOFF_MS * 2 ** attempt + Math.random() * BASE_BACKOFF_MS;
      log.warn({ attempt: attempt + 1, backoffMs: Math.round(backoff) }, 'Retrying embed');
      await sleep(backoff);
    }
  }

  log.error({ err: lastError }, 'Embedding failed');
  throw lastError ?? new Error('Embedding failed for unknown reason');
}

export async function embedTexts(
  texts: string[],
  opts?: { concurrency?: number }
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;
  const limit = pLimit(Math.max(1, concurrency));
  return Promise.all(texts.map((text) => limit(() => embedText(text))));
}

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}