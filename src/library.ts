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
  content_type: 'ocr' | 'scraped_summary' | 'transcript' | 'user_note';
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
