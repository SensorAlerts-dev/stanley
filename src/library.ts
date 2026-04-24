import crypto from 'crypto';
import { _getTestDb } from './db.js';

// Re-export so tests and sibling modules can reach the DB handle through
// library.ts without depending on db.js directly. Naming is a misnomer
// inherited from Phase 1 -- it returns the active (prod or test) handle.
export { _getTestDb };

// Internal alias: functions in this module call `getDb()` for readability
// since _getTestDb's name implies test-only, which is misleading. Rename
// to getDb across the codebase is a deferred follow-up.
const getDb = _getTestDb;

// ── URL canonicalization ──────────────────────────────────────────────
// Produces a stable string for dedup. Lower-case scheme+host, strip trailing
// slash, remove known noise query parameters, trim whitespace.
//
// Noise params are separated into a global set (always stripped) and
// domain-scoped sets (stripped only on matching hostnames). This avoids
// clobbering params that are noise on one platform but canonical on
// another. e.g. `t=` is a tiktok share token but a youtube playback
// timestamp; `ref=` is tracking on most sites but canonical on github.

const GLOBAL_NOISE_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'igshid', 'gclid', 'ref_src', 'si',
]);

const DOMAIN_NOISE_PARAMS: Array<{ hostSuffix: string; params: string[] }> = [
  { hostSuffix: 'tiktok.com', params: ['t'] },
];

// 'ref' is tracking on most sites (e.g. newsletter click-throughs) but
// canonical on GitHub (?ref=branch). Default: strip. Exception: github.com.
const REF_STRIP_EXCEPTIONS = new Set(['github.com', 'www.github.com']);

export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    // Non-parseable input returned verbatim. Callers that persist this
    // through urlHash will store a stable hash, but downstream dedup
    // quality for malformed URLs is inherently limited.
    return trimmed;
  }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  const host = u.hostname;

  // Collect domain-scoped noise params that apply to this host
  const domainScoped = new Set<string>();
  for (const rule of DOMAIN_NOISE_PARAMS) {
    if (host === rule.hostSuffix || host.endsWith('.' + rule.hostSuffix)) {
      for (const p of rule.params) domainScoped.add(p);
    }
  }
  // Strip `ref` globally except for github.com
  const stripRef = !REF_STRIP_EXCEPTIONS.has(host);

  const cleanedParams = new URLSearchParams();
  for (const [k, v] of u.searchParams.entries()) {
    const key = k.toLowerCase();
    if (GLOBAL_NOISE_PARAMS.has(key)) continue;
    if (domainScoped.has(key)) continue;
    if (stripRef && key === 'ref') continue;
    cleanedParams.append(k, v);
  }
  u.search = cleanedParams.toString();

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

export function urlHash(canonical: string): string {
  return crypto.createHash('sha1').update(canonical).digest('hex');
}

// ── OG meta extraction ────────────────────────────────────────────────
// Lightweight URL enrichment for memobot. Fetches the URL with the built-in
// https module, follows up to 3 redirects, parses og:* tags and <title> via
// regex. No Playwright, no WebFetch tool, no LLM reasoning -- just a
// deterministic fetch + parse that library-cli invokes on --auto-scrape.
//
// Works well for 90%+ of the web (anything that ships og: meta tags).
// Sparse JS-heavy sites (TikTok embed pages, Instagram without login) fall
// back to URL-as-title. Phase 3 Processor agent will do deeper scraping
// via Playwright for items that land without good og: data.

export interface OgMeta {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  author: string | null;
  finalUrl: string;
}

/** Extract og:* and <title> tags from an HTML string. Pure function, testable. */
export function extractOgMeta(html: string, finalUrl: string): OgMeta {
  const meta: OgMeta = {
    title: null,
    description: null,
    image: null,
    siteName: null,
    author: null,
    finalUrl,
  };

  // Match <meta property="og:X" content="Y"> in either attribute order.
  // Also handle name= (for twitter:card fallbacks).
  const metaRegex = /<meta\s+([^>]+?)\s*\/?>/gi;
  const attrRegex = /(\w[\w:-]*)\s*=\s*["']([^"']*)["']/g;

  for (const m of html.matchAll(metaRegex)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(attrRegex)) {
      attrs[a[1].toLowerCase()] = a[2];
    }
    const key = (attrs.property || attrs.name || '').toLowerCase();
    const content = attrs.content;
    if (!content) continue;

    if (key === 'og:title' && !meta.title) meta.title = decodeEntities(content);
    else if (key === 'og:description' && !meta.description) meta.description = decodeEntities(content);
    else if (key === 'og:image' && !meta.image) meta.image = content;
    else if (key === 'og:site_name' && !meta.siteName) meta.siteName = decodeEntities(content);
    else if ((key === 'author' || key === 'article:author') && !meta.author) {
      meta.author = decodeEntities(content);
    }
    else if (key === 'twitter:title' && !meta.title) meta.title = decodeEntities(content);
    else if (key === 'twitter:description' && !meta.description) meta.description = decodeEntities(content);
  }

  // Fallback to <title> tag if og:title absent.
  if (!meta.title) {
    const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (t) meta.title = decodeEntities(t[1].trim());
  }

  return meta;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x?([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, code.startsWith('x') || code.startsWith('X') ? 16 : 10)));
}

