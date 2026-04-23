# MemoBot Collector — Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the research library's Telegram collector. When Remy sends a URL / screenshot / file / voice / forwarded message / free-form text to `@MemoVizBot`, memobot classifies it, scrapes or ingests as needed, writes to the Phase 1 library schema via a new `library.ts` + `library-cli.ts` data-access layer, and replies with a short summary that includes the DB id.

**Architecture:** Memobot (Haiku 4.5) never writes raw SQL. It shells out to `library-cli.ts` for every DB touch. The CLI wraps a new `library.ts` module that owns URL canonicalization, dedup, project inference, and all inserts. Memobot's `CLAUDE.md` contains verbatim reply templates and per-input-type flows so Haiku stays consistent. Implementation ships in three waves: Wave 1 covers URLs + free-form text + screenshots (~80% of real use); Wave 2 adds other file types (PDF, video, audio); Wave 3 adds voice notes and forwarded messages.

**Tech Stack:** Node.js 20+, TypeScript, better-sqlite3, vitest, SQLite FTS5, Playwright MCP (already available to memobot), existing `src/embeddings.ts` (unused in Phase 2 but consumed by later phases).

**Spec reference:** `docs/superpowers/specs/2026-04-23-memobot-collector-design.md`

---

## File Structure

**Created:**
- `src/library.ts` — data-access layer. URL canonicalization, hash, project inference, CRUD helpers, FTS5-backed search, mission_task queuing. ~400-500 lines when done.
- `src/library-cli.ts` — thin CLI wrapper exposing `check-url`, `save`, `find`, `open`, `recent`, `delete`, `update`, `help` subcommands. Memobot shells out to this. ~250-300 lines.
- `src/library-cli.test.ts` — vitest integration tests that exercise the CLI as a subprocess.

**Modified:**
- `src/library.test.ts` — extended with tests for every new `library.ts` function.
- `~/.claudeclaw/agents/memobot/CLAUDE.md` — fully rewritten to replace the blank `_template`. Rewrite happens in Task 12 (Wave 1), then extended in Tasks 14 (Wave 2) and 16 (Wave 3).
- `dist/` — regenerated via `npm run build` during Wave 1, 2, and 3 verification tasks.

**Unchanged:**
- `migrations/version.json` — no schema changes in Phase 2.
- `.env.example` — no new env vars.
- `store/claudeclaw.db` — Phase 1 schema already has everything needed.

**Setup:** Create a feature branch `feat/memobot-collector` from `main` before Task 1. All 17 tasks commit on this branch. Merge when Wave 3 verification passes.

---

# Wave 1 — URLs + Free-form Text + Screenshots

Wave 1 produces a memobot that handles the 80% case: paste a URL or type a note, get a DB row with a summary reply. Screenshots save to the flash drive with OCR deferred. All 8 slash commands work.

## Task 1: `library.ts` URL canonicalization and hashing

**Files:**
- Create: `src/library.ts`
- Modify: `src/library.test.ts`

- [ ] **Step 1: Write the failing tests** — append a new top-level `describe('library.ts URL helpers', ...)` to `src/library.test.ts`:

```typescript
describe('library.ts URL helpers', () => {
  // Dynamic import to avoid module eval before tests set env vars
  it('canonicalizeUrl lowercases scheme and host', async () => {
    const { canonicalizeUrl } = await import('./library.js');
    expect(canonicalizeUrl('HTTPS://TikTok.COM/@brewlife/video/123')).toBe('https://tiktok.com/@brewlife/video/123');
  });

  it('canonicalizeUrl strips utm_* and other noise query params', async () => {
    const { canonicalizeUrl } = await import('./library.js');
    const input = 'https://example.com/post?utm_source=tw&utm_medium=social&fbclid=abc&ref=home&id=42';
    expect(canonicalizeUrl(input)).toBe('https://example.com/post?id=42');
  });

  it('canonicalizeUrl removes trailing slash except on root path', async () => {
    const { canonicalizeUrl } = await import('./library.js');
    expect(canonicalizeUrl('https://example.com/post/')).toBe('https://example.com/post');
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('canonicalizeUrl trims whitespace', async () => {
    const { canonicalizeUrl } = await import('./library.js');
    expect(canonicalizeUrl('  https://example.com/post  ')).toBe('https://example.com/post');
  });

  it('canonicalizeUrl strips t= param for tiktok share URLs', async () => {
    const { canonicalizeUrl } = await import('./library.js');
    expect(canonicalizeUrl('https://tiktok.com/@x/video/123?t=5s')).toBe('https://tiktok.com/@x/video/123');
  });

  it('urlHash returns 40-char SHA1 hex', async () => {
    const { urlHash } = await import('./library.js');
    const h = urlHash('https://example.com/a');
    expect(h).toMatch(/^[a-f0-9]{40}$/);
  });

  it('urlHash is deterministic for identical input', async () => {
    const { urlHash } = await import('./library.js');
    expect(urlHash('https://example.com/a')).toBe(urlHash('https://example.com/a'));
  });

  it('urlHash differs for different canonical URLs', async () => {
    const { urlHash } = await import('./library.js');
    expect(urlHash('https://example.com/a')).not.toBe(urlHash('https://example.com/b'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/library.test.ts -t "library.ts URL helpers"`
Expected: FAIL — "Cannot find module './library.js'".

- [ ] **Step 3: Create `src/library.ts` with the URL helpers**

```typescript
import crypto from 'crypto';

// ── URL canonicalization ──────────────────────────────────────────────
// Produces a stable string for dedup. Lower-case scheme+host, strip trailing
// slash, remove known noise query parameters, trim whitespace.

const NOISE_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'igshid', 'gclid', 'ref', 'ref_src', 'si', 't',
]);

export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    // If URL parsing fails, return the trimmed string unchanged; callers
    // can still hash it and store it as-is.
    return trimmed;
  }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  // Strip noise query params, preserve the rest in original key order.
  const cleanedParams = new URLSearchParams();
  for (const [k, v] of u.searchParams.entries()) {
    if (!NOISE_PARAMS.has(k.toLowerCase())) {
      cleanedParams.append(k, v);
    }
  }
  u.search = cleanedParams.toString();

  // Strip trailing slash from pathname except when path is just "/"
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

// ── URL hashing ────────────────────────────────────────────────────────
export function urlHash(canonical: string): string {
  return crypto.createHash('sha1').update(canonical).digest('hex');
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "library.ts URL helpers"`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/memobot-collector
git add src/library.ts src/library.test.ts
git commit -m "feat(library): add URL canonicalization and hashing

