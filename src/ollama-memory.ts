/**
 * Thin client for Ollama's /api/generate (JSON mode) and /api/embeddings.
 * Kept separate from src/enrichers/ollama.ts so the processor's
 * summarize/headline helpers stay untouched.
 */

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const GEN_MODEL = process.env.OLLAMA_MEMORY_MODEL ?? 'qwen2.5:3b-instruct';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';

interface GenerateResponse { response?: string; }
interface EmbeddingsResponse { embedding?: number[]; }

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Ollama unreachable at ${OLLAMA_URL} (${msg}). Is 'ollama serve' running?`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export async function generateJson(prompt: string): Promise<string> {
  const out = await postJson<GenerateResponse>('/api/generate', {
    model: GEN_MODEL,
    prompt,
    stream: false,
    format: 'json',
    options: { temperature: 0.1 },
  });
  if (typeof out.response !== 'string') {
    throw new Error(`Ollama /api/generate returned no 'response' field. Model '${GEN_MODEL}' may be misconfigured.`);
  }
  return out.response;
}

export async function embed(text: string): Promise<number[]> {
  const out = await postJson<EmbeddingsResponse>('/api/embeddings', {
    model: EMBED_MODEL,
    prompt: text,
  });
  if (!Array.isArray(out.embedding) || out.embedding.length === 0) {
    throw new Error(`Ollama /api/embeddings returned no embedding. Is '${EMBED_MODEL}' pulled? Run: ollama pull ${EMBED_MODEL}`);
  }
  return out.embedding;
}
