import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

import { summarize, headline, _setOllamaBaseUrl } from './ollama.js';

let server: http.Server;
let port: number;

// In-process mock Ollama server for deterministic tests
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== '/api/generate') {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body) as { prompt: string; system?: string };
      // Echo a deterministic response based on the system prompt so tests
      // can distinguish summarize() from headline().
      const response = payload.system?.includes('headline')
        ? 'Mock headline for: ' + payload.prompt.slice(0, 20)
        : 'Mock summary of: ' + payload.prompt.slice(0, 20);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response, done: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  _setOllamaBaseUrl(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ollama enricher', () => {
  it('summarize returns trimmed response text', async () => {
    const out = await summarize('The quick brown fox jumps over the lazy dog.');
    expect(out).toBe('Mock summary of: The quick brown fox');
  });

  it('headline uses a headline-flavored system prompt', async () => {
    const out = await headline('The quick brown fox jumps over the lazy dog.');
    expect(out).toBe('Mock headline for: The quick brown fox');
  });

  it('summarize truncates input above 8K chars', async () => {
    const big = 'x'.repeat(20000);
    const out = await summarize(big);
    expect(out).toBe('Mock summary of: xxxxxxxxxxxxxxxxxxxx');
  });

  it('throws on non-200 responses with a clear error', async () => {
    _setOllamaBaseUrl('http://127.0.0.1:1');  // unreachable
    await expect(summarize('hi')).rejects.toThrow(/ollama/i);
    _setOllamaBaseUrl(`http://127.0.0.1:${port}`);
  });
});
