import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ollama-memory generateJson', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('posts to /api/generate with format:json and returns response.response', async () => {
    const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://localhost:11434/api/generate');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('qwen2.5:3b-instruct');
      expect(body.format).toBe('json');
      expect(body.stream).toBe(false);
      expect(body.prompt).toBe('extract memory');
      return new Response(JSON.stringify({ response: '{"ok":true}' }), { status: 200 });
    });
    globalThis.fetch = mockFetch as typeof fetch;

    const { generateJson } = await import('./ollama-memory.js');
    const out = await generateJson('extract memory');
    expect(out).toBe('{"ok":true}');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws a helpful error when Ollama is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed'); }) as typeof fetch;
    const { generateJson } = await import('./ollama-memory.js');
    await expect(generateJson('hi')).rejects.toThrow(/Ollama unreachable at http:\/\/localhost:11434/);
  });

  it('throws with status + body on non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => new Response('model not found', { status: 404 })) as typeof fetch;
    const { generateJson } = await import('./ollama-memory.js');
    await expect(generateJson('hi')).rejects.toThrow(/Ollama \/api\/generate failed: 404 model not found/);
  });
});

describe('ollama-memory embed', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('posts to /api/embeddings and returns the embedding array', async () => {
    const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://localhost:11434/api/embeddings');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('nomic-embed-text');
      expect(body.prompt).toBe('hello world');
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
    });
    globalThis.fetch = mockFetch as typeof fetch;

    const { embed } = await import('./ollama-memory.js');
    const out = await embed('hello world');
    expect(out).toEqual([0.1, 0.2, 0.3]);
  });

  it('throws a helpful error when response has no embedding field', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    const { embed } = await import('./ollama-memory.js');
    await expect(embed('hi')).rejects.toThrow(/Ollama \/api\/embeddings returned no embedding/);
    await expect(embed('hi')).rejects.toThrow(/ollama pull nomic-embed-text/);
  });
});
