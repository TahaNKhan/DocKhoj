// Typed fetch wrapper for /api/status. Polled by App for the TopBar
// pill (chunk count + Ollama) and the Chat toolbar's model pill.

export interface ServerStatus {
  chunks: number;
  ollamaAvailable: boolean;
  llmModel: string;
  llmContextSize: number | null;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function fetchStatus(): Promise<ServerStatus> {
  const res = await fetch('/api/status');
  return jsonOrThrow<ServerStatus>(res);
}

/** Format a token count the way the model pill likes to read: "8K", "128K", "200K", "1M", "1.5M". */
export function formatContextSize(tokens: number | null): string {
  if (tokens === null) return '';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}