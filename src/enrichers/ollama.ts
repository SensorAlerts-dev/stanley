/**
 * Local Ollama HTTP client for summarization and headline generation.
 * Targets http://localhost:11434 by default; the base URL is overridable
 * via _setOllamaBaseUrl for tests.
 */

const DEFAULT_MODEL = 'qwen2.5:3b-instruct';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_INPUT_CHARS = 8000;

let baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

/** @internal - test seam only */
export function _setOllamaBaseUrl(url: string): void {
  baseUrl = url;
}

interface GenerateResponse {
  response: string;
  done: boolean;
  error?: string;
}

async function generate(
  systemPrompt: string,
  userText: string,
  options: { maxTokens?: number; timeoutMs?: number; model?: string } = {},
): Promise<string> {
  const truncated = userText.slice(0, MAX_INPUT_CHARS);
  const body = JSON.stringify({
    model: options.model ?? DEFAULT_MODEL,
    system: systemPrompt,
    prompt: truncated,
    stream: false,
    options: {
      num_predict: options.maxTokens ?? 200,
      temperature: 0.2,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const data = (await res.json()) as GenerateResponse;
    if (data.error) throw new Error(`Ollama error: ${data.error}`);
    return data.response.trim();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Ollama request timed out. Is the daemon running on ' + baseUrl + '?');
    }
    if (err instanceof Error && err.message.includes('fetch failed')) {
      throw new Error(
        `Ollama not reachable at ${baseUrl}. Start it with: ollama serve`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function summarize(
  text: string,
  options: { maxSentences?: number } = {},
): Promise<string> {
  const sentences = options.maxSentences ?? 2;
  const systemPrompt =
    `You summarize content in exactly ${sentences} short sentences. ` +
    `Plain text only, no markdown, no quotes around the summary. ` +
    `Describe what the content is ABOUT, not how it's formatted.`;
  return generate(systemPrompt, text, { maxTokens: 120 });
}

export async function headline(text: string): Promise<string> {
  const systemPrompt =
    `Write one short descriptive headline for the content below. ` +
    `Under 80 characters. No quotes, no trailing punctuation, no "A" or "The" lead-ins when avoidable. ` +
    `This is a title shown in a library list view.`;
  return generate(systemPrompt, text, { maxTokens: 40 });
}