/**
 * Fetch a URL and return its og: metadata. Returns null on network error.
 * Follows up to 3 redirects. 10s timeout. Caps response at 512 KB.
 */
export async function fetchOgMeta(url: string, timeoutMs = 10000): Promise<OgMeta | null> {
  const maxRedirects = 3;
  const maxBytes = 512 * 1024;

  const follow = async (u: string, redirectsLeft: number): Promise<OgMeta | null> => {
    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const urlObj = new URL(u);
    const client = urlObj.protocol === 'http:' ? http : https;

    return new Promise((resolve) => {
      const req = client.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ClaudeClaw MemoBot og-fetcher/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      }, (res) => {
        // Redirect?
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            resolve(null);
            return;
          }
          const next = new URL(res.headers.location, u).toString();
          follow(next, redirectsLeft - 1).then(resolve);
          return;
        }

        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          resolve(null);
          return;
        }

        let bytes = 0;
        let settled = false;
        const chunks: Buffer[] = [];
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(extractOgMeta(Buffer.concat(chunks).toString('utf8'), u));
        };
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          chunks.push(chunk);
          // og: tags live in <head> — the first 512 KB is plenty. When the
          // page is larger (e.g. youtube.com/shorts/* is ~1 MB), destroy
          // the stream and resolve with what we have. 'end' won't fire
          // after destroy, only 'close', which is handled below.
          if (bytes >= maxBytes) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', () => {
          if (settled) return;
          settled = true;
          resolve(null);
        });
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    });
  };

  try {
    return await follow(url, maxRedirects);
  } catch {
    return null;
  }
}

// ── Project inference ─────────────────────────────────────────────────
// Keyword-based heuristic. Memobot can override with an explicit --project
// flag. When no keywords match, falls back to 'general'. Priority:
// octohive > pure_bliss > personal > general.

export type Project = 'pure_bliss' | 'octohive' | 'personal' | 'general';

export const PURE_BLISS_KEYWORDS = [
  'kefir', 'water kefir', 'fermented', 'hydration', 'pure bliss',
  'probiotic', 'scoby', 'gut health',
] as const;

export const OCTOHIVE_KEYWORDS = [
  'octopus', 'cephalopod', 'tentacle', 'aquarium', 'marine biology',
  'octohive',
] as const;

export const PERSONAL_KEYWORDS: readonly string[] = [
  // Intentionally empty. Personal is never keyword-inferred -- it is only
  // assigned when the user types "for personal" in their message, or via
  // an explicit /project reassign.
];

export function inferProject(text: string, url?: string): Project {
  const haystack = `${text} ${url ?? ''}`.toLowerCase();
  // Keywords are lowercased at author time; no need to re-lower per loop.

  for (const kw of OCTOHIVE_KEYWORDS) {
    if (haystack.includes(kw)) return 'octohive';
  }
  for (const kw of PURE_BLISS_KEYWORDS) {
    if (haystack.includes(kw)) return 'pure_bliss';
  }
  return 'general';
}

// ── Types ───────────────────────────────────────────────────────────────
export type SourceType =
  | 'tiktok' | 'instagram' | 'facebook' | 'reddit' | 'twitter'
  | 'youtube' | 'threads' | 'linkedin' | 'article' | 'screenshot'
  | 'file' | 'note' | 'voice' | 'forwarded';

export interface InsertItemOpts {
  source_type: SourceType;
  url?: string | null;
  user_note?: string | null;
  user_message?: string | null;
  project?: Project;
  title?: string | null;
  author?: string | null;
  captured_at?: number;
  source_meta?: Record<string, unknown> | null;
  enriched_at?: number | null;
  agent_id?: string;
  chat_id?: string;
}

export interface InsertItemResult {
  id: number;
  is_duplicate: boolean;
  existing_id?: number;
  last_seen_at_before?: number;
}

