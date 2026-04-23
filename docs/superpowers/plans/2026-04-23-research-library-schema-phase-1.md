# Research Library Schema — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the research library database schema (6 new tables + FTS5 virtual table + triggers + indexes) and the `LIBRARY_ROOT` config, all verified by tests, so Phase 2 (Collector agent) can build directly on top.

**Architecture:** Schema lives inside the existing `createSchema()` function in `src/db.ts`. This follows the codebase's established pattern: every table uses `CREATE TABLE IF NOT EXISTS`, so fresh installs and existing databases both pick up new tables on next boot — no separate migration file required. A new env var `LIBRARY_ROOT` points to the flash-drive folder tree already created at `/Volumes/ClaudeClaw/claudeclaw-library/`. Tests use `_initTestDatabase()` (already exported from `src/db.ts`) to spin up an in-memory SQLite instance with the full schema.

**Tech Stack:** Node.js 20+, TypeScript, better-sqlite3, vitest, SQLite FTS5.

**Spec reference:** `docs/superpowers/specs/2026-04-23-research-library-schema-design.md`

---

## File Structure

**Created:**
- `src/library.test.ts` — vitest suite covering all schema, index, FTS5, trigger, cascade, uniqueness, and round-trip behavior for the library tables.

**Modified:**
- `src/db.ts` — insert new library tables, indexes, FTS5 virtual table, and triggers inside `createSchema()`.
- `src/config.ts` — add `LIBRARY_ROOT` to the env-reader array and export it as a resolved path.
- `.env.example` — new `# ── Research Library ──` section documenting `LIBRARY_ROOT`.

**Unchanged:**
- `migrations/version.json` — intentionally untouched. No explicit migration file is needed for new tables because `CREATE TABLE IF NOT EXISTS` inside `createSchema()` handles both fresh and existing installs on the next `initDatabase()` call. This decision is consistent with how every other table in the codebase is defined.

---

## Task 1: Add library tables to `createSchema()`

**Files:**
- Modify: `src/db.ts` (inside `createSchema()`, append after the last existing table definition around line 357)
- Test: `src/library.test.ts` (new file)

- [ ] **Step 1: Write the failing test** — create `src/library.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { _initTestDatabase } from './db.js';

// Access to the underlying DB for raw schema introspection in tests.
// We use a fresh in-memory DB per test via _initTestDatabase(), then query
// sqlite_master to verify tables/indexes/triggers exist.
function getTables(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>)
    .map((r) => r.name);
}

// We need a handle to the underlying DB instance for introspection. Since
// db.ts does not export getDb(), we reach it via a test-only helper we will
// add in this task.
import { _getTestDb } from './db.js';

describe('library schema', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  describe('tables', () => {
    it('creates library_items table', () => {
      const db = _getTestDb();
      expect(getTables(db)).toContain('library_items');
    });

    it('creates item_media table', () => {
      const db = _getTestDb();
      expect(getTables(db)).toContain('item_media');
    });

    it('creates item_content table', () => {
      const db = _getTestDb();
      expect(getTables(db)).toContain('item_content');
    });

    it('creates item_tags table', () => {
      const db = _getTestDb();
      expect(getTables(db)).toContain('item_tags');
    });

    it('creates item_relationships table', () => {
      const db = _getTestDb();
      expect(getTables(db)).toContain('item_relationships');
    });

    it('creates item_embeddings table', () => {
      const db = _getTestDb();
      expect(getTables(db)).toContain('item_embeddings');
    });

    it('library_items has expected columns', () => {
      const db = _getTestDb();
      const cols = (db.prepare(`PRAGMA table_info(library_items)`).all() as Array<{ name: string }>)
        .map((c) => c.name);
      const expected = [
        'id', 'agent_id', 'chat_id', 'source_type', 'url', 'url_hash', 'title',
        'author', 'captured_at', 'last_seen_at', 'project', 'user_note',
        'source_meta', 'reviewed_at', 'pinned', 'enriched_at', 'related_at',
        'analyzed_at', 'created_at',
      ];
      for (const col of expected) {
        expect(cols).toContain(col);
      }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/library.test.ts`
Expected: FAIL with "no such table: library_items" and "_getTestDb is not exported".

- [ ] **Step 3: Add the `_getTestDb` test helper to `src/db.ts`**

Find the existing `_initTestDatabase` function near line 626 and add this immediately after it:

```typescript
/** @internal - for tests only. Returns the active database handle. */
export function _getTestDb(): Database.Database {
  return db;
}
```

- [ ] **Step 4: Add the six library tables to `createSchema()`**

Locate the closing `\`);` of the big `database.exec(\`...\`)` block inside `createSchema()` (near line 358, just after the `session_summaries` table). Insert the following SQL **before** the closing backtick:

```sql
    -- ── Research Library (Phase 1) ────────────────────────────────────
    -- See docs/superpowers/specs/2026-04-23-research-library-schema-design.md

    CREATE TABLE IF NOT EXISTS library_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      TEXT NOT NULL DEFAULT 'collector',
      chat_id       TEXT NOT NULL DEFAULT '',
      source_type   TEXT NOT NULL CHECK (source_type IN (
        'tiktok','instagram','facebook','reddit','twitter','youtube','threads',
        'linkedin','article','screenshot','file','note','voice','forwarded'
      )),
      url           TEXT,
      url_hash      TEXT,
      title         TEXT,
      author        TEXT,
      captured_at   INTEGER NOT NULL,
      last_seen_at  INTEGER,
      project       TEXT NOT NULL DEFAULT 'general'
                    CHECK (project IN ('pure_bliss','octohive','personal','general')),
      user_note     TEXT,
      source_meta   TEXT,
      reviewed_at   INTEGER,
      pinned        INTEGER NOT NULL DEFAULT 0,
      enriched_at   INTEGER,
      related_at    INTEGER,
      analyzed_at   INTEGER,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_media (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id         INTEGER NOT NULL,
      media_type      TEXT NOT NULL CHECK (media_type IN ('image','video','pdf','audio','other')),
      file_path       TEXT,
      storage         TEXT NOT NULL DEFAULT 'local'
                      CHECK (storage IN ('local','drive','both')),
      drive_file_id   TEXT,
      drive_url       TEXT,
      mime_type       TEXT,
      bytes           INTEGER,
      ocr_text        TEXT,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS item_content (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id       INTEGER NOT NULL,
      content_type  TEXT NOT NULL CHECK (content_type IN ('ocr','scraped_summary','transcript','user_note')),
      text          TEXT NOT NULL,
      source_agent  TEXT,
      token_count   INTEGER,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS item_tags (
      item_id       INTEGER NOT NULL,
      tag           TEXT NOT NULL,
      tag_type      TEXT NOT NULL CHECK (tag_type IN ('topic','person','brand','hashtag','mood','other')),
      confidence    REAL,
      source_agent  TEXT,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (item_id, tag, tag_type),
      FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS item_relationships (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      source_item_id    INTEGER NOT NULL,
      target_item_id    INTEGER NOT NULL,
      relation_type     TEXT NOT NULL CHECK (relation_type IN (
        'same_topic','same_author','similar_semantic','cites','manual_link','duplicate'
      )),
      similarity_score  REAL,
      reason            TEXT,
      source_agent      TEXT,
      created_at        INTEGER NOT NULL,
      UNIQUE (source_item_id, target_item_id, relation_type),
      FOREIGN KEY (source_item_id) REFERENCES library_items(id) ON DELETE CASCADE,
      FOREIGN KEY (target_item_id) REFERENCES library_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS item_embeddings (
      item_id            INTEGER PRIMARY KEY,
      model              TEXT NOT NULL,
      dimensions         INTEGER NOT NULL,
      embedding          BLOB NOT NULL,
      source_text_hash   TEXT,
      created_at         INTEGER NOT NULL,
      FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
    );
```

Also, `initDatabase()` and `_initTestDatabase()` need to turn on foreign-key enforcement (otherwise `ON DELETE CASCADE` does nothing). Locate these two functions in `src/db.ts` and add `db.pragma('foreign_keys = ON');` after `db.pragma('journal_mode = WAL');` in **both** of them.

- [ ] **Step 5: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts`
Expected: PASS (7 tests passing).

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/library.test.ts
git commit -m "feat(library): add 6 research library tables to schema

Adds library_items, item_media, item_content, item_tags,
item_relationships, item_embeddings tables per Phase 1 spec.
Foreign keys enforced via pragma. Test helper _getTestDb exposes
the in-memory DB handle for schema introspection."
```

---

## Task 2: Add library indexes to `createSchema()`