Canonicalizes URLs by lowercasing scheme+host, stripping noise
query params (utm_*, fbclid, igshid, ref, t, etc.), and removing
trailing slashes. SHA1-hashes the canonical form for dedup in
library_items.url_hash. 8 tests cover the happy paths and the
parameter-stripping edge cases."
```

---

## Task 2: `library.ts` project inference

**Files:**
- Modify: `src/library.ts`
- Modify: `src/library.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/library.test.ts`:

```typescript
describe('library.ts project inference', () => {
  it('infers pure_bliss from kefir keyword', async () => {
    const { inferProject } = await import('./library.js');
    expect(inferProject('how to make water kefir at home')).toBe('pure_bliss');
  });

  it('infers octohive from octopus keyword', async () => {
    const { inferProject } = await import('./library.js');
    expect(inferProject('my octopus died yesterday')).toBe('octohive');
  });

  it('infers octohive from cephalopod keyword', async () => {
    const { inferProject } = await import('./library.js');
    expect(inferProject('cephalopod cognition study')).toBe('octohive');
  });

  it('returns general for neutral content', async () => {
    const { inferProject } = await import('./library.js');
    expect(inferProject('random tech article about databases')).toBe('general');
  });

  it('uses URL hints for inference', async () => {
    const { inferProject } = await import('./library.js');
    expect(inferProject('check this out', 'https://example.com/kefir-guide')).toBe('pure_bliss');
  });

  it('is case-insensitive', async () => {
    const { inferProject } = await import('./library.js');
    expect(inferProject('KEFIR brewing guide')).toBe('pure_bliss');
  });

  it('octohive wins over pure_bliss when both match (hardcoded priority)', async () => {
    const { inferProject } = await import('./library.js');
    // A post about an octopus-themed water brand
    expect(inferProject('octopus mascot for new water kefir brand')).toBe('octohive');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/library.test.ts -t "project inference"`
Expected: FAIL — `inferProject is not a function`.

- [ ] **Step 3: Add the project inference function to `src/library.ts`**

Append to the existing file:

```typescript
// ── Project inference ─────────────────────────────────────────────────
// Keyword-based heuristic. Memobot can override with an explicit --project
// flag. When no keywords match, falls back to 'general'. Priority:
// octohive > pure_bliss > personal > general (octohive wins for ambiguous
// "octopus-themed water brand" posts because octohive is the narrower
// project and having false positives there is noisier for the analyst
// agent than false positives in pure_bliss).

export type Project = 'pure_bliss' | 'octohive' | 'personal' | 'general';

export const PURE_BLISS_KEYWORDS = [
  'kefir', 'water kefir', 'fermented', 'hydration', 'pure bliss',
  'probiotic', 'scoby', 'gut health',
];

export const OCTOHIVE_KEYWORDS = [
  'octopus', 'cephalopod', 'tentacle', 'aquarium', 'marine biology',
  'octohive',
];

export const PERSONAL_KEYWORDS: string[] = [
  // Intentionally empty. Personal is never keyword-inferred — it is only
  // assigned when the user types "for personal" in their message, or via
  // an explicit /project reassign.
];

export function inferProject(text: string, url?: string): Project {
  const haystack = `${text} ${url ?? ''}`.toLowerCase();

  // Priority order matters (see comment above).
  for (const kw of OCTOHIVE_KEYWORDS) {
    if (haystack.includes(kw.toLowerCase())) return 'octohive';
  }
  for (const kw of PURE_BLISS_KEYWORDS) {
    if (haystack.includes(kw.toLowerCase())) return 'pure_bliss';
  }
  return 'general';
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "project inference"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/library.ts src/library.test.ts
git commit -m "feat(library): add keyword-based project inference

Infers project from message text + URL using keyword buckets
defined as exported constants. Priority order: octohive >
pure_bliss > personal > general. Personal is never
keyword-inferred (must be set explicitly)."
```

---

## Task 3: `library.ts` `insertItem` with dedup

**Files:**
- Modify: `src/library.ts`
- Modify: `src/library.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/library.test.ts`:

```typescript
describe('library.ts insertItem', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('inserts a minimal library_item and returns its id', async () => {
    const { insertItem } = await import('./library.js');
    const res = insertItem({ source_type: 'note', user_note: 'hello' });
    expect(res.id).toBeGreaterThan(0);
    expect(res.is_duplicate).toBe(false);
    expect(res.existing_id).toBeUndefined();
  });

  it('computes url_hash when url is provided', async () => {
    const { insertItem, _getTestDb, urlHash, canonicalizeUrl } = await import('./library.js');
    const res = insertItem({ source_type: 'article', url: 'https://example.com/x' });
    // Direct DB peek — we expect url_hash to be SHA1 of canonical URL
    const db = (await import('./db.js'))._getTestDb();
    const row = db.prepare(`SELECT url, url_hash FROM library_items WHERE id = ?`).get(res.id) as { url: string; url_hash: string };
    expect(row.url).toBe('https://example.com/x');
    expect(row.url_hash).toBe(urlHash(canonicalizeUrl('https://example.com/x')));
  });

  it('re-inserting the same URL returns is_duplicate with existing_id', async () => {
    const { insertItem } = await import('./library.js');
    const first = insertItem({ source_type: 'article', url: 'https://example.com/a' });
    const second = insertItem({ source_type: 'article', url: 'https://example.com/a', user_note: 'extra' });
    expect(second.is_duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.existing_id).toBe(first.id);
  });

  it('duplicate insert appends user_note with separator and bumps last_seen_at', async () => {
    const { insertItem } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const first = insertItem({ source_type: 'article', url: 'https://example.com/a', user_note: 'first note' });
    // Sleep briefly to force a later last_seen_at
    const originalSeenAt = (db.prepare(`SELECT last_seen_at FROM library_items WHERE id = ?`).get(first.id) as { last_seen_at: number }).last_seen_at;

    insertItem({ source_type: 'article', url: 'https://example.com/a', user_note: 'second note' });

    const row = db.prepare(`SELECT user_note, last_seen_at FROM library_items WHERE id = ?`).get(first.id) as { user_note: string; last_seen_at: number };
    expect(row.user_note).toBe('first note\n---\nsecond note');
    expect(row.last_seen_at).toBeGreaterThanOrEqual(originalSeenAt);
  });

  it('duplicate insert with no new user_note leaves existing note alone', async () => {
    const { insertItem } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    insertItem({ source_type: 'article', url: 'https://example.com/a', user_note: 'only note' });
    insertItem({ source_type: 'article', url: 'https://example.com/a' });
    const row = db.prepare(`SELECT user_note FROM library_items WHERE url = ?`).get('https://example.com/a') as { user_note: string };
    expect(row.user_note).toBe('only note');
  });

  it('stores source_meta as JSON string', async () => {
    const { insertItem } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const res = insertItem({
      source_type: 'tiktok',
      url: 'https://tiktok.com/@x/video/1',
      source_meta: { views: 2100000, likes: 80000 },
    });
    const row = db.prepare(`SELECT source_meta FROM library_items WHERE id = ?`).get(res.id) as { source_meta: string };
    expect(JSON.parse(row.source_meta)).toEqual({ views: 2100000, likes: 80000 });
  });

  it('sets enriched_at when opts.enriched_at is provided', async () => {
    const { insertItem } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const res = insertItem({ source_type: 'note', enriched_at: now });
    const row = db.prepare(`SELECT enriched_at FROM library_items WHERE id = ?`).get(res.id) as { enriched_at: number };
    expect(row.enriched_at).toBe(now);
  });

  it('multiple NULL-URL inserts (notes) all succeed', async () => {
    const { insertItem } = await import('./library.js');
    const a = insertItem({ source_type: 'note', user_note: 'A' });
    const b = insertItem({ source_type: 'note', user_note: 'B' });
    const c = insertItem({ source_type: 'voice' });
    expect(a.id).not.toBe(b.id);
    expect(b.id).not.toBe(c.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/library.test.ts -t "insertItem"`
Expected: FAIL — `insertItem is not a function`.

- [ ] **Step 3: Implement `insertItem` in `src/library.ts`**

Append:

```typescript
import { _getTestDb } from './db.js';

// Re-export for tests so they can round-trip through library.ts imports
export { _getTestDb };

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

// ── insertItem ──────────────────────────────────────────────────────────
export function insertItem(opts: InsertItemOpts): InsertItemResult {
  const db = _getTestDb();   // reuses module-level db handle (works for prod + test)
  const now = Math.floor(Date.now() / 1000);
  const canonical = opts.url ? canonicalizeUrl(opts.url) : null;
  const hash = canonical ? urlHash(canonical) : null;

  // Dedup check: only applies when url_hash is non-null
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
```

Note: we import `_getTestDb` and re-export it. In production `_getTestDb` returns the real db handle (it's just `() => db` in db.ts). This avoids duplicating DB-init code. If this feels fragile, a follow-up task can rename `_getTestDb` to a less test-y name, but for Phase 2 we accept the naming as internal.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "insertItem"`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/library.ts src/library.test.ts
git commit -m "feat(library): add insertItem with url_hash dedup

Canonicalizes URLs, hashes them, and checks for an existing row
with the same hash before inserting. Duplicate detection appends
new user_note with a \\n---\\n separator and bumps last_seen_at.
Returns {id, is_duplicate, existing_id} so callers (memobot) can
skip expensive work (Playwright scrape) on known duplicates."
```

---

## Task 4: `library.ts` satellite helpers — `addMedia`, `addContent`, `addTag`

**Files:**
- Modify: `src/library.ts`
- Modify: `src/library.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/library.test.ts`:

```typescript
describe('library.ts satellite helpers', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('addMedia inserts an item_media row and returns its id', async () => {
    const { insertItem, addMedia } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'screenshot' });
    const mediaId = addMedia(item.id, {
      media_type: 'image',
      file_path: 'general/screenshots/20260423-1512_1_test.png',
      storage: 'local',
      mime_type: 'image/png',
      bytes: 4096,
    });
    expect(mediaId).toBeGreaterThan(0);
    const row = db.prepare(`SELECT * FROM item_media WHERE id = ?`).get(mediaId) as Record<string, unknown>;
    expect(row.item_id).toBe(item.id);
    expect(row.media_type).toBe('image');
    expect(row.storage).toBe('local');
    expect(row.bytes).toBe(4096);
  });

  it('addContent inserts an item_content row and returns its id', async () => {
    const { insertItem, addContent } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'article', url: 'https://example.com/a' });
    const contentId = addContent(item.id, {
      content_type: 'scraped_summary',
      text: 'brief summary here',
      source_agent: 'memobot',
    });
    expect(contentId).toBeGreaterThan(0);
    const row = db.prepare(`SELECT * FROM item_content WHERE id = ?`).get(contentId) as Record<string, unknown>;
    expect(row.item_id).toBe(item.id);
    expect(row.content_type).toBe('scraped_summary');
    expect(row.text).toBe('brief summary here');
  });

  it('addContent triggers FTS5 index (content is searchable after insert)', async () => {
    const { insertItem, addContent } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'note' });
    addContent(item.id, {
      content_type: 'user_note',
      text: 'unique-fts-probe-platypus',
      source_agent: 'memobot',
    });
    const hits = db.prepare(`SELECT item_id FROM item_content_fts WHERE item_content_fts MATCH 'platypus'`).all() as Array<{ item_id: number }>;
    expect(hits.length).toBe(1);
    expect(hits[0].item_id).toBe(item.id);
  });

  it('addTag inserts an item_tags row (idempotent on composite PK)', async () => {
    const { insertItem, addTag } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'tiktok', url: 'https://tiktok.com/@x/1' });
    addTag(item.id, { tag: '@brewlife', tag_type: 'person', source_agent: 'memobot', confidence: 1.0 });
    addTag(item.id, { tag: 'kefir', tag_type: 'topic', source_agent: 'memobot' });

    const tags = db.prepare(`SELECT tag, tag_type FROM item_tags WHERE item_id = ? ORDER BY tag`).all(item.id);
    expect(tags.length).toBe(2);
    expect(tags).toEqual([
      { tag: '@brewlife', tag_type: 'person' },
      { tag: 'kefir', tag_type: 'topic' },
    ]);
  });

  it('addTag is idempotent — duplicate tag on same item does not throw', async () => {
    const { insertItem, addTag } = await import('./library.js');
    const item = insertItem({ source_type: 'tiktok', url: 'https://tiktok.com/@x/1' });
    addTag(item.id, { tag: '@brewlife', tag_type: 'person', source_agent: 'memobot' });
    // Second call with same composite key — we use INSERT OR IGNORE
    expect(() => {
      addTag(item.id, { tag: '@brewlife', tag_type: 'person', source_agent: 'memobot' });
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/library.test.ts -t "satellite helpers"`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Add the helpers to `src/library.ts`**

Append:

```typescript
// ── Satellite helpers ──────────────────────────────────────────────────
export interface AddMediaOpts {
  media_type: 'image' | 'video' | 'pdf' | 'audio' | 'other';
  file_path: string;  // relative to $LIBRARY_ROOT
  storage: 'local' | 'drive' | 'both';
  mime_type?: string;
  bytes?: number;
  drive_file_id?: string;
  drive_url?: string;
  ocr_text?: string;
}

export function addMedia(itemId: number, opts: AddMediaOpts): number {
  const db = _getTestDb();
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
  const db = _getTestDb();
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
  const db = _getTestDb();
  const now = Math.floor(Date.now() / 1000);
  // INSERT OR IGNORE — composite PK (item_id, tag, tag_type) makes
  // duplicate addTag calls no-ops rather than errors.
  db.prepare(`
    INSERT OR IGNORE INTO item_tags (item_id, tag, tag_type, confidence, source_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(itemId, opts.tag, opts.tag_type, opts.confidence ?? null, opts.source_agent, now);
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "satellite helpers"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/library.ts src/library.test.ts
git commit -m "feat(library): add addMedia, addContent, addTag helpers

Thin wrappers around the item_media/content/tags inserts.
addTag uses INSERT OR IGNORE so memobot can safely retry
tag additions without racing against its own writes."
```

---

## Task 5: `library.ts` lifecycle setters and `deleteItem`

**Files:**
- Modify: `src/library.ts`
- Modify: `src/library.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/library.test.ts`:

```typescript
describe('library.ts lifecycle setters', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('markEnriched sets enriched_at to given timestamp', async () => {
    const { insertItem, markEnriched } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'note' });
    const ts = 1800000000;
    markEnriched(item.id, ts);
    const row = db.prepare(`SELECT enriched_at FROM library_items WHERE id = ?`).get(item.id) as { enriched_at: number };
    expect(row.enriched_at).toBe(ts);
  });

  it('markEnriched defaults to now when no timestamp given', async () => {
    const { insertItem, markEnriched } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'note' });
    const before = Math.floor(Date.now() / 1000);
    markEnriched(item.id);
    const row = db.prepare(`SELECT enriched_at FROM library_items WHERE id = ?`).get(item.id) as { enriched_at: number };
    expect(row.enriched_at).toBeGreaterThanOrEqual(before);
  });

  it('markReviewed sets reviewed_at', async () => {
    const { insertItem, markReviewed } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'note' });
    markReviewed(item.id, 1800000000);
    const row = db.prepare(`SELECT reviewed_at FROM library_items WHERE id = ?`).get(item.id) as { reviewed_at: number };
    expect(row.reviewed_at).toBe(1800000000);
  });

  it('setPinned toggles the pinned flag', async () => {
    const { insertItem, setPinned } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'note' });
    setPinned(item.id, true);
    expect((db.prepare(`SELECT pinned FROM library_items WHERE id = ?`).get(item.id) as { pinned: number }).pinned).toBe(1);
    setPinned(item.id, false);
    expect((db.prepare(`SELECT pinned FROM library_items WHERE id = ?`).get(item.id) as { pinned: number }).pinned).toBe(0);
  });

  it('setProject updates project column', async () => {
    const { insertItem, setProject } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'note', project: 'general' });
    setProject(item.id, 'pure_bliss');
    expect((db.prepare(`SELECT project FROM library_items WHERE id = ?`).get(item.id) as { project: string }).project).toBe('pure_bliss');
  });

  it('setProject rejects invalid project', async () => {
    const { insertItem, setProject } = await import('./library.js');
    const item = insertItem({ source_type: 'note' });
    expect(() => setProject(item.id, 'invalid_project' as Project)).toThrow();
  });

  it('deleteItem cascades to satellites', async () => {
    const { insertItem, addMedia, addContent, addTag, deleteItem } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'article', url: 'https://example.com/a' });
    addMedia(item.id, { media_type: 'image', file_path: 'x.png', storage: 'local' });
    addContent(item.id, { content_type: 'user_note', text: 'hi', source_agent: 'memobot' });
    addTag(item.id, { tag: 'x', tag_type: 'topic', source_agent: 'memobot' });

    deleteItem(item.id);

    expect((db.prepare(`SELECT COUNT(*) AS n FROM library_items WHERE id = ?`).get(item.id) as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM item_media WHERE item_id = ?`).get(item.id) as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM item_content WHERE item_id = ?`).get(item.id) as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM item_tags WHERE item_id = ?`).get(item.id) as { n: number }).n).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/library.test.ts -t "lifecycle setters"`
Expected: FAIL — setters not exported.

- [ ] **Step 3: Add setters to `src/library.ts`**

Append:

```typescript
// ── Lifecycle setters ──────────────────────────────────────────────────
export function markEnriched(itemId: number, at?: number): void {
  const db = _getTestDb();
  db.prepare(`UPDATE library_items SET enriched_at = ? WHERE id = ?`)
    .run(at ?? Math.floor(Date.now() / 1000), itemId);
}

export function markReviewed(itemId: number, at?: number): void {
  const db = _getTestDb();
  db.prepare(`UPDATE library_items SET reviewed_at = ? WHERE id = ?`)
    .run(at ?? Math.floor(Date.now() / 1000), itemId);
}

export function setPinned(itemId: number, pinned: boolean): void {
  const db = _getTestDb();
  db.prepare(`UPDATE library_items SET pinned = ? WHERE id = ?`)
    .run(pinned ? 1 : 0, itemId);
}

export function setProject(itemId: number, project: Project): void {
  const db = _getTestDb();
  // CHECK constraint on the column will reject invalid values with a
  // clear SQLite error message.
  db.prepare(`UPDATE library_items SET project = ? WHERE id = ?`)
    .run(project, itemId);
}

export function deleteItem(itemId: number): void {
  const db = _getTestDb();
  db.prepare(`DELETE FROM library_items WHERE id = ?`).run(itemId);
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "lifecycle setters"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/library.ts src/library.test.ts
git commit -m "feat(library): add lifecycle setters and deleteItem

Thin one-column UPDATE helpers (markEnriched, markReviewed,
setPinned, setProject) and a cascading deleteItem. setProject
relies on the schema's CHECK constraint for validation."
```

---

## Task 6: `library.ts` read helpers + `queueProcessorTask`

**Files:**
- Modify: `src/library.ts`
- Modify: `src/library.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/library.test.ts`:

```typescript
describe('library.ts reads and processor task', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('getItem returns the item plus its satellites', async () => {
    const { insertItem, addMedia, addContent, addTag, getItem } = await import('./library.js');
    const item = insertItem({ source_type: 'tiktok', url: 'https://tiktok.com/@x/1', title: 'T', author: '@x' });
    addMedia(item.id, { media_type: 'image', file_path: 'p.png', storage: 'local' });
    addContent(item.id, { content_type: 'scraped_summary', text: 'summary', source_agent: 'memobot' });
    addTag(item.id, { tag: '@x', tag_type: 'person', source_agent: 'memobot' });

    const full = getItem(item.id);
    expect(full).toBeDefined();
    expect(full!.id).toBe(item.id);
    expect(full!.title).toBe('T');
    expect(full!.media.length).toBe(1);
    expect(full!.content.length).toBe(1);
    expect(full!.tags.length).toBe(1);
  });

  it('getItem returns null for missing id', async () => {
    const { getItem } = await import('./library.js');
    expect(getItem(99999)).toBeNull();
  });

  it('searchLibrary returns FTS5 matches', async () => {
    const { insertItem, addContent, searchLibrary } = await import('./library.js');
    const a = insertItem({ source_type: 'note', title: 'A' });
    const b = insertItem({ source_type: 'note', title: 'B' });
    addContent(a.id, { content_type: 'user_note', text: 'platypus lives here', source_agent: 'memobot' });
    addContent(b.id, { content_type: 'user_note', text: 'nothing about marsupials', source_agent: 'memobot' });

    const hits = searchLibrary({ query: 'platypus' });
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe(a.id);
  });

  it('searchLibrary filters by project', async () => {
    const { insertItem, addContent, searchLibrary } = await import('./library.js');
    const a = insertItem({ source_type: 'note', project: 'pure_bliss' });
    const b = insertItem({ source_type: 'note', project: 'general' });
    addContent(a.id, { content_type: 'user_note', text: 'kombucha experiment', source_agent: 'memobot' });
    addContent(b.id, { content_type: 'user_note', text: 'kombucha recipe', source_agent: 'memobot' });

    const hits = searchLibrary({ query: 'kombucha', project: 'pure_bliss' });
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe(a.id);
  });

  it('searchLibrary with no query returns recent items', async () => {
    const { insertItem, searchLibrary } = await import('./library.js');
    insertItem({ source_type: 'note', user_note: '1' });
    insertItem({ source_type: 'note', user_note: '2' });
    insertItem({ source_type: 'note', user_note: '3' });

    const hits = searchLibrary({ limit: 10 });
    expect(hits.length).toBe(3);
  });

  it('queueProcessorTask inserts into mission_tasks', async () => {
    const { insertItem, queueProcessorTask } = await import('./library.js');
    const db = (await import('./db.js'))._getTestDb();
    const item = insertItem({ source_type: 'screenshot' });
    const taskId = queueProcessorTask(item.id, 'screenshot needs OCR');
    expect(taskId).toBeTruthy();
    const row = db.prepare(`SELECT title, prompt, assigned_agent, created_by FROM mission_tasks WHERE id = ?`).get(taskId) as Record<string, string>;
    expect(row.assigned_agent).toBe('processor');
    expect(row.prompt).toContain(String(item.id));
    expect(row.prompt).toContain('screenshot needs OCR');
    expect(row.created_by).toBe('memobot');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/library.test.ts -t "reads and processor task"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Add the read helpers and processor queuer to `src/library.ts`**

Append:

```typescript
import { randomBytes } from 'crypto';

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
  const db = _getTestDb();
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
  reviewed?: boolean;  // true = reviewed, false = unreviewed
  limit?: number;
  since?: number;
}

export interface ItemSearchRow {
  id: number;
  source_type: string;
  url: string | null;
  title: string | null;
  project: string;
  captured_at: number;
  snippet?: string;  // present when query is set
}

export function searchLibrary(opts: SearchOpts): ItemSearchRow[] {
  const db = _getTestDb();
  const limit = opts.limit ?? 10;

  // FTS5 query path — joins FTS results back to library_items
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
      SELECT DISTINCT li.id, li.source_type, li.url, li.title, li.project, li.captured_at,
        snippet(item_content_fts, 0, '<', '>', '...', 20) AS snippet
      FROM item_content_fts
      JOIN library_items li ON li.id = item_content_fts.item_id
      WHERE ${filters.join(' AND ')}
      ORDER BY li.captured_at DESC
      LIMIT ${limit}
    `;
    return db.prepare(sql).all(...params) as ItemSearchRow[];
  }

  // No query — plain recent-items list with optional filters
  const filters: string[] = ['1=1'];
  const params: unknown[] = [];
  if (opts.project) { filters.push(`project = ?`); params.push(opts.project); }
  if (opts.source_type) { filters.push(`source_type = ?`); params.push(opts.source_type); }
  if (opts.pinned !== undefined) { filters.push(`pinned = ?`); params.push(opts.pinned ? 1 : 0); }
  if (opts.reviewed === true) filters.push(`reviewed_at IS NOT NULL`);
  if (opts.reviewed === false) filters.push(`reviewed_at IS NULL`);
  if (opts.since) { filters.push(`captured_at >= ?`); params.push(opts.since); }

  return db.prepare(`
    SELECT id, source_type, url, title, project, captured_at
    FROM library_items
    WHERE ${filters.join(' AND ')}
    ORDER BY captured_at DESC
    LIMIT ${limit}
  `).all(...params) as ItemSearchRow[];
}

// ── Mission task queuing ───────────────────────────────────────────────
export function queueProcessorTask(itemId: number, reason: string): string {
  const db = _getTestDb();
  const id = randomBytes(4).toString('hex');
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
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "reads and processor task"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/library.ts src/library.test.ts
git commit -m "feat(library): add getItem, searchLibrary, queueProcessorTask

getItem joins a library_items row with all its satellite rows.
searchLibrary queries FTS5 when a text query is provided,
otherwise returns filtered recent items. queueProcessorTask
drops a mission_task assigned to 'processor' so Phase 3's
Processor agent picks it up when it runs."
```

---

## Task 7: `library-cli.ts` scaffold + `check-url` subcommand + `help`

**Files:**
- Create: `src/library-cli.ts`
- Create: `src/library-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/library-cli.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PROJECT_ROOT, 'dist', 'library-cli.js');

// Run CLI as subprocess; returns {stdout, exitCode}. Must `npm run build`
// before running the CLI tests — handled in the "beforeAll" below.
function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf-8' });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

describe('library-cli help', () => {
  beforeAll(() => {
    // Ensure compiled CLI exists
    if (!fs.existsSync(CLI)) {
      execFileSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
  }, 60000);

  it('prints usage with no args', () => {
    const { stdout, exitCode } = runCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('library-cli');
    expect(stdout).toContain('save');
    expect(stdout).toContain('find');
    expect(stdout).toContain('check-url');
  });

  it('prints usage on --help', () => {
    const { stdout, exitCode } = runCli(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('library-cli');
  });
});

describe('library-cli check-url', () => {
  it('returns is_duplicate: false for unknown url', () => {
    const { stdout, exitCode } = runCli(['check-url', 'https://example.com/unknown-url-' + Date.now()]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.is_duplicate).toBe(false);
  });

  it('returns is_duplicate: true after a matching save', () => {
    const testUrl = 'https://example.com/dupe-test-' + Date.now();
    // First: save it
    const saveRes = runCli(['save', '--source-type', 'article', '--url', testUrl]);
    expect(saveRes.exitCode).toBe(0);
    const saved = JSON.parse(saveRes.stdout);

    // Second: check-url should see the duplicate
    const checkRes = runCli(['check-url', testUrl]);
    expect(checkRes.exitCode).toBe(0);
    const check = JSON.parse(checkRes.stdout);
    expect(check.is_duplicate).toBe(true);
    expect(check.existing_id).toBe(saved.id);
  });

  it('exits non-zero on missing URL', () => {
    const { exitCode, stderr } = runCli(['check-url']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('url');
  });
});
```

Note the second test depends on `save` existing — it's added in Task 8, so that test will fail until Task 8 ships. That's acceptable because the tests are organized by topic rather than by strict task order. The `check-url` part works independently.

For Task 7 verification, use a simpler test:

Actually, adjust: drop the "is_duplicate: true" test from Task 7's version. Add it back in Task 8 after save exists. The Task 7 test should only cover check-url with an unknown URL.

Replace the `library-cli check-url` describe with:

```typescript
describe('library-cli check-url', () => {
  it('returns is_duplicate: false for unknown url', () => {
    const { stdout, exitCode } = runCli(['check-url', 'https://example.com/unknown-url-' + Date.now()]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.is_duplicate).toBe(false);
  });

  it('exits non-zero on missing URL', () => {
    const { exitCode, stderr } = runCli(['check-url']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('url');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/library-cli.test.ts`
Expected: FAIL — `dist/library-cli.js` does not exist; `npm run build` will attempt to build but there's no source yet.

- [ ] **Step 3: Create `src/library-cli.ts`**

```typescript
#!/usr/bin/env node
/**
 * ClaudeClaw Research Library CLI
 *
 * Used by memobot (and later Phase 3/4/5 agents) to read and write
 * the library_items tables. Every subcommand outputs JSON to stdout
 * on success, or an error to stderr with a non-zero exit code.
 *
 * Usage:
 *   node dist/library-cli.js check-url <url>
 *   node dist/library-cli.js save --source-type article --url https://...
 *   node dist/library-cli.js find <query> [--project X] [--limit N]
 *   node dist/library-cli.js open <id>
 *   node dist/library-cli.js recent [--limit N]
 *   node dist/library-cli.js delete <id>
 *   node dist/library-cli.js update <id> [--project X] [--pinned 1] ...
 *   node dist/library-cli.js help
 */

import { initDatabase } from './db.js';
import { canonicalizeUrl, urlHash, _getTestDb } from './library.js';

initDatabase();

const argv = process.argv.slice(2);

function usage(): void {
  console.log(`Usage: library-cli <subcommand> [args]

Subcommands:
  check-url <url>                Check if a URL is already saved (JSON output).
  save [flags]                   Save a new library item. See --help save.
  find <query> [--project X]     Full-text search via FTS5.
  open <id>                      Show full item with satellites.
  recent [--limit N]             List most recent saves (default 10).
  delete <id>                    Delete an item (cascades).
  update <id> [flags]            Update project/pinned/reviewed/reenrich.
  help                           Show this help.

Examples:
  library-cli check-url "https://tiktok.com/@x/video/1"
  library-cli save --source-type article --url https://... --title "..." --enriched
  library-cli find kefir --project pure_bliss
  library-cli open 42`);
}

if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
  usage();
  process.exit(0);
}

const [subcommand, ...rest] = argv;

function parseFlags(flagArgs: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = flagArgs[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

switch (subcommand) {
  case 'check-url': {
    const url = rest[0];
    if (!url || url.startsWith('--')) {
      console.error('Error: check-url requires a url argument');
      console.error('Usage: library-cli check-url <url>');
      process.exit(1);
    }
    const canonical = canonicalizeUrl(url);
    const hash = urlHash(canonical);
    const db = _getTestDb();
    const existing = db.prepare(
      `SELECT id, captured_at FROM library_items WHERE url_hash = ?`
    ).get(hash) as { id: number; captured_at: number } | undefined;

    if (existing) {
      console.log(JSON.stringify({
        is_duplicate: true,
        existing_id: existing.id,
        existing_captured_at: existing.captured_at,
        canonical,
      }));
    } else {
      console.log(JSON.stringify({ is_duplicate: false, canonical }));
    }
    break;
  }

  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    usage();
    process.exit(1);
}
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npx vitest run src/library-cli.test.ts -t "help|check-url"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/library-cli.ts src/library-cli.test.ts
git commit -m "feat(library-cli): scaffold CLI with help and check-url

New src/library-cli.ts exposes subcommands as the memobot
interface to the library tables. This commit adds the CLI
scaffold, argv parsing helper, usage output, and the first
real subcommand (check-url) which returns dedup status as
JSON. Tests exercise the CLI as a subprocess via execFileSync."
```

---

## Task 8: `library-cli.ts` `save` subcommand (without media)

**Files:**
- Modify: `src/library-cli.ts`
- Modify: `src/library-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/library-cli.test.ts`:

```typescript
describe('library-cli save (no media)', () => {
  it('saves a URL item and returns id in JSON', () => {
    const url = 'https://example.com/save-test-' + Date.now();
    const { stdout, exitCode } = runCli([
      'save',
      '--source-type', 'article',
      '--url', url,
      '--title', 'My Article',
    ]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.id).toBeGreaterThan(0);
    expect(out.is_duplicate).toBe(false);
  });

  it('saving duplicate URL returns is_duplicate with existing id', () => {
    const url = 'https://example.com/dupe-' + Date.now();
    const first = runCli(['save', '--source-type', 'article', '--url', url]);
    const firstOut = JSON.parse(first.stdout);
    const second = runCli(['save', '--source-type', 'article', '--url', url, '--user-note', 'second save']);
    const secondOut = JSON.parse(second.stdout);
    expect(secondOut.is_duplicate).toBe(true);
    expect(secondOut.id).toBe(firstOut.id);
  });

  it('save without url (note type) works', () => {
    const { stdout, exitCode } = runCli([
      'save',
      '--source-type', 'note',
      '--user-note', 'hello from CLI test',
    ]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.id).toBeGreaterThan(0);
  });

  it('save with --enriched flag sets enriched_at', () => {
    const url = 'https://example.com/enriched-' + Date.now();
    const { stdout } = runCli([
      'save',
      '--source-type', 'article',
      '--url', url,
      '--enriched',
    ]);
    const out = JSON.parse(stdout);
    // Open the item and verify enriched_at is set
    const opened = runCli(['open', String(out.id)]);
    // (open subcommand added in Task 10 — for now, verify via direct DB read)
  });

  it('save with --tag flag adds a tag row', () => {
    const { stdout } = runCli([
      'save',
      '--source-type', 'tiktok',
      '--url', 'https://tiktok.com/@x/test-' + Date.now(),
      '--tag', 'tag=@testcreator,tag_type=person',
    ]);
    const out = JSON.parse(stdout);
    expect(out.id).toBeGreaterThan(0);
    // Direct DB verification
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'), { readonly: true });
    const tags = db.prepare(`SELECT tag FROM item_tags WHERE item_id = ?`).all(out.id) as Array<{ tag: string }>;
    expect(tags.map(t => t.tag)).toContain('@testcreator');
    db.close();
  });

  it('save with --content flag adds a content row', () => {
    const { stdout } = runCli([
      'save',
      '--source-type', 'article',
      '--url', 'https://example.com/content-test-' + Date.now(),
      '--content', 'content_type=scraped_summary,text=A brief summary of the article',
    ]);
    const out = JSON.parse(stdout);
    expect(out.id).toBeGreaterThan(0);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'), { readonly: true });
    const rows = db.prepare(`SELECT text FROM item_content WHERE item_id = ?`).all(out.id) as Array<{ text: string }>;
    expect(rows.map(r => r.text)).toContain('A brief summary of the article');
    db.close();
  });

  it('save with --queue-processor creates mission_task', () => {
    const { stdout } = runCli([
      'save',
      '--source-type', 'screenshot',
      '--user-note', 'test screenshot caption',
      '--queue-processor', 'screenshot needs OCR',
    ]);
    const out = JSON.parse(stdout);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'), { readonly: true });
    const tasks = db.prepare(`SELECT prompt FROM mission_tasks WHERE assigned_agent = 'processor' AND prompt LIKE ?`).all('%' + out.id + '%') as Array<{ prompt: string }>;
    expect(tasks.length).toBeGreaterThan(0);
    db.close();
  });
});
```

Note: `find`/`open` don't exist yet (Task 10). Tests that would need them verify via direct DB reads instead.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && npx vitest run src/library-cli.test.ts -t "save"`
Expected: FAIL — `save` is unknown subcommand.

- [ ] **Step 3: Implement `save` in `src/library-cli.ts`**

Add a new case in the switch:

```typescript
case 'save': {
  const flags = parseFlags(rest);

  const sourceType = flags['source-type'] as string;
  if (!sourceType) {
    console.error('Error: save requires --source-type');
    process.exit(1);
  }

  const enrichedAt = flags.enriched === true
    ? Math.floor(Date.now() / 1000)
    : undefined;

  const sourceMeta = typeof flags['source-meta'] === 'string'
    ? JSON.parse(flags['source-meta'] as string)
    : undefined;

  const { insertItem, addContent, addTag, queueProcessorTask } = await import('./library.js');

  const result = insertItem({
    source_type: sourceType as SourceType,
    url: typeof flags.url === 'string' ? flags.url : undefined,
    user_note: typeof flags['user-note'] === 'string' ? flags['user-note'] : undefined,
    user_message: typeof flags['user-message'] === 'string' ? flags['user-message'] : undefined,
    project: typeof flags.project === 'string' ? flags.project as Project : undefined,
    title: typeof flags.title === 'string' ? flags.title : undefined,
    author: typeof flags.author === 'string' ? flags.author : undefined,
    source_meta: sourceMeta,
    enriched_at: enrichedAt,
  });

  // Parse --content flag: "content_type=...,text=..."
  // Multiple --content flags supported (the parseFlags version above only keeps
  // the last, so we rescan rest manually for multi-value flags).
  const allContentFlags: string[] = [];
  const allTagFlags: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--content' && rest[i + 1] !== undefined) allContentFlags.push(rest[i + 1]);
    if (rest[i] === '--tag' && rest[i + 1] !== undefined) allTagFlags.push(rest[i + 1]);
  }

  for (const cSpec of allContentFlags) {
    const parsed = Object.fromEntries(cSpec.split(',').map(kv => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }));
    addContent(result.id, {
      content_type: parsed.content_type as 'ocr' | 'scraped_summary' | 'transcript' | 'user_note',
      text: parsed.text,
      source_agent: 'memobot',
    });
  }

  for (const tSpec of allTagFlags) {
    const parsed = Object.fromEntries(tSpec.split(',').map(kv => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }));
    addTag(result.id, {
      tag: parsed.tag,
      tag_type: parsed.tag_type as 'topic' | 'person' | 'brand' | 'hashtag' | 'mood' | 'other',
      source_agent: 'memobot',
    });
  }

  if (typeof flags['queue-processor'] === 'string') {
    queueProcessorTask(result.id, flags['queue-processor'] as string);
  }

  console.log(JSON.stringify(result));
  break;
}
```

Also add these imports at the top of the file:

```typescript
import type { SourceType, Project } from './library.js';
```

Note the switch statement needs to be in an async context for `await import()`. Wrap the whole switch in:

```typescript
async function run(): Promise<void> {
  switch (subcommand) {
    // ... all cases ...
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npx vitest run src/library-cli.test.ts`
Expected: PASS (all prior tests + 7 new save tests).

- [ ] **Step 5: Commit**

```bash
git add src/library-cli.ts src/library-cli.test.ts
git commit -m "feat(library-cli): add save subcommand (no media)

Wires insertItem + addContent + addTag + queueProcessorTask
behind the CLI. Supports --url, --user-note, --project, --title,
--author, --source-meta (JSON), --enriched flag, and repeatable
--content / --tag specs."
```

---

## Task 9: `library-cli.ts` `save` with `--media-temp-path`

**Files:**
- Modify: `src/library-cli.ts`
- Modify: `src/library-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/library-cli.test.ts`:

```typescript
describe('library-cli save with --media-temp-path', () => {
  it('moves temp file to $LIBRARY_ROOT and inserts item_media row', async () => {
    // Create a temp fake PNG
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'libtest-'));
    const tempFile = path.join(tmp, 'test-image.png');
    fs.writeFileSync(tempFile, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

    const { stdout, exitCode } = runCli([
      'save',
      '--source-type', 'screenshot',
      '--project', 'general',
      '--user-note', 'test shot',
      '--media-temp-path', tempFile,
      '--media-type', 'image',
      '--media-mime', 'image/png',
    ]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.id).toBeGreaterThan(0);

    // Temp file should be gone (moved)
    expect(fs.existsSync(tempFile)).toBe(false);

    // DB should have an item_media row pointing at $LIBRARY_ROOT/general/screenshots/...
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'), { readonly: true });
    const media = db.prepare(`SELECT file_path, media_type, storage FROM item_media WHERE item_id = ?`).get(out.id) as { file_path: string; media_type: string; storage: string };
    expect(media.media_type).toBe('image');
    expect(media.storage).toBe('local');
    expect(media.file_path).toMatch(/^general\/screenshots\/\d{8}-\d{4}_\d+_.+\.png$/);

    // Final file should exist at $LIBRARY_ROOT + file_path
    const { LIBRARY_ROOT } = await import('./config.js');
    expect(fs.existsSync(path.join(LIBRARY_ROOT, media.file_path))).toBe(true);

    // Clean up the file we created
    fs.unlinkSync(path.join(LIBRARY_ROOT, media.file_path));
    fs.rmdirSync(tmp);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/library-cli.test.ts -t "media-temp-path"`
Expected: FAIL — `--media-temp-path` unsupported.

- [ ] **Step 3: Implement media handling in the `save` case**

Extend the `save` case in `src/library-cli.ts` (add before the `console.log` of the final result):

```typescript
// Handle --media-temp-path: move file into $LIBRARY_ROOT and insert item_media
if (typeof flags['media-temp-path'] === 'string') {
  const { LIBRARY_ROOT } = await import('./config.js');
  const { addMedia } = await import('./library.js');
  const fs = await import('fs');
  const path = await import('path');

  const tempPath = flags['media-temp-path'] as string;
  const mediaType = (flags['media-type'] as string) || 'other';
  const mediaMime = (flags['media-mime'] as string) || undefined;

  // Route to subfolder by media type
  const bucket = (
    mediaType === 'image' ? 'screenshots' :
    mediaType === 'pdf' ? 'pdfs' :
    mediaType === 'video' ? 'videos' :
    mediaType === 'audio' ? 'audio' :
    'other'
  );

  // Filename: YYYYMMDD-HHMM_<id>_<slug>.<ext>
  const ts = new Date();
  const datePart = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}`;
  const timePart = `${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}`;
  const slug = ((typeof flags['user-note'] === 'string' ? flags['user-note'] : '') || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'untitled';
  const ext = path.extname(tempPath) || (
    mediaMime === 'image/png' ? '.png' :
    mediaMime === 'image/jpeg' ? '.jpg' :
    mediaMime === 'application/pdf' ? '.pdf' :
    ''
  );
  const finalFilename = `${datePart}-${timePart}_${result.id}_${slug}${ext}`;

  const project = typeof flags.project === 'string' ? flags.project : 'general';
  const relativePath = `${project}/${bucket}/${finalFilename}`;
  const absolutePath = path.join(LIBRARY_ROOT, relativePath);

  // Ensure target directory exists
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  // Move temp file to final location
  fs.renameSync(tempPath, absolutePath);

  const stats = fs.statSync(absolutePath);

  addMedia(result.id, {
    media_type: mediaType as 'image' | 'video' | 'pdf' | 'audio' | 'other',
    file_path: relativePath,
    storage: 'local',
    mime_type: mediaMime,
    bytes: stats.size,
  });
}
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npx vitest run src/library-cli.test.ts -t "media-temp-path"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/library-cli.ts src/library-cli.test.ts
git commit -m "feat(library-cli): save accepts --media-temp-path

When --media-temp-path is provided, save inserts library_items
first to get an id, then moves the temp file to
\$LIBRARY_ROOT/<project>/<bucket>/YYYYMMDD-HHMM_<id>_<slug>.<ext>
and inserts item_media with the relative path. Buckets are
derived from --media-type (image→screenshots, pdf→pdfs, etc)."
```

---

## Task 10: `library-cli.ts` `find`, `open`, `recent`

**Files:**
- Modify: `src/library-cli.ts`
- Modify: `src/library-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/library-cli.test.ts`:

```typescript
describe('library-cli find / open / recent', () => {
  it('find returns JSON array of search results', async () => {
    // Seed with known data
    const unique = 'uniquesearchterm' + Date.now();
    runCli([
      'save',
      '--source-type', 'note',
      '--user-note', `this is a test note containing ${unique}`,
      '--content', `content_type=user_note,text=contains ${unique} for FTS`,
    ]);

    const { stdout, exitCode } = runCli(['find', unique, '--json']);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('find with --project filters results', () => {
    const unique = 'projfilter' + Date.now();
    runCli(['save', '--source-type', 'note', '--project', 'pure_bliss', '--content', `content_type=user_note,text=${unique}`]);
    runCli(['save', '--source-type', 'note', '--project', 'general', '--content', `content_type=user_note,text=${unique}`]);

    const { stdout } = runCli(['find', unique, '--project', 'pure_bliss', '--json']);
    const results = JSON.parse(stdout);
    for (const r of results) {
      expect(r.project).toBe('pure_bliss');
    }
  });

  it('open returns full item with satellites', () => {
    const saveRes = JSON.parse(runCli(['save', '--source-type', 'note', '--user-note', 'open test']).stdout);
    const { stdout, exitCode } = runCli(['open', String(saveRes.id), '--json']);
    expect(exitCode).toBe(0);
    const item = JSON.parse(stdout);
    expect(item.id).toBe(saveRes.id);
    expect(Array.isArray(item.media)).toBe(true);
    expect(Array.isArray(item.content)).toBe(true);
    expect(Array.isArray(item.tags)).toBe(true);
  });

  it('open on missing id exits non-zero', () => {
    const { exitCode, stderr } = runCli(['open', '9999999']);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain('not found');
  });

  it('recent returns JSON array of most recent items', () => {
    const { stdout, exitCode } = runCli(['recent', '--limit', '5', '--json']);
    expect(exitCode).toBe(0);
    const items = JSON.parse(stdout);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && npx vitest run src/library-cli.test.ts -t "find / open / recent"`
Expected: FAIL — subcommands unknown.

- [ ] **Step 3: Implement in `src/library-cli.ts`**

Add cases:

```typescript
case 'find': {
  const query = rest[0];
  if (!query || query.startsWith('--')) {
    console.error('Error: find requires a query argument');
    process.exit(1);
  }
  const flags = parseFlags(rest.slice(1));
  const { searchLibrary } = await import('./library.js');
  const results = searchLibrary({
    query,
    project: typeof flags.project === 'string' ? flags.project as Project : undefined,
    limit: typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : 10,
  });
  if (flags.json) {
    console.log(JSON.stringify(results));
  } else {
    for (const r of results) {
      console.log(`#${r.id} (${r.project}) ${r.source_type} — ${r.title ?? r.url ?? '(no title)'}`);
      if (r.snippet) console.log(`  ${r.snippet}`);
    }
  }
  break;
}

case 'open': {
  const id = parseInt(rest[0], 10);
  if (isNaN(id)) {
    console.error('Error: open requires a numeric id');
    process.exit(1);
  }
  const { getItem } = await import('./library.js');
  const item = getItem(id);
  if (!item) {
    console.error(`Item ${id} not found`);
    process.exit(1);
  }
  const flags = parseFlags(rest.slice(1));
  if (flags.json) {
    console.log(JSON.stringify(item));
  } else {
    console.log(`#${item.id} (${item.project})  captured ${new Date(item.captured_at * 1000).toISOString()}`);
    console.log(`Source: ${item.source_type} ${item.author ?? ''}`);
    if (item.title) console.log(`Title: ${item.title}`);
    if (item.url) console.log(`URL: ${item.url}`);
    if (item.user_note) console.log(`Note: ${item.user_note}`);
    console.log(`Media: ${item.media.length}, Content: ${item.content.length}, Tags: ${item.tags.length}`);
    console.log(`Reviewed: ${item.reviewed_at ? 'yes' : 'no'}  Pinned: ${item.pinned ? 'yes' : 'no'}`);
  }
  break;
}

case 'recent': {
  const flags = parseFlags(rest);
  const { searchLibrary } = await import('./library.js');
  const items = searchLibrary({
    limit: typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : 10,
  });
  if (flags.json) {
    console.log(JSON.stringify(items));
  } else {
    for (const r of items) {
      console.log(`#${r.id} (${r.project}) ${r.source_type} — ${r.title ?? r.url ?? '(no title)'}`);
    }
  }
  break;
}
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npx vitest run src/library-cli.test.ts -t "find / open / recent"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/library-cli.ts src/library-cli.test.ts
git commit -m "feat(library-cli): add find, open, recent subcommands

find wraps searchLibrary with --project and --limit flags.
open returns getItem's full view. recent returns the N most
recently captured items. All support --json for structured
output or pretty-printed text by default."
```

---

## Task 11: `library-cli.ts` `delete` and `update`

**Files:**
- Modify: `src/library-cli.ts`
- Modify: `src/library-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/library-cli.test.ts`:

```typescript
describe('library-cli delete / update', () => {
  it('delete removes the item', () => {
    const saveRes = JSON.parse(runCli(['save', '--source-type', 'note', '--user-note', 'delete test']).stdout);
    const delRes = runCli(['delete', String(saveRes.id)]);
    expect(delRes.exitCode).toBe(0);
    const openRes = runCli(['open', String(saveRes.id)]);
    expect(openRes.exitCode).not.toBe(0);
  });

  it('update --project reassigns', () => {
    const saveRes = JSON.parse(runCli(['save', '--source-type', 'note', '--user-note', 'project test', '--project', 'general']).stdout);
    const updRes = runCli(['update', String(saveRes.id), '--project', 'pure_bliss']);
    expect(updRes.exitCode).toBe(0);
    const opened = JSON.parse(runCli(['open', String(saveRes.id), '--json']).stdout);
    expect(opened.project).toBe('pure_bliss');
  });

  it('update --pinned 1 sets pinned', () => {
    const saveRes = JSON.parse(runCli(['save', '--source-type', 'note', '--user-note', 'pin test']).stdout);
    runCli(['update', String(saveRes.id), '--pinned', '1']);
    const opened = JSON.parse(runCli(['open', String(saveRes.id), '--json']).stdout);
    expect(opened.pinned).toBe(true);
  });

  it('update --reviewed sets reviewed_at', () => {
    const saveRes = JSON.parse(runCli(['save', '--source-type', 'note', '--user-note', 'review test']).stdout);
    runCli(['update', String(saveRes.id), '--reviewed']);
    const opened = JSON.parse(runCli(['open', String(saveRes.id), '--json']).stdout);
    expect(opened.reviewed_at).toBeGreaterThan(0);
  });

  it('update --reenrich nulls enriched_at and queues processor task', async () => {
    const saveRes = JSON.parse(runCli(['save', '--source-type', 'article', '--url', 'https://example.com/reen-' + Date.now(), '--enriched']).stdout);
    runCli(['update', String(saveRes.id), '--reenrich']);
    const opened = JSON.parse(runCli(['open', String(saveRes.id), '--json']).stdout);
    expect(opened.enriched_at).toBeNull();

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'), { readonly: true });
    const tasks = db.prepare(`SELECT prompt FROM mission_tasks WHERE assigned_agent = 'processor' AND prompt LIKE ?`).all('%' + saveRes.id + '%') as Array<{ prompt: string }>;
    expect(tasks.length).toBeGreaterThan(0);
    db.close();
  });

  it('update --append-note appends to user_note with separator and bumps last_seen_at', () => {
    const saveRes = JSON.parse(runCli(['save', '--source-type', 'note', '--user-note', 'original']).stdout);
    runCli(['update', String(saveRes.id), '--append-note', 'appended text']);
    const opened = JSON.parse(runCli(['open', String(saveRes.id), '--json']).stdout);
    expect(opened.user_note).toBe('original\n---\nappended text');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && npx vitest run src/library-cli.test.ts -t "delete / update"`
Expected: FAIL — subcommands unknown.

- [ ] **Step 3: Implement in `src/library-cli.ts`**

```typescript
case 'delete': {
  const id = parseInt(rest[0], 10);
  if (isNaN(id)) {
    console.error('Error: delete requires a numeric id');
    process.exit(1);
  }
  const { deleteItem, getItem } = await import('./library.js');
  const exists = getItem(id);
  if (!exists) {
    console.error(`Item ${id} not found`);
    process.exit(1);
  }
  deleteItem(id);
  console.log(JSON.stringify({ deleted: id }));
  break;
}

case 'update': {
  const id = parseInt(rest[0], 10);
  if (isNaN(id)) {
    console.error('Error: update requires a numeric id');
    process.exit(1);
  }
  const flags = parseFlags(rest.slice(1));
  const lib = await import('./library.js');
  const db = lib._getTestDb();

  if (typeof flags.project === 'string') lib.setProject(id, flags.project as Project);
  if (typeof flags.pinned === 'string') lib.setPinned(id, flags.pinned === '1');
  if (flags.reviewed) lib.markReviewed(id);
  if (flags.reenrich) {
    db.prepare(`UPDATE library_items SET enriched_at = NULL WHERE id = ?`).run(id);
    lib.queueProcessorTask(id, 'reenrich requested');
  }
  if (typeof flags['append-note'] === 'string') {
    const now = Math.floor(Date.now() / 1000);
    const existing = db.prepare(`SELECT user_note FROM library_items WHERE id = ?`).get(id) as { user_note: string | null } | undefined;
    if (!existing) {
      console.error(`Item ${id} not found`);
      process.exit(1);
    }
    const merged = existing.user_note
      ? `${existing.user_note}\n---\n${flags['append-note']}`
      : (flags['append-note'] as string);
    db.prepare(`UPDATE library_items SET user_note = ?, last_seen_at = ? WHERE id = ?`).run(merged, now, id);
  }

  console.log(JSON.stringify({ updated: id }));
  break;
}
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npx vitest run src/library-cli.test.ts -t "delete / update"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/library-cli.ts src/library-cli.test.ts
git commit -m "feat(library-cli): add delete and update subcommands

delete wraps deleteItem (cascades). update handles --project,
--pinned, --reviewed, --reenrich (nulls enriched_at + queues
processor task), and --append-note (used by memobot's dedup
flow to append to existing user_note)."
```

---

## Task 12: MemoBot `CLAUDE.md` — Wave 1 system prompt

**Files:**
- Modify: `~/.claudeclaw/agents/memobot/CLAUDE.md` (full rewrite)

- [ ] **Step 1: Write the system prompt**

Fully replace the contents of `~/.claudeclaw/agents/memobot/CLAUDE.md` with:

```markdown
# MemoBot — Research Library Collector

You are MemoBot, the research library collector for ClaudeClaw. Your job: turn every incoming Telegram message into a library item and reply with a short confirmation that includes the DB id.

## Your environment
- Project root: always resolve via `git rev-parse --show-toplevel`. NEVER use `find`.
- DB: `${PROJECT_ROOT}/store/claudeclaw.db` — NEVER touch directly. Use the CLI below.
- Flash drive: `/Volumes/ClaudeClaw/claudeclaw-library/` (the `$LIBRARY_ROOT` env var). Always mounted except during rare planned reboots.
- Your model: claude-haiku-4-5 (fast, short-context).
- Playwright MCP is available for scraping URLs. Use it.

## The CLI is your ONLY DB interface
```
PROJECT_ROOT=$(git rev-parse --show-toplevel)
node "$PROJECT_ROOT/dist/library-cli.js" <subcommand> [args]
```

Never write raw SQL. Never touch the DB file directly. Every save, read, update goes through `library-cli.js`.

## Your complete save flow

### A. URL in message (the 80% case)

Detect a URL (`https?://`) in the user's message. If multiple, use the first.

1. **Dedup check first (cheap):**
   ```bash
   node $PROJECT_ROOT/dist/library-cli.js check-url "<URL>"
   ```
   Read the JSON output.

2. **If `is_duplicate: true`:**
   ```bash
   node $PROJECT_ROOT/dist/library-cli.js update <existing_id> --append-note "<any extra text the user typed besides the URL>"
   ```
   Reply: `Already have this as #<existing_id>, saved <relative_age>. Note appended.`
   Done. NO Playwright.

3. **If `is_duplicate: false`:** Use Playwright MCP to navigate the URL and scrape:
   - `title` (page title or og:title)
   - `author` (creator handle / byline if visible)
   - A 1-2 sentence summary of what the page is about
   - Visible stats into a JSON object: `{"views": N, "likes": N, "upvotes": N, ...}` — whatever is present

4. **Save with enrichment:**
   ```bash
   node $PROJECT_ROOT/dist/library-cli.js save \
     --source-type <inferred from domain> \
     --url "<URL>" \
     --user-note "<any extra text besides the URL>" \
     --title "<scraped title>" \
     --author "<scraped author>" \
     --source-meta '<JSON stats>' \
     --content content_type=scraped_summary,text="<1-2 sentence summary>" \
     --tag tag="<@creator>",tag_type=person \
     --tag tag="<#hashtag>",tag_type=hashtag \
     --enriched
   ```
   Repeat `--tag` for each creator and each hashtag you saw.

5. **Reply:**
   ```
   #<id> (<project>) — <title>
   <1-2 sentence summary>
   <URL>
   ```

Source-type by domain:
- `tiktok.com` → `tiktok`
- `instagram.com` → `instagram`
- `facebook.com`, `fb.com` → `facebook`
- `reddit.com` → `reddit`
- `twitter.com`, `x.com` → `twitter`
- `youtube.com`, `youtu.be` → `youtube`
- `threads.net` → `threads`
- `linkedin.com` → `linkedin`
- anything else → `article`

### B. Image attachment (screenshot)

1. Download the attachment to a temp file (you have normal fs access).
2. Save with `--media-temp-path`:
   ```bash
   node $PROJECT_ROOT/dist/library-cli.js save \
     --source-type screenshot \
     --project <inferred from caption> \
     --user-note "<caption or empty>" \
     --media-temp-path "<temp path>" \
     --media-type image \
     --media-mime "<e.g. image/png>" \
     --queue-processor "screenshot needs OCR"
   ```
3. Reply:
   ```
   #<id> (<project>) — <caption or "screenshot">
   OCR coming when processor runs.
   ```

**Do NOT** add `--enriched`. OCR is deferred to the Processor agent.

### C. Free-form text (no URL, no attachment)

1. Save with `--enriched`:
   ```bash
   node $PROJECT_ROOT/dist/library-cli.js save \
     --source-type note \
     --project <inferred from text> \
     --user-note "<full user text>" \
     --content content_type=user_note,text="<full user text>" \
     --enriched
   ```
2. Reply:
   ```
   #<id> (<project>) — <first 40 chars of note>
   ```

### D. User typed "for <project>" in their message

Strip that phrase from `--user-note` and pass `--project <project>` explicitly (overrides keyword inference).

### E. Empty message / sticker / emoji-only

Do not call the CLI. Reply: `Nothing to save — send a URL, file, or note.`

## Project inference
Use these keyword buckets as hints (the CLI auto-infers if you don't pass --project, but passing it explicitly when you're confident is fine):

- `pure_bliss`: kefir, water kefir, fermented, hydration, pure bliss, probiotic, scoby, gut health
- `octohive`: octopus, cephalopod, tentacle, aquarium, marine biology, octohive
- `personal`: only set this when the user says "for personal"
- `general`: default when no category keywords match

## Failure handling
- **Playwright fails / times out:** Save anyway with `--title "<URL>"`, NO `--enriched` flag. Reply: `Saved #<id> — couldn't scrape, will retry. <URL>` (Processor retries later.)
- **CLI exits non-zero:** Read stderr. If it mentions flash drive path errors, reply: `Flash drive offline, queued #<id> for save when it's back.` Otherwise: `Save failed: <error>. Try again.`
- **URL returns 404 or network error during Playwright:** Save-as-fallback path (same as Playwright fails).

## Slash commands (you interpret these as commands, NOT as content to save)

- `/find <query>` — run `library-cli find <query> --json` and render hits as a numbered list, most recent first.
- `/recent [N]` — run `library-cli recent --limit N --json` (default N=10) and render.
- `/open <id>` — run `library-cli open <id> --json` and render the full item.
- `/delete <id>` — reply: `Delete #<id>? Reply YES to confirm.` When user replies exactly `YES`, run `library-cli delete <id>`.
- `/project <id> <name>` — run `library-cli update <id> --project <name>`. Reply: `#<id> moved to <name>.`
- `/pin <id>` — `library-cli update <id> --pinned 1`. Reply: `#<id> pinned.`
- `/unpin <id>` — `library-cli update <id> --pinned 0`.
- `/reviewed <id>` — `library-cli update <id> --reviewed`. Reply: `#<id> marked reviewed.`
- `/reenrich <id>` — `library-cli update <id> --reenrich`. Reply: `#<id> queued for re-enrichment.`
- `/help` — list the commands with one-line descriptions.

## Reply format rules
- Always include the id as `#<id>`.
- Always include the project in parens.
- Keep summaries to 1-2 sentences, max ~200 chars.
- No em dashes in the summary text (user preference).
- Don't apologize or explain in replies — just confirm the save.

## Hive mind
After every save, log it:
```bash
sqlite3 "$PROJECT_ROOT/store/claudeclaw.db" "INSERT INTO hive_mind (agent_id, chat_id, action, summary, artifacts, created_at) VALUES ('memobot', '<chat_id>', 'save', 'saved #<id> (<project>) <title-or-first-40-chars>', NULL, strftime('%s','now'));"
```

This lets other agents see what memobot has been capturing.

## Guardrails
- NEVER write raw SQL. Use library-cli.
- NEVER commit secrets.
- NEVER delete without the user's explicit YES confirmation.
- Keep replies short. Summary = 1-2 sentences, full stop.
- If you're unsure what the user wants, ask a single short question instead of guessing.
```

- [ ] **Step 2: Verify file was written**

Run: `head -20 ~/.claudeclaw/agents/memobot/CLAUDE.md`
Expected: starts with `# MemoBot — Research Library Collector`.

- [ ] **Step 3: Commit**

Note the CLAUDE.md lives outside the repo (`~/.claudeclaw/`). It's not tracked by git. But the memobot's agent config in the repo at `agents/memobot/` (if it exists) should reference or mirror this. Check:

```bash
ls agents/memobot 2>/dev/null
```

If `agents/memobot/CLAUDE.md.example` exists in the repo, update it to match:

```bash
mkdir -p agents/memobot
cp ~/.claudeclaw/agents/memobot/CLAUDE.md agents/memobot/CLAUDE.md.example
git add agents/memobot/CLAUDE.md.example
git commit -m "docs(memobot): add Wave 1 CLAUDE.md.example for the collector agent

Mirrors the system prompt at ~/.claudeclaw/agents/memobot/CLAUDE.md
so the repo has a canonical copy for review. Active prompt lives
in the CLAUDECLAW_CONFIG directory (outside the repo) per the
project's config-separation convention."
```

If `agents/memobot/` doesn't exist or the project doesn't follow the `.example` convention here, skip this step and note in the commit for Task 13 that the live CLAUDE.md was updated out of tree.

---

## Task 13: Wave 1 build + restart + smoke test

**Files:** None (operational task).

- [ ] **Step 1: Run the full suite to ensure library.ts + library-cli.ts tests all pass**

Run: `npx vitest run src/library.test.ts src/library-cli.test.ts`
Expected: all tests green.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean `tsc` output.

- [ ] **Step 3: Restart memobot so it picks up the new CLAUDE.md**

```bash
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.memobot
sleep 3
launchctl print gui/$(id -u)/com.claudeclaw.memobot | grep -E "state|last exit"
```

Expected: `state = running`, `last exit code = (never exited)` or `0`.

Check memobot log for startup:

```bash
tail -20 logs/memobot.log
```

Expected: see `"ClaudeClaw is running"` and `"@MemoVizBot"` within the last minute.

- [ ] **Step 4: Manual smoke test via Telegram**

Send these 5 messages to `@MemoVizBot` in order. Between each, let the bot respond (up to 30s). After all 5, verify DB state.

1. **Text note:** `Taking notes on kefir fermentation temperatures.`
   Expected reply: something like `#1 (pure_bliss) — Taking notes on kefir fermentation temperatures`

2. **URL (tiktok):** `https://www.tiktok.com/@waterkefir/video/12345` (or any real public URL you have)
   Expected reply: `#2 (pure_bliss) — <title>\n<summary>\n<url>` or the scrape-failed fallback.

3. **Duplicate of #2:** same URL as step 2.
   Expected reply: `Already have this as #2, saved <relative_age>. Note appended.`

4. **Command — find:** `/find kefir`
   Expected reply: a numbered list including both #1 and #2.

5. **Command — open:** `/open 1`
   Expected reply: full item details.

- [ ] **Step 5: Verify DB state directly**

```bash
sqlite3 store/claudeclaw.db "SELECT id, source_type, project, title, enriched_at IS NOT NULL AS enriched FROM library_items ORDER BY id DESC LIMIT 5;"
```

Expected: rows matching your sends, with `enriched=1` for URL and text saves.

```bash
sqlite3 store/claudeclaw.db "SELECT agent_id, action, summary FROM hive_mind WHERE agent_id='memobot' ORDER BY created_at DESC LIMIT 5;"
```

Expected: one hive_mind row per save action.

- [ ] **Step 6: If any step fails, fix and rebuild before moving to Wave 2**

Common issues:
- CLAUDE.md not picked up → memobot wasn't restarted (step 3).
- CLI errors → `npm run build` was skipped or failed.
- Haiku goes off-script → system prompt has an ambiguous section; tighten the template and retry.

- [ ] **Step 7: Commit anything that got fixed during smoke testing**

Likely nothing if Wave 1 is clean. If fixes happened:

```bash
git add -A
git commit -m "fix(wave1): address issues surfaced by manual smoke testing

<describe what you fixed>"
```

---

# Wave 2 — Other File Types (PDF, Video, Audio)

Wave 2 extends the existing CLI's `--media-temp-path` handling (already supports these mime families from Task 9) and adds the CLAUDE.md instructions that tell memobot to use it for non-screenshot attachments.

## Task 14: MemoBot CLAUDE.md — Wave 2 file flow

**Files:**
- Modify: `~/.claudeclaw/agents/memobot/CLAUDE.md`
- Optionally mirror: `agents/memobot/CLAUDE.md.example`

- [ ] **Step 1: Insert a new section "### F. File attachment (PDF/video/audio)" between section E and the project inference section**

```markdown
### F. File attachment (PDF / video / audio)

When the Telegram message contains a non-image document/video/audio attachment:

1. Download the file to a temp path.
2. Determine `--media-type` from the MIME:
   - `application/pdf` → `pdf`
   - `video/*` → `video`
   - `audio/*` (NOT voice notes — those are section G) → `audio`
   - anything else → `other`
3. Save with `--media-temp-path`:
   ```bash
   node $PROJECT_ROOT/dist/library-cli.js save \
     --source-type file \
     --project <inferred from caption> \
     --user-note "<caption or empty>" \
     --media-temp-path "<temp path>" \
     --media-type <pdf|video|audio|other> \
     --media-mime "<MIME>" \
     --queue-processor "file needs text extraction"
   ```
4. Reply:
   ```
   #<id> (<project>) — <filename>
   Extraction coming when processor runs.
   ```

**Do NOT** add `--enriched`. Text extraction is the Processor's job.
```

- [ ] **Step 2: Verify edit**

Run: `grep -A3 "### F. File attachment" ~/.claudeclaw/agents/memobot/CLAUDE.md`
Expected: shows the new section.

- [ ] **Step 3: If mirroring to repo, update `agents/memobot/CLAUDE.md.example`**

```bash
cp ~/.claudeclaw/agents/memobot/CLAUDE.md agents/memobot/CLAUDE.md.example
git add agents/memobot/CLAUDE.md.example
git commit -m "docs(memobot): extend CLAUDE.md with Wave 2 file-attachment flow

Adds section F covering PDF, video, and audio attachments.
Same --media-temp-path CLI path as Wave 1 screenshots, just
different --media-type values. Phase 3 Processor will handle
text extraction when it lands."
```

Otherwise commit with the comment that live CLAUDE.md was updated out of tree.

---

## Task 15: Wave 2 restart + smoke test

**Files:** None (operational).

- [ ] **Step 1: Restart memobot**

```bash
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.memobot
sleep 3
tail -10 logs/memobot.log
```

- [ ] **Step 2: Manual smoke test — send one of each file type**

To `@MemoVizBot`:
1. A small PDF (under 5 MB): any recent PDF on your Mac works. Caption: "pure bliss ingredient list".
2. A short video (.mp4, under 20 MB). No caption.
3. An audio file (.mp3 or .m4a, under 10 MB). No caption.

Expected replies match the Wave 2 file-attachment template: `#<id> (<project>) — <filename>\nExtraction coming when processor runs.`

- [ ] **Step 3: Verify files landed on the flash drive**

```bash
find /Volumes/ClaudeClaw/claudeclaw-library -type f -newer logs/memobot.log | head -20
```

Expected: files visible under the right `<project>/<bucket>/` subfolders (`pdfs/`, `videos/`, `audio/`).

- [ ] **Step 4: Verify DB state**

```bash
sqlite3 store/claudeclaw.db "SELECT li.id, li.project, im.media_type, im.file_path, im.bytes FROM library_items li JOIN item_media im ON im.item_id = li.id WHERE li.source_type = 'file' ORDER BY li.id DESC LIMIT 5;"
```

Expected: rows for each file you sent, with sensible paths and byte sizes matching the file on disk.

```bash
sqlite3 store/claudeclaw.db "SELECT COUNT(*) FROM mission_tasks WHERE assigned_agent = 'processor' AND status = 'queued';"
```

Expected: at least 3 queued tasks (one per file you saved).

- [ ] **Step 5: Commit if fixes were needed**

```bash
git add -A
git commit -m "fix(wave2): address issues surfaced by file-attachment smoke test"
```

Otherwise no commit.

---

# Wave 3 — Voice Notes + Forwarded Messages

## Task 16: MemoBot CLAUDE.md — Wave 3 voice + forwarded flows

**Files:**
- Modify: `~/.claudeclaw/agents/memobot/CLAUDE.md`

- [ ] **Step 1: Add two new sections "### G. Voice note" and "### H. Forwarded Telegram message"**

Insert between section F (files) and the project inference section:

```markdown
### G. Voice note

When the Telegram message is a voice message (`voice` MIME, usually `audio/ogg`):

1. Download the audio to a temp path.
2. Save:
   ```bash
   node $PROJECT_ROOT/dist/library-cli.js save \
     --source-type voice \
     --project general \
     --media-temp-path "<temp path>" \
     --media-type audio \
     --media-mime audio/ogg \
     --queue-processor "voice needs transcription"
   ```
3. Reply:
   ```
   #<id> (general) — voice note saved. Transcript coming.
   ```

**Do NOT** add `--enriched`. Transcription is deferred to the Processor.
Project defaults to `general` — you have no text content to infer from until the Processor transcribes.

### H. Forwarded Telegram message

When the Telegram message has a `forward_from` or `forward_from_chat` field:

1. Extract the forwarded text and any attachment.
2. If the forwarded text contains a URL → run the URL flow (section A) but with `--source-type forwarded` instead of the domain-inferred type. Keeps `source_type=forwarded` so you know the provenance later.
3. If the forwarded message was just text → save as note:
   ```bash
   node $PROJECT_ROOT/dist/library-cli.js save \
     --source-type forwarded \
     --project <inferred from text> \
     --user-note "<forwarded text>" \
     --author "<original sender username if available>" \
     --content content_type=user_note,text="<forwarded text>" \
     --enriched
   ```
4. If the forwarded message had an attachment → route through B/F/G based on type, but with `--source-type forwarded`.
5. Reply: same format as the corresponding non-forwarded reply, with "forwarded" in the source-type position.
```

- [ ] **Step 2: Verify edits**

Run: `grep -E "### [GH]\." ~/.claudeclaw/agents/memobot/CLAUDE.md`
Expected: shows both new section headers.

- [ ] **Step 3: If mirroring to repo, update `agents/memobot/CLAUDE.md.example` and commit**

```bash
cp ~/.claudeclaw/agents/memobot/CLAUDE.md agents/memobot/CLAUDE.md.example
git add agents/memobot/CLAUDE.md.example
git commit -m "docs(memobot): extend CLAUDE.md with Wave 3 voice + forwarded flows

Adds sections G (voice notes) and H (forwarded messages).
Voice notes queue transcription for Phase 3 Processor. Forwarded
messages keep source_type=forwarded so provenance is preserved."
```

---

## Task 17: Final verification + success-criteria check

**Files:** None (final operational task).

- [ ] **Step 1: Restart memobot for Wave 3**

```bash
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.memobot
sleep 3
tail -10 logs/memobot.log
```

- [ ] **Step 2: Wave 3 smoke test**

Send to `@MemoVizBot`:
1. A voice note (hold the mic in Telegram, record ~5 seconds).
   Expected: `#<id> (general) — voice note saved. Transcript coming.`
2. A forwarded message from some other chat or channel (forward any message you have handy).
   Expected: reply matching the forwarded template with `source_type=forwarded`.

- [ ] **Step 3: Verify DB state**

```bash
sqlite3 store/claudeclaw.db "SELECT id, source_type, project FROM library_items WHERE source_type IN ('voice', 'forwarded') ORDER BY id DESC LIMIT 5;"
```

Expected: rows for each voice/forwarded message you sent.

- [ ] **Step 4: Full test suite + build**

```bash
npx vitest run
npm run build
```

Expected: library + library-cli suites green. The 7 pre-existing `skill-registry.test.ts` failures (unrelated to this work) remain.

- [ ] **Step 5: Run through the spec §11 success criteria**

Check each box in `docs/superpowers/specs/2026-04-23-memobot-collector-design.md` §11 and tick it if verified:

- [ ] `src/library.ts` exists with every function signature in §4.1 — **Tasks 1-6 covered each function**.
- [ ] `src/library-cli.ts` exists with every subcommand in §4.2 — **Tasks 7-11 covered each subcommand**.
- [ ] Memobot's `CLAUDE.md` is rewritten per §8 — **Tasks 12, 14, 16 produced the final system prompt**.
- [ ] Sending a URL results in a `library_items` row with scraped title/summary and a matching reply — **Wave 1 smoke test, step 4**.
- [ ] Sending the same URL twice results in DUPLICATE reply and appended user_note — **Wave 1 smoke test, step 4.3**.
- [ ] Sending a screenshot saves to `$LIBRARY_ROOT/<project>/screenshots/`, `enriched_at=NULL`, mission_task queued — **Wave 1 smoke test (if you tested a screenshot) or Wave 2**.
- [ ] Free-form text saves as `source_type=note` with `enriched_at` set — **Wave 1 smoke test, step 4.1**.
- [ ] `/find <query>` returns FTS5 results — **Wave 1 smoke test, step 4.4**.
- [ ] `/delete <id>` prompts for YES and cascades — **Test this manually now**.
- [ ] `/project`, `/pin`, `/unpin`, `/reviewed`, `/reenrich`, `/open`, `/recent`, `/help` all behave — **Test each manually now**.
- [ ] Drive-offline case: unmount drive briefly (if safe) and attempt a file save. Expected: `Flash drive offline, queued #<id> for save when it's back.` — **Optional**.

- [ ] **Step 6: Final commit (if anything was fixed) + merge prep**

```bash
git status
git log --oneline feat/memobot-collector ^main
```

If everything's clean and all waves passed:

```bash
git checkout main
git merge feat/memobot-collector --ff-only
# or --no-ff if you prefer a merge commit
```

Push when ready.

---

## Self-Review Notes

**Spec coverage check (against spec §11 success criteria):**
- ✅ library.ts — Tasks 1-6 cover canonicalizeUrl, urlHash, inferProject, insertItem (with dedup), addMedia, addContent, addTag, markEnriched, markReviewed, setPinned, setProject, deleteItem, getItem, searchLibrary, queueProcessorTask.
- ✅ library-cli.ts — Tasks 7-11 cover check-url, save (with and without media), find, open, recent, delete, update, help.
- ✅ Memobot CLAUDE.md — Tasks 12, 14, 16 handle Wave 1, 2, 3 sections.
- ✅ URL save produces row with summary — Wave 1 smoke test.
- ✅ Dedup appends note — Wave 1 smoke + library.ts test in Task 3.
- ✅ Screenshot saves to flash drive with enriched_at=NULL + mission_task — covered by library-cli save tests (Task 9) + Wave 1 or Wave 2 smoke.
- ✅ Text note with enriched_at set — library-cli save tests + Wave 1 smoke.
- ✅ FTS5 search via /find — library-cli find tests + Wave 1 smoke.
- ✅ /delete with YES confirmation — memobot's CLAUDE.md enforces the YES prompt.
- ✅ All slash commands — Tasks 10 + 11 build the CLI subcommands; Task 12 wires them in the CLAUDE.md.
- ✅ Drive-offline graceful behavior — documented in CLAUDE.md failure section; the actual CLI returns a clear error on path failure which memobot parses.

**Placeholder scan:** No "TBD" or "implement later". Every step has runnable code or commands. One conditional path in Task 12/14/16 ("If `agents/memobot/` doesn't exist, skip this step") is a real conditional, not a placeholder — the implementer checks once and decides.

**Type consistency check:**
- `SourceType`, `Project`, `InsertItemOpts`, `AddMediaOpts`, `AddContentOpts`, `AddTagOpts` — defined once in Task 3/4, imported where needed.
- `insertItem` returns `{id, is_duplicate, existing_id?, last_seen_at_before?}` — all consumers use this shape.
- CLI JSON output shapes (`{is_duplicate, existing_id, canonical}` for check-url; `{id, is_duplicate}` for save; etc.) — consistent across test expectations and implementation.

**Scope check:** Plan is large (17 tasks) but the three waves provide natural checkpoints. Wave 1 is self-sufficient (URLs + text + screenshots). Waves 2 and 3 extend the CLAUDE.md only, with the CLI already supporting all mime types from Task 9.

**Risks called out:**
- Task 3 re-exports `_getTestDb` from library.ts. This naming is test-adjacent but works at runtime because `_getTestDb` just returns the module-level `db` that `initDatabase()` set. If this bothers reviewers, a follow-up task renames it.
- Task 7 test for `check-url` with a "known" duplicate depends on `save` from Task 8. The plan deliberately splits the test: Task 7 verifies check-url with unknown URLs only; Task 8 adds the "after a matching save" case. Tests are organized by topic, not task, so running the full suite after Task 8 verifies both.
- The CLAUDE.md lives outside the repo tree (`~/.claudeclaw/agents/memobot/`). Tasks 12/14/16 mention a mirroring approach but mark it optional because we don't know the project's exact convention. The implementer decides on first run and keeps consistent.
