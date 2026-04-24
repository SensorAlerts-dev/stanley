/**
 * Playwright-based URL enricher. Navigates, waits for network idle,
 * extracts title + og:description + main article body text.
 */

import { chromium, type Browser } from 'playwright';
import { logger } from '../logger.js';

export interface UrlEnrichOutcome {
  ok: boolean;
  title?: string;
  ogDescription?: string;
  bodyText?: string;
  finalUrl?: string;
  error?: string;
  errorCode?: string;
}

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}

export async function enrichUrl(url: string, timeoutMs = 30000): Promise<UrlEnrichOutcome> {
  let context;
  let page;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; ClaudeClaw Processor/1.0)',
    });
    page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Wait for network quieter, but cap
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      // ok - some sites never fully idle
    }

    // page.evaluate runs inside the browser (DOM context).
    // We pass the function as a string to avoid TypeScript checking browser globals
    // against the Node-only lib (no "dom" in tsconfig).
    const browserScript = `(() => {
      const title = document.title || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? null;
      const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? null;
      const article = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
      const clone = article.cloneNode(true);
      for (const sel of ['nav', 'footer', 'script', 'style', 'aside', 'header']) {
        clone.querySelectorAll(sel).forEach((n) => n.remove());
      }
      const text = (clone.textContent ?? '').replace(/\\s+/g, ' ').trim();
      return { title: ogTitle ?? title, ogDescription: ogDesc, bodyText: text, finalUrl: location.href };
    })()`;

    const result = await page.evaluate(browserScript) as {
      title: string;
      ogDescription: string | null;
      bodyText: string;
      finalUrl: string;
    };

    return {
      ok: true,
      title: result.title,
      ogDescription: result.ogDescription ?? undefined,
      bodyText: result.bodyText.slice(0, 10000),
      finalUrl: result.finalUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, url }, 'Processor: url enrichment failed');
    return { ok: false, error: msg, errorCode: classifyUrlError(msg) };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

function classifyUrlError(msg: string): string {
  if (/timeout/i.test(msg)) return 'playwright_timeout';
  if (/net::ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(msg)) return 'dns_error';
  if (/net::ERR_CONNECTION_REFUSED/.test(msg)) return 'connection_refused';
  return 'playwright_navigation_error';
}

/** Close the shared browser. Call during graceful shutdown. */
export async function closeUrlEnricher(): Promise<void> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}
