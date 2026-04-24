import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { enrichUrl } from './url.js';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head>
  <title>Test Article</title>
  <meta property="og:title" content="Real Page Title">
  <meta property="og:description" content="A one-line description of the page content.">
</head><body>
  <nav>Nav menu</nav>
  <article>
    <h1>Main Heading</h1>
    <p>This is the first paragraph of the actual article body. It explains the topic at length.</p>
    <p>This is the second paragraph, which continues the discussion.</p>
  </article>
  <footer>Footer text</footer>
</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
}, 30000);

afterAll(async () => {
  const { closeUrlEnricher } = await import('./url.js');
  await closeUrlEnricher();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('url enricher', () => {
  it('extracts title, og:description, and body text', async () => {
    const out = await enrichUrl(`http://127.0.0.1:${port}/`);
    expect(out.ok).toBe(true);
    expect(out.title).toBe('Real Page Title');
    expect(out.ogDescription).toBe('A one-line description of the page content.');
    expect(out.bodyText).toContain('first paragraph');
    expect(out.bodyText).toContain('second paragraph');
    expect(out.bodyText).not.toContain('Nav menu');       // nav stripped
    expect(out.bodyText).not.toContain('Footer text');    // footer stripped
  }, 30000);

  it('returns ok:false on DNS failure', async () => {
    const out = await enrichUrl('https://this-domain-will-never-resolve-xyz123.test/');
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  }, 30000);
});