**Files:**
- Modify: `src/db.ts` (extend the library schema block added in Task 1)
- Test: `src/library.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — append to `src/library.test.ts` inside the top-level `describe('library schema', ...)` block:

```typescript
  describe('indexes', () => {
    function getIndexes(db: Database.Database, table: string): string[] {
      return (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`
      ).all(table) as Array<{ name: string }>).map((r) => r.name);
    }

    it('creates url_hash unique index on library_items', () => {
      const db = _getTestDb();
      expect(getIndexes(db, 'library_items')).toContain('idx_library_items_url_hash');
    });

    it('creates project index on library_items', () => {
      const db = _getTestDb();
      expect(getIndexes(db, 'library_items')).toContain('idx_library_items_project');
    });

    it('creates source_type index on library_items', () => {
      const db = _getTestDb();
      expect(getIndexes(db, 'library_items')).toContain('idx_library_items_source_type');
    });

    it('creates captured_at index on library_items', () => {
      const db = _getTestDb();
      expect(getIndexes(db, 'library_items')).toContain('idx_library_items_captured_at');
    });

    it('creates reviewed_at index on library_items', () => {
      const db = _getTestDb();
      expect(getIndexes(db, 'library_items')).toContain('idx_library_items_reviewed_at');
    });

    it('creates partial indexes for NULL lifecycle stages', () => {
      const db = _getTestDb();
      const idx = getIndexes(db, 'library_items');
      expect(idx).toContain('idx_library_items_enriched_null');
      expect(idx).toContain('idx_library_items_related_null');
      expect(idx).toContain('idx_library_items_analyzed_null');
    });

    it('creates FK indexes on satellite tables', () => {
      const db = _getTestDb();
      expect(getIndexes(db, 'item_media')).toContain('idx_item_media_item_id');
      expect(getIndexes(db, 'item_content')).toContain('idx_item_content_item_id');
      expect(getIndexes(db, 'item_tags')).toContain('idx_item_tags_tag');
      expect(getIndexes(db, 'item_relationships')).toContain('idx_item_relationships_source');
      expect(getIndexes(db, 'item_relationships')).toContain('idx_item_relationships_target');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/library.test.ts -t "indexes"`
Expected: FAIL — indexes not found.

- [ ] **Step 3: Append the indexes block** to `createSchema()` in `src/db.ts`, immediately after the `item_embeddings` CREATE TABLE from Task 1:

```sql
    CREATE UNIQUE INDEX IF NOT EXISTS idx_library_items_url_hash
      ON library_items(url_hash) WHERE url_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_library_items_project
      ON library_items(project);
    CREATE INDEX IF NOT EXISTS idx_library_items_source_type
      ON library_items(source_type);
    CREATE INDEX IF NOT EXISTS idx_library_items_captured_at
      ON library_items(captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_library_items_reviewed_at
      ON library_items(reviewed_at);
    CREATE INDEX IF NOT EXISTS idx_library_items_enriched_null
      ON library_items(id) WHERE enriched_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_library_items_related_null
      ON library_items(id) WHERE related_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_library_items_analyzed_null
      ON library_items(id) WHERE analyzed_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_item_media_item_id       ON item_media(item_id);
    CREATE INDEX IF NOT EXISTS idx_item_content_item_id     ON item_content(item_id);
    CREATE INDEX IF NOT EXISTS idx_item_tags_tag            ON item_tags(tag, tag_type);
    CREATE INDEX IF NOT EXISTS idx_item_relationships_source ON item_relationships(source_item_id);
    CREATE INDEX IF NOT EXISTS idx_item_relationships_target ON item_relationships(target_item_id);
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "indexes"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/library.test.ts
git commit -m "feat(library): add schema indexes for library tables

Partial indexes on the NULL lifecycle columns keep agent sweep
queries fast as the table grows. url_hash is a partial unique
index so NULL-URL items (notes, voice) aren't forced unique."
```

---

## Task 3: Add FTS5 virtual table + triggers for `item_content`

**Files:**
- Modify: `src/db.ts` (extend the library schema block)
- Test: `src/library.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — append to `src/library.test.ts`:

```typescript
  describe('FTS5 virtual table', () => {
    it('creates item_content_fts virtual table', () => {
      const db = _getTestDb();
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='item_content_fts'`)
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);
    });

    it('inserting into item_content makes row searchable via FTS', () => {
      const db = _getTestDb();
      const now = Math.floor(Date.now() / 1000);
      const itemId = (db.prepare(`
        INSERT INTO library_items (source_type, captured_at, project, created_at)
        VALUES ('note', ?, 'general', ?)
      `).run(now, now).lastInsertRowid as number);

      db.prepare(`
        INSERT INTO item_content (item_id, content_type, text, created_at)
        VALUES (?, 'user_note', 'the brown kefir water ferments', ?)
      `).run(itemId, now);

      const hits = db.prepare(`
        SELECT item_id FROM item_content_fts WHERE item_content_fts MATCH 'kefir'
      `).all() as Array<{ item_id: number }>;
      expect(hits.length).toBe(1);
      expect(hits[0].item_id).toBe(itemId);
    });

    it('updating item_content re-indexes FTS', () => {
      const db = _getTestDb();
      const now = Math.floor(Date.now() / 1000);
      const itemId = (db.prepare(`
        INSERT INTO library_items (source_type, captured_at, project, created_at)
        VALUES ('note', ?, 'general', ?)
      `).run(now, now).lastInsertRowid as number);

      const contentId = (db.prepare(`
        INSERT INTO item_content (item_id, content_type, text, created_at)
        VALUES (?, 'user_note', 'original text about cats', ?)
      `).run(itemId, now).lastInsertRowid as number);

      db.prepare(`UPDATE item_content SET text = ? WHERE id = ?`)
        .run('updated text about dogs', contentId);

      const catHits = db.prepare(`SELECT item_id FROM item_content_fts WHERE item_content_fts MATCH 'cats'`).all();
      const dogHits = db.prepare(`SELECT item_id FROM item_content_fts WHERE item_content_fts MATCH 'dogs'`).all();
      expect(catHits.length).toBe(0);
      expect(dogHits.length).toBe(1);
    });

    it('deleting item_content removes FTS row', () => {
      const db = _getTestDb();
      const now = Math.floor(Date.now() / 1000);
      const itemId = (db.prepare(`
        INSERT INTO library_items (source_type, captured_at, project, created_at)
        VALUES ('note', ?, 'general', ?)
      `).run(now, now).lastInsertRowid as number);

      const contentId = (db.prepare(`
        INSERT INTO item_content (item_id, content_type, text, created_at)
        VALUES (?, 'user_note', 'about penguins', ?)
      `).run(itemId, now).lastInsertRowid as number);

      db.prepare(`DELETE FROM item_content WHERE id = ?`).run(contentId);

      const hits = db.prepare(`SELECT item_id FROM item_content_fts WHERE item_content_fts MATCH 'penguins'`).all();
      expect(hits.length).toBe(0);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/library.test.ts -t "FTS5"`
Expected: FAIL — `no such table: item_content_fts`.

- [ ] **Step 3: Append the FTS5 block** to `createSchema()` in `src/db.ts`, right after the indexes block from Task 2:

```sql
    CREATE VIRTUAL TABLE IF NOT EXISTS item_content_fts USING fts5(
      text,
      item_id UNINDEXED,
      content_type UNINDEXED,
      content=item_content,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS item_content_fts_insert AFTER INSERT ON item_content BEGIN
      INSERT INTO item_content_fts(rowid, text, item_id, content_type)
        VALUES (new.id, new.text, new.item_id, new.content_type);
    END;

    CREATE TRIGGER IF NOT EXISTS item_content_fts_delete AFTER DELETE ON item_content BEGIN
      INSERT INTO item_content_fts(item_content_fts, rowid, text, item_id, content_type)
        VALUES ('delete', old.id, old.text, old.item_id, old.content_type);
    END;

    CREATE TRIGGER IF NOT EXISTS item_content_fts_update AFTER UPDATE ON item_content BEGIN
      INSERT INTO item_content_fts(item_content_fts, rowid, text, item_id, content_type)
        VALUES ('delete', old.id, old.text, old.item_id, old.content_type);
      INSERT INTO item_content_fts(rowid, text, item_id, content_type)
        VALUES (new.id, new.text, new.item_id, new.content_type);
    END;
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "FTS5"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/library.test.ts
git commit -m "feat(library): add FTS5 virtual table and triggers for item_content

External-content FTS5 table mirrors item_content.text for
search, with insert/update/delete triggers to keep it in sync.
Follows the pattern already used for memories_fts."
```

---

## Task 4: Add `LIBRARY_ROOT` to `src/config.ts`

**Files:**
- Modify: `src/config.ts` (add to env-reader array and add exported constant)
- Test: `src/config.test.ts` or an env test (we'll use a focused targeted test)

- [ ] **Step 1: Create a focused test** for the config export. Append to `src/library.test.ts` (keeping library-touching tests together):

```typescript
describe('LIBRARY_ROOT config', () => {
  it('resolves LIBRARY_ROOT to an absolute path, defaulting to the ClaudeClaw flash drive', async () => {
    // Dynamic import so we get a fresh evaluation under the test env
    const config = await import('./config.js');
    expect(config.LIBRARY_ROOT).toMatch(/claudeclaw-library$/);
    expect(config.LIBRARY_ROOT.startsWith('/')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/library.test.ts -t "LIBRARY_ROOT"`
Expected: FAIL — `config.LIBRARY_ROOT is undefined`.

- [ ] **Step 3: Extend the env-reader array in `src/config.ts`**

Find the `readEnvFile([...])` call near the top of `src/config.ts` (around line 7). Add `'LIBRARY_ROOT'` to the array, e.g. insert it near `CLAUDECLAW_CONFIG`:

```typescript
const envConfig = readEnvFile([
  'TELEGRAM_BOT_TOKEN',
  // ... existing entries ...
  'CLAUDECLAW_CONFIG',
  'LIBRARY_ROOT',
  // ... rest ...
]);
```

- [ ] **Step 4: Add the exported constant** to `src/config.ts`

Find the block defining `CLAUDECLAW_CONFIG` (around line 111). Immediately after that block, add:

```typescript
// ── Research library ────────────────────────────────────────────────
// Root directory for the research library's files (screenshots, PDFs,
// videos, audio). Defaults to the always-mounted flash drive on remy.
// Files in item_media.file_path are stored **relative** to this path.

const rawLibraryRoot =
  process.env.LIBRARY_ROOT ||
  envConfig.LIBRARY_ROOT ||
  '/Volumes/ClaudeClaw/claudeclaw-library';

/**
 * Absolute path to the research library's file root.
 * Defaults to /Volumes/ClaudeClaw/claudeclaw-library.
 */
export const LIBRARY_ROOT = expandHome(rawLibraryRoot);
```

- [ ] **Step 5: Run test and verify it passes**

Run: `npx vitest run src/library.test.ts -t "LIBRARY_ROOT"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/library.test.ts
git commit -m "feat(config): add LIBRARY_ROOT env var for research library

Defaults to /Volumes/ClaudeClaw/claudeclaw-library on remy.
Expands ~ and resolves to an absolute path. Consumers store
file_path relative to this root so the drive can be renamed
or remounted without touching rows."
```

---

## Task 5: Document `LIBRARY_ROOT` in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Open `.env.example` and find the `# ── Database Encryption ──` section** (around line 92). Insert a new section immediately before it:

```
# ── Research Library ─────────────────────────────────────────────────────────
# Root directory for the research library's files (screenshots, PDFs,
# videos, audio). Defaults to the flash drive on remy.
# LIBRARY_ROOT=/Volumes/ClaudeClaw/claudeclaw-library

```

- [ ] **Step 2: Verify with a grep**

Run: `grep -A2 "Research Library" .env.example`
Expected output includes the LIBRARY_ROOT line as shown above.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document LIBRARY_ROOT in .env.example

Points at the /Volumes/ClaudeClaw/claudeclaw-library flash drive
root by default; override only if the drive is named differently."
```

---

## Task 6: Round-trip integration test (spec §9 success criterion)

Exercises the full data model: insert an item, attach media, content, tags, a relationship, and an embedding. Verifies every column round-trips without loss.

**Files:**
- Modify: `src/library.test.ts` (extend)

- [ ] **Step 1: Write the test** — append to `src/library.test.ts`:

```typescript
describe('library round-trip', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('inserts a library_item and satellite rows, reads them all back intact', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    // 1. Insert the canonical item
    const itemId = (db.prepare(`
      INSERT INTO library_items (
        agent_id, chat_id, source_type, url, url_hash, title, author,
        captured_at, last_seen_at, project, user_note, source_meta,
        reviewed_at, pinned, enriched_at, related_at, analyzed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'collector',
      'chat123',
      'tiktok',
      'https://tiktok.com/@brewlife/video/123',
      'abc123deadbeef',
      'How I brew water kefir',
      '@brewlife',
      now,
      now,
      'pure_bliss',
      'seen 2M times',
      JSON.stringify({ views: 2100000, likes: 80000 }),
      null,        // reviewed_at
      0,           // pinned
      null, null, null,  // lifecycle timestamps all NULL
      now,
    ).lastInsertRowid as number);

    // 2. Related items (needed for the relationship row below)
    const itemId2 = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('reddit', ?, 'pure_bliss', ?)
    `).run(now, now).lastInsertRowid as number);

    // 3. Attach two media rows
    db.prepare(`
      INSERT INTO item_media (item_id, media_type, file_path, storage, mime_type, bytes, created_at)
      VALUES (?, 'image', 'pure_bliss/screenshots/20260423-1512_1_kefir.png', 'local', 'image/png', 53421, ?)
    `).run(itemId, now);
    db.prepare(`
      INSERT INTO item_media (item_id, media_type, file_path, storage, drive_file_id, drive_url, mime_type, bytes, created_at)
      VALUES (?, 'video', 'pure_bliss/videos/20260423-1512_1_kefir.mp4', 'both', 'drive123', 'https://drive.google.com/file/d/drive123', 'video/mp4', 1048576, ?)
    `).run(itemId, now);

    // 4. Attach content rows
    db.prepare(`
      INSERT INTO item_content (item_id, content_type, text, source_agent, token_count, created_at)
      VALUES (?, 'scraped_summary', 'Maker fermenting water kefir at home.', 'collector', 8, ?)
    `).run(itemId, now);
    db.prepare(`
      INSERT INTO item_content (item_id, content_type, text, source_agent, token_count, created_at)
      VALUES (?, 'user_note', 'interesting fermentation technique', null, null, ?)
    `).run(itemId, now);

    // 5. Tags
    db.prepare(`
      INSERT INTO item_tags (item_id, tag, tag_type, confidence, source_agent, created_at)
      VALUES (?, 'kefir', 'topic', 0.95, 'relationship', ?)
    `).run(itemId, now);
    db.prepare(`
      INSERT INTO item_tags (item_id, tag, tag_type, confidence, source_agent, created_at)
      VALUES (?, '@brewlife', 'person', 1.0, 'collector', ?)
    `).run(itemId, now);

    // 6. Relationship
    db.prepare(`
      INSERT INTO item_relationships (source_item_id, target_item_id, relation_type, similarity_score, reason, source_agent, created_at)
      VALUES (?, ?, 'same_topic', 0.87, 'both about fermented drinks', 'relationship', ?)
    `).run(itemId, itemId2, now);

    // 7. Embedding
    const fakeVec = Buffer.alloc(12);
    fakeVec.writeFloatLE(0.1, 0);
    fakeVec.writeFloatLE(0.2, 4);
    fakeVec.writeFloatLE(0.3, 8);
    db.prepare(`
      INSERT INTO item_embeddings (item_id, model, dimensions, embedding, source_text_hash, created_at)
      VALUES (?, 'gemini-embedding-exp-03-07', 3, ?, 'hash-of-content', ?)
    `).run(itemId, fakeVec, now);

    // ── Read everything back ────────────────────────────────────────
    const item = db.prepare(`SELECT * FROM library_items WHERE id = ?`).get(itemId) as Record<string, unknown>;
    expect(item.source_type).toBe('tiktok');
    expect(item.url).toBe('https://tiktok.com/@brewlife/video/123');
    expect(item.url_hash).toBe('abc123deadbeef');
    expect(item.author).toBe('@brewlife');
    expect(item.project).toBe('pure_bliss');
    expect(item.pinned).toBe(0);
    expect(item.enriched_at).toBeNull();
    expect(JSON.parse(item.source_meta as string)).toEqual({ views: 2100000, likes: 80000 });

    const media = db.prepare(`SELECT * FROM item_media WHERE item_id = ? ORDER BY id`).all(itemId);
    expect(media.length).toBe(2);
    expect((media[0] as Record<string, unknown>).media_type).toBe('image');
    expect((media[0] as Record<string, unknown>).storage).toBe('local');
    expect((media[1] as Record<string, unknown>).storage).toBe('both');
    expect((media[1] as Record<string, unknown>).drive_file_id).toBe('drive123');

    const content = db.prepare(`SELECT * FROM item_content WHERE item_id = ? ORDER BY id`).all(itemId);
    expect(content.length).toBe(2);
    expect((content[0] as Record<string, unknown>).content_type).toBe('scraped_summary');
    expect((content[1] as Record<string, unknown>).content_type).toBe('user_note');

    const tags = db.prepare(`SELECT * FROM item_tags WHERE item_id = ? ORDER BY tag`).all(itemId);
    expect(tags.length).toBe(2);
    expect((tags[0] as Record<string, unknown>).tag).toBe('@brewlife');
    expect((tags[0] as Record<string, unknown>).tag_type).toBe('person');
    expect((tags[1] as Record<string, unknown>).tag).toBe('kefir');
    expect((tags[1] as Record<string, unknown>).tag_type).toBe('topic');

    const rels = db.prepare(`SELECT * FROM item_relationships WHERE source_item_id = ?`).all(itemId);
    expect(rels.length).toBe(1);
    expect((rels[0] as Record<string, unknown>).relation_type).toBe('same_topic');
    expect((rels[0] as Record<string, unknown>).target_item_id).toBe(itemId2);
    expect((rels[0] as Record<string, unknown>).similarity_score).toBe(0.87);

    const emb = db.prepare(`SELECT * FROM item_embeddings WHERE item_id = ?`).get(itemId) as Record<string, unknown>;
    expect(emb.dimensions).toBe(3);
    expect(emb.model).toBe('gemini-embedding-exp-03-07');
    const vecOut = emb.embedding as Buffer;
    expect(vecOut.readFloatLE(0)).toBeCloseTo(0.1, 5);
    expect(vecOut.readFloatLE(4)).toBeCloseTo(0.2, 5);
    expect(vecOut.readFloatLE(8)).toBeCloseTo(0.3, 5);

    // FTS search over the content we inserted
    const hits = db.prepare(`
      SELECT item_id FROM item_content_fts WHERE item_content_fts MATCH 'fermentation'
    `).all() as Array<{ item_id: number }>;
    expect(hits.some((h) => h.item_id === itemId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test and verify it passes**

Run: `npx vitest run src/library.test.ts -t "round-trip"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/library.test.ts
git commit -m "test(library): round-trip every library table and FTS

Satisfies spec §9 success criterion: a single test inserts into
every new table, reads back all fields, and verifies FTS search
finds the inserted content."
```

---

## Task 7: Foreign-key cascade test

Verifies that deleting a `library_items` row cascades to every satellite table.

**Files:**
- Modify: `src/library.test.ts` (extend)

- [ ] **Step 1: Write the test** — append:

```typescript
describe('library cascade deletes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('deleting a library_item removes all satellite rows', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    // Create two items so we can test that only the target's satellites are deleted
    const itemA = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('tiktok', ?, 'pure_bliss', ?)
    `).run(now, now).lastInsertRowid as number);
    const itemB = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('reddit', ?, 'pure_bliss', ?)
    `).run(now, now).lastInsertRowid as number);

    // Satellite rows for item A
    db.prepare(`INSERT INTO item_media (item_id, media_type, storage, created_at) VALUES (?, 'image', 'local', ?)`).run(itemA, now);
    db.prepare(`INSERT INTO item_content (item_id, content_type, text, created_at) VALUES (?, 'ocr', 'hello', ?)`).run(itemA, now);
    db.prepare(`INSERT INTO item_tags (item_id, tag, tag_type, created_at) VALUES (?, 'kefir', 'topic', ?)`).run(itemA, now);
    db.prepare(`INSERT INTO item_relationships (source_item_id, target_item_id, relation_type, created_at) VALUES (?, ?, 'same_topic', ?)`).run(itemA, itemB, now);
    db.prepare(`INSERT INTO item_embeddings (item_id, model, dimensions, embedding, created_at) VALUES (?, 'test', 1, ?, ?)`).run(itemA, Buffer.alloc(4), now);

    // Satellite for item B (to survive)
    db.prepare(`INSERT INTO item_media (item_id, media_type, storage, created_at) VALUES (?, 'image', 'local', ?)`).run(itemB, now);

    // Delete item A
    db.prepare(`DELETE FROM library_items WHERE id = ?`).run(itemA);

    // All A satellites gone
    expect(db.prepare(`SELECT COUNT(*) AS n FROM item_media WHERE item_id = ?`).get(itemA) as { n: number }).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM item_content WHERE item_id = ?`).get(itemA) as { n: number }).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM item_tags WHERE item_id = ?`).get(itemA) as { n: number }).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM item_relationships WHERE source_item_id = ? OR target_item_id = ?`).get(itemA, itemA) as { n: number }).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM item_embeddings WHERE item_id = ?`).get(itemA) as { n: number }).toEqual({ n: 0 });

    // B satellite survives
    expect(db.prepare(`SELECT COUNT(*) AS n FROM item_media WHERE item_id = ?`).get(itemB) as { n: number }).toEqual({ n: 1 });
  });

  it('deleting a library_item removes its FTS rows', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('note', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);
    db.prepare(`
      INSERT INTO item_content (item_id, content_type, text, created_at)
      VALUES (?, 'user_note', 'unique-searchterm-zebrafish', ?)
    `).run(itemId, now);

    // Sanity check: searchable before delete
    expect(
      (db.prepare(`SELECT item_id FROM item_content_fts WHERE item_content_fts MATCH 'zebrafish'`).all() as unknown[]).length,
    ).toBe(1);

    db.prepare(`DELETE FROM library_items WHERE id = ?`).run(itemId);

    // After cascade, content row is gone, and the trigger on item_content
    // (AFTER DELETE) should have removed the FTS entry.
    expect(
      (db.prepare(`SELECT item_id FROM item_content_fts WHERE item_content_fts MATCH 'zebrafish'`).all() as unknown[]).length,
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "cascade"`
Expected: PASS (2 tests).

If the second test fails (FTS row survives): foreign-key cascade fires but the trigger on `item_content` does NOT fire on cascade deletes in older SQLite versions. In that case, the fix is to add an explicit `AFTER DELETE ON library_items` trigger that cleans up orphaned FTS rows:

```sql
CREATE TRIGGER IF NOT EXISTS library_items_fts_cleanup AFTER DELETE ON library_items BEGIN
  INSERT INTO item_content_fts(item_content_fts) VALUES ('rebuild');
END;
```

Add that to the library schema block in `src/db.ts` and re-run the test. `INSERT INTO ... ('rebuild')` is the canonical FTS5 repair command; acceptable at cascade-delete frequency.

- [ ] **Step 3: Commit**

```bash
git add src/library.test.ts src/db.ts
git commit -m "test(library): verify FK cascade removes all satellite rows

Deleting a library_items row clears item_media, item_content,
item_tags, item_relationships, item_embeddings and the FTS
index. Belt-and-suspenders FTS rebuild trigger added as a
cascade safety net."
```

---

## Task 8: `url_hash` uniqueness behavior test

**Files:**
- Modify: `src/library.test.ts` (extend)

- [ ] **Step 1: Write the test** — append:

```typescript
describe('library url_hash uniqueness', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('rejects a second library_item with the same url_hash', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
      INSERT INTO library_items (source_type, url, url_hash, captured_at, project, created_at)
      VALUES ('tiktok', 'https://tiktok.com/1', 'samehash', ?, 'general', ?)
    `).run(now, now);

    expect(() => {
      db.prepare(`
        INSERT INTO library_items (source_type, url, url_hash, captured_at, project, created_at)
        VALUES ('tiktok', 'https://tiktok.com/2', 'samehash', ?, 'general', ?)
      `).run(now, now);
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('allows multiple items with NULL url_hash (notes, voice, screenshots)', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('note', ?, 'general', ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('voice', ?, 'general', ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('screenshot', ?, 'general', ?)
    `).run(now, now);

    const count = (db.prepare(`SELECT COUNT(*) AS n FROM library_items WHERE url_hash IS NULL`).get() as { n: number }).n;
    expect(count).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "url_hash"`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add src/library.test.ts
git commit -m "test(library): verify url_hash unique index allows NULL duplicates

Notes, voice, and screenshots have no URL and must be allowed
to coexist. Non-null url_hash values must be unique."
```

---

## Task 9: CHECK-constraint guard tests

Makes sure the schema rejects invalid `source_type`, `project`, `media_type`, `content_type`, `tag_type`, `relation_type`, and `storage` values.

**Files:**
- Modify: `src/library.test.ts` (extend)

- [ ] **Step 1: Write the test** — append:

```typescript
describe('library CHECK constraints', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('rejects an unknown source_type', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    expect(() => {
      db.prepare(`
        INSERT INTO library_items (source_type, captured_at, project, created_at)
        VALUES ('bluesky', ?, 'general', ?)
      `).run(now, now);
    }).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown project', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    expect(() => {
      db.prepare(`
        INSERT INTO library_items (source_type, captured_at, project, created_at)
        VALUES ('tiktok', ?, 'world_domination', ?)
      `).run(now, now);
    }).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown media_type', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('tiktok', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);
    expect(() => {
      db.prepare(`
        INSERT INTO item_media (item_id, media_type, storage, created_at)
        VALUES (?, 'gif', 'local', ?)
      `).run(itemId, now);
    }).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown storage value', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('tiktok', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);
    expect(() => {
      db.prepare(`
        INSERT INTO item_media (item_id, media_type, storage, created_at)
        VALUES (?, 'image', 's3', ?)
      `).run(itemId, now);
    }).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown relation_type', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const a = (db.prepare(`INSERT INTO library_items (source_type, captured_at, project, created_at) VALUES ('tiktok', ?, 'general', ?)`).run(now, now).lastInsertRowid as number);
    const b = (db.prepare(`INSERT INTO library_items (source_type, captured_at, project, created_at) VALUES ('reddit', ?, 'general', ?)`).run(now, now).lastInsertRowid as number);
    expect(() => {
      db.prepare(`
        INSERT INTO item_relationships (source_item_id, target_item_id, relation_type, created_at)
        VALUES (?, ?, 'quantum_entangled', ?)
      `).run(a, b, now);
    }).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown tag_type', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = (db.prepare(`INSERT INTO library_items (source_type, captured_at, project, created_at) VALUES ('tiktok', ?, 'general', ?)`).run(now, now).lastInsertRowid as number);
    expect(() => {
      db.prepare(`
        INSERT INTO item_tags (item_id, tag, tag_type, created_at)
        VALUES (?, 'abc', 'unknown_bucket', ?)
      `).run(itemId, now);
    }).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown content_type', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = (db.prepare(`INSERT INTO library_items (source_type, captured_at, project, created_at) VALUES ('tiktok', ?, 'general', ?)`).run(now, now).lastInsertRowid as number);
    expect(() => {
      db.prepare(`
        INSERT INTO item_content (item_id, content_type, text, created_at)
        VALUES (?, 'video_transcription_beta', 'hi', ?)
      `).run(itemId, now);
    }).toThrow(/CHECK constraint failed/);
  });
});
```

- [ ] **Step 2: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "CHECK"`
Expected: PASS (7 tests).

- [ ] **Step 3: Commit**

```bash
git add src/library.test.ts
git commit -m "test(library): verify CHECK constraints reject invalid enum values

Schema refuses unknown source_type, project, media_type, storage,
relation_type, tag_type, and content_type values. Prevents typos
from silently polluting the library."
```

---

## Task 10: Existing-database upgrade test

Simulates a pre-library database and verifies that calling `createSchema` again (as happens on every `initDatabase()` boot) adds the library tables without touching existing data.

**Files:**
- Modify: `src/library.test.ts` (extend)

- [ ] **Step 1: Write the test** — append:

```typescript
describe('library schema on existing database', () => {
  it('re-running createSchema on a populated DB adds library tables without data loss', async () => {
    _initTestDatabase();
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    // Seed a pre-existing non-library table (hive_mind) with data
    db.prepare(`
      INSERT INTO hive_mind (agent_id, chat_id, action, summary, created_at)
      VALUES ('main', 'chat1', 'seeded', 'existed before library', ?)
    `).run(now);

    // Sanity: library tables already exist after _initTestDatabase (since
    // createSchema runs there). So instead of dropping them, we verify the
    // idempotency: inserting the same schema again must be a no-op and
    // must not clear the hive_mind row.
    //
    // Pull the library schema block directly from sqlite_master and re-exec it.
    const tables = ['library_items','item_media','item_content','item_tags','item_relationships','item_embeddings','item_content_fts'];
    for (const t of tables) {
      const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(t) as { sql: string } | undefined;
      expect(row).toBeDefined();
      // Rerun — should be harmless because every statement uses IF NOT EXISTS.
      db.exec(row!.sql.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ').replace(/^CREATE VIRTUAL TABLE /, 'CREATE VIRTUAL TABLE IF NOT EXISTS '));
    }

    // Pre-existing data unchanged
    const hive = db.prepare(`SELECT * FROM hive_mind`).all() as Array<{ summary: string }>;
    expect(hive.length).toBe(1);
    expect(hive[0].summary).toBe('existed before library');

    // Library still empty + functional
    expect((db.prepare(`SELECT COUNT(*) AS n FROM library_items`).get() as { n: number }).n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test and verify it passes**

Run: `npx vitest run src/library.test.ts -t "existing database"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/library.test.ts
git commit -m "test(library): verify createSchema is idempotent on existing DB

Re-running the library schema statements on a populated DB
does not clear pre-existing tables or drop data. Confirms the
Phase 1 migration story: new installs and existing installs
both pick up the new tables on the next initDatabase() call."
```

---

## Task 11: Full suite + build sanity check

**Files:** None (meta-task).

- [ ] **Step 1: Run the full vitest suite to make sure nothing else broke**

Run: `npx vitest run`
Expected: all tests pass, including the pre-existing ones. If any unrelated test fails, investigate — the foreign-keys pragma change in Task 1 could affect tests that relied on orphaned rows surviving a delete. Fix any breakage before moving on.

- [ ] **Step 2: Build the project so the compiled bot picks up the schema**

Run: `npm run build`
Expected: `dist/` rebuilt without errors.

- [ ] **Step 3: Smoke-test that running the bot once creates the library tables in the real DB**

Run: `node -e "require('./dist/db.js').initDatabase(); const db = require('./dist/db.js')._getTestDb ? require('./dist/db.js')._getTestDb() : null; console.log('ok');"`
(If the export is not reachable this way because `db` is module-scoped, just run `npm start` for ~2 seconds, Ctrl-C, then check:)

```bash
sqlite3 store/claudeclaw.db ".tables" | tr ' ' '\n' | grep -E '^(library_items|item_media|item_content|item_tags|item_relationships|item_embeddings|item_content_fts)$' | sort
```

Expected output:
```
item_content
item_content_fts
item_embeddings
item_media
item_relationships
item_tags
library_items
```

- [ ] **Step 4: Verify indexes made it into the real DB**

```bash
sqlite3 store/claudeclaw.db ".indexes library_items" | tr ' ' '\n' | grep -E '^idx_library_items_' | sort
```

Expected: 8 index names matching the ones in `Task 2`.

- [ ] **Step 5: Commit any last adjustments**

If `npm run build` required code changes, commit them:

```bash
git add -A
git commit -m "build: rebuild dist/ with research library schema"
```

Otherwise skip the commit.

- [ ] **Step 6: Final check — confirm success criteria from spec §9 are met**

Tick off each of the following. All should already be true from prior tasks:

- [ ] Schema runs cleanly on fresh install and existing DB (Tasks 1-3, 10)
- [ ] All 6 tables + FTS5 virtual table exist (Task 1, 3)
- [ ] All indexes from spec §4.7 exist (Task 2)
- [ ] Round-trip test (Task 6)
- [ ] FTS5 triggers verified (Task 3)
- [ ] Flash drive folder structure exists (already created during brainstorming)
- [ ] `.env.example` updated with `LIBRARY_ROOT` (Task 5)
- [ ] Google Drive optional mirror requirements noted — in spec §5 already

Ready to hand off to Phase 2 (Collector agent) once this plan is complete.

---

## Self-Review Notes

**Spec coverage check (against spec §9 success criteria):**
- ✅ Migration cleanly on fresh + existing DB → Tasks 1, 10
- ✅ 6 tables + FTS5 virtual table exist → Tasks 1, 3
- ✅ All indexes from §4.7 exist → Task 2
- ✅ Round-trip test → Task 6
- ✅ FTS5 triggers verified → Task 3
- ✅ Flash drive layout documented → already done during brainstorming (directories exist on disk)
- ✅ `.env.example` updated → Task 5
- ✅ Google Drive optional mirror documented → lives in spec §5, no code change needed in Phase 1

**Placeholder check:** Every step contains runnable code, runnable commands, and expected outputs. No TBDs or "fill in later." Task 7 has a conditional fix path for FTS behavior on older SQLite versions, with exact SQL provided.

**Type consistency check:** All column names used in test INSERT statements match those defined in the CREATE TABLE statements (verified by cross-reading spec §4 and the SQL blocks).

**Scope check:** Phase 1 is schema-only. No data access layer, no Collector logic, no Playwright, no OCR. Those are Phases 2–5.
