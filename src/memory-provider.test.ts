import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./gemini.js', () => ({
  generateContent: vi.fn(async () => 'gemini-out'),
  parseJsonResponse: vi.fn(() => ({ parsed: true })),
}));
vi.mock('./embeddings.js', () => ({
  embedText: vi.fn(async () => [1, 2, 3]),
}));
vi.mock('./ollama-memory.js', () => ({
  generateJson: vi.fn(async () => 'ollama-out'),
  embed: vi.fn(async () => [9, 9, 9]),
}));

describe('memory-provider dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MEMORY_PROVIDER;
  });

  it('routes generateContent to Ollama by default', async () => {
    const { generateContent } = await import('./memory-provider.js');
    const out = await generateContent('hi');
    expect(out).toBe('ollama-out');
  });

  it('routes embedText to Ollama by default', async () => {
    const { embedText } = await import('./memory-provider.js');
    const out = await embedText('hi');
    expect(out).toEqual([9, 9, 9]);
  });

  it('routes generateContent to Gemini when MEMORY_PROVIDER=gemini', async () => {
    process.env.MEMORY_PROVIDER = 'gemini';
    const { generateContent } = await import('./memory-provider.js');
    const out = await generateContent('hi');
    expect(out).toBe('gemini-out');
  });

  it('routes embedText to Gemini when MEMORY_PROVIDER=gemini', async () => {
    process.env.MEMORY_PROVIDER = 'gemini';
    const { embedText } = await import('./memory-provider.js');
    const out = await embedText('hi');
    expect(out).toEqual([1, 2, 3]);
  });

  it('re-exports parseJsonResponse from gemini.js', async () => {
    const { parseJsonResponse } = await import('./memory-provider.js');
    expect(parseJsonResponse('{"a":1}')).toEqual({ parsed: true });
  });
});