export function insertItem(opts: InsertItemOpts): InsertItemResult {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const canonical = opts.url ? canonicalizeUrl(opts.url) : null;
  const hash = canonical ? urlHash(canonical) : null;

  if (hash) {
    const existing = db.prepare(`
      SELECT id, user_note, last_seen_at FROM library_items WHERE url_hash = ?
    `).get(hash) as { id: number; user_note: string | null; last_seen_at: number | null } | undefined;

    if (existing) {
      const existingNote = existing.user_note ?? '';
      const incomingNote = opts.user_note?.trim() ?? '';
      const mergedNote =
        incomingNote.length > 0
          ? (existingNote.length > 0 ? `${existingNote}\n---\n${incomingNote}` : incomingNote)
          : existingNote;

      db.prepare(`
        UPDATE library_items
        SET user_note = ?, last_seen_at = ?
        WHERE id = ?
      `).run(mergedNote, now, existing.id);

      return {
        id: existing.id,
        is_duplicate: true,
        existing_id: existing.id,
        last_seen_at_before: existing.last_seen_at ?? undefined,
      };
    }
  }

  const info = db.prepare(`
    INSERT INTO library_items (
      agent_id, chat_id, source_type, url, url_hash, title, author,
      captured_at, last_seen_at, project, user_note, source_meta,
      enriched_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.agent_id ?? 'collector',
    opts.chat_id ?? '',
    opts.source_type,
    canonical,
    hash,
    opts.title ?? null,
    opts.author ?? null,
    opts.captured_at ?? now,
    opts.captured_at ?? now,
    opts.project ?? 'general',
    opts.user_note ?? null,
    opts.source_meta ? JSON.stringify(opts.source_meta) : null,
    opts.enriched_at ?? null,
    now,
  );

  return { id: info.lastInsertRowid as number, is_duplicate: false };
}

// ── Satellite helpers ──────────────────────────────────────────────────
export interface AddMediaOpts {
  media_type: 'image' | 'video' | 'pdf' | 'audio' | 'other';
  file_path: string;
  storage: 'local' | 'drive' | 'both';
  mime_type?: string;
  bytes?: number;
  drive_file_id?: string;
  drive_url?: string;
  ocr_text?: string;
}

export function addMedia(itemId: number, opts: AddMediaOpts): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(`
    INSERT INTO item_media (
      item_id, media_type, file_path, storage, mime_type, bytes,
      drive_file_id, drive_url, ocr_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    itemId,
    opts.media_type,
    opts.file_path,
    opts.storage,
    opts.mime_type ?? null,
    opts.bytes ?? null,
    opts.drive_file_id ?? null,
    opts.drive_url ?? null,
    opts.ocr_text ?? null,
    now,
  );
  return info.lastInsertRowid as number;
}

export interface AddContentOpts {
  content_type: 'ocr' | 'scraped_summary' | 'transcript' | 'user_note' | 'ai_summary';
  text: string;
  source_agent: string;
  token_count?: number;
}

export function addContent(itemId: number, opts: AddContentOpts): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(`
    INSERT INTO item_content (item_id, content_type, text, source_agent, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(itemId, opts.content_type, opts.text, opts.source_agent, opts.token_count ?? null, now);
  return info.lastInsertRowid as number;
}

export interface AddTagOpts {
  tag: string;
  tag_type: 'topic' | 'person' | 'brand' | 'hashtag' | 'mood' | 'other';
  source_agent: string;
  confidence?: number;
}

export function addTag(itemId: number, opts: AddTagOpts): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // INSERT OR IGNORE -- composite PK (item_id, tag, tag_type) makes
  // duplicate addTag calls no-ops rather than errors.
  db.prepare(`
    INSERT OR IGNORE INTO item_tags (item_id, tag, tag_type, confidence, source_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(itemId, opts.tag, opts.tag_type, opts.confidence ?? null, opts.source_agent, now);
}

// ── Lifecycle setters ──────────────────────────────────────────────────
export function markEnriched(itemId: number, at?: number): void {
  const db = getDb();
  db.prepare(`UPDATE library_items SET enriched_at = ? WHERE id = ?`)
    .run(at ?? Math.floor(Date.now() / 1000), itemId);
}

export function markReviewed(itemId: number, at?: number): void {
  const db = getDb();
  db.prepare(`UPDATE library_items SET reviewed_at = ? WHERE id = ?`)
    .run(at ?? Math.floor(Date.now() / 1000), itemId);
}

export function setPinned(itemId: number, pinned: boolean): void {
  const db = getDb();
  db.prepare(`UPDATE library_items SET pinned = ? WHERE id = ?`)
    .run(pinned ? 1 : 0, itemId);
}

export function setProject(itemId: number, project: Project): void {
  const db = getDb();
  // Schema CHECK constraint will reject invalid values with a clear error.
  db.prepare(`UPDATE library_items SET project = ? WHERE id = ?`)
    .run(project, itemId);
}

export function deleteItem(itemId: number): void {
  const db = getDb();
  db.prepare(`DELETE FROM library_items WHERE id = ?`).run(itemId);
}

// ── Full item read ─────────────────────────────────────────────────────
export interface FullItem {
  id: number;
  source_type: SourceType;
  url: string | null;
  title: string | null;
  author: string | null;
  captured_at: number;
  last_seen_at: number | null;
  project: Project;
  user_note: string | null;
  source_meta: Record<string, unknown> | null;
  reviewed_at: number | null;
  pinned: boolean;
  enriched_at: number | null;
  related_at: number | null;
  analyzed_at: number | null;
  media: Array<Record<string, unknown>>;
  content: Array<Record<string, unknown>>;
  tags: Array<Record<string, unknown>>;
}

export function getItem(itemId: number): FullItem | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM library_items WHERE id = ?`).get(itemId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const media = db.prepare(`SELECT * FROM item_media WHERE item_id = ? ORDER BY id`).all(itemId) as Array<Record<string, unknown>>;
  const content = db.prepare(`SELECT * FROM item_content WHERE item_id = ? ORDER BY id`).all(itemId) as Array<Record<string, unknown>>;
  const tags = db.prepare(`SELECT * FROM item_tags WHERE item_id = ? ORDER BY tag_type, tag`).all(itemId) as Array<Record<string, unknown>>;

  return {
    ...(row as unknown as FullItem),
    pinned: !!row.pinned,
    source_meta: row.source_meta ? JSON.parse(row.source_meta as string) : null,
    media,
    content,
    tags,
  };
}

// ── Search ─────────────────────────────────────────────────────────────
export interface SearchOpts {
  query?: string;
  project?: Project;
  source_type?: SourceType;
  pinned?: boolean;
  reviewed?: boolean;
  limit?: number;
  since?: number;
}

export interface ItemSearchRow {
  id: number;
  source_type: string;
  url: string | null;
  title: string | null;
  user_note: string | null;
  project: string;
  captured_at: number;
  media_filename: string | null;  // basename of first attached media, if any
  snippet?: string;
}

export function searchLibrary(opts: SearchOpts): ItemSearchRow[] {
  const db = getDb();
  const limit = opts.limit ?? 10;

  if (opts.query && opts.query.trim().length > 0) {
    const filters: string[] = [`item_content_fts MATCH ?`];
    const params: unknown[] = [opts.query];
    if (opts.project) { filters.push(`li.project = ?`); params.push(opts.project); }
    if (opts.source_type) { filters.push(`li.source_type = ?`); params.push(opts.source_type); }
    if (opts.pinned !== undefined) { filters.push(`li.pinned = ?`); params.push(opts.pinned ? 1 : 0); }
    if (opts.reviewed === true) filters.push(`li.reviewed_at IS NOT NULL`);
    if (opts.reviewed === false) filters.push(`li.reviewed_at IS NULL`);
    if (opts.since) { filters.push(`li.captured_at >= ?`); params.push(opts.since); }

    const sql = `
      SELECT DISTINCT li.id, li.source_type, li.url, li.title, li.user_note, li.project, li.captured_at,
        (SELECT file_path FROM item_media WHERE item_id = li.id ORDER BY id LIMIT 1) AS media_filename,
        snippet(item_content_fts, 0, '<', '>', '...', 20) AS snippet
      FROM item_content_fts
      JOIN library_items li ON li.id = item_content_fts.item_id
      WHERE ${filters.join(' AND ')}
      ORDER BY li.captured_at DESC
      LIMIT ?
    `;
    return db.prepare(sql).all(...params, limit) as ItemSearchRow[];
  }

  const filters: string[] = ['1=1'];
  const params: unknown[] = [];
  if (opts.project) { filters.push(`project = ?`); params.push(opts.project); }
  if (opts.source_type) { filters.push(`source_type = ?`); params.push(opts.source_type); }
  if (opts.pinned !== undefined) { filters.push(`pinned = ?`); params.push(opts.pinned ? 1 : 0); }
  if (opts.reviewed === true) filters.push(`reviewed_at IS NOT NULL`);
  if (opts.reviewed === false) filters.push(`reviewed_at IS NULL`);
  if (opts.since) { filters.push(`captured_at >= ?`); params.push(opts.since); }

  return db.prepare(`
    SELECT id, source_type, url, title, user_note, project, captured_at,
      (SELECT file_path FROM item_media WHERE item_id = library_items.id ORDER BY id LIMIT 1) AS media_filename
    FROM library_items
    WHERE ${filters.join(' AND ')}
    ORDER BY captured_at DESC
    LIMIT ?
  `).all(...params, limit) as ItemSearchRow[];
}

// ── Mission task queuing ───────────────────────────────────────────────
export function queueProcessorTask(itemId: number, reason: string): string {
  const db = getDb();
  const id = crypto.randomBytes(4).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO mission_tasks (
      id, title, prompt, assigned_agent, status, created_by, priority, created_at
    ) VALUES (?, ?, ?, ?, 'queued', 'memobot', 0, ?)
  `).run(
    id,
    `process item ${itemId}`,
    `Process library item ${itemId}: ${reason}`,
    'processor',
    now,
  );
  return id;
}
