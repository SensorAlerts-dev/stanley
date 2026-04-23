import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { _initTestDatabase, _getTestDb, _reapplyTestSchema } from './db.js';

// Raw schema introspection: fresh in-memory DB per test via _initTestDatabase(),
// then query sqlite_master / PRAGMA to verify tables, indexes, and triggers exist.
function getTables(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>)
    .map((r) => r.name);
}

function getIndexes(db: Database.Database, table: string): string[] {
  return (db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`,
  ).all(table) as Array<{ name: string }>).map((r) => r.name);
}

/** Insert a minimal library_items row and return its id. For tests that
 * need a parent row but don't care about the specific columns. */
function insertTestItem(
  db: Database.Database,
  opts: { sourceType?: string; project?: string; url?: string; urlHash?: string } = {},
): number {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare(`
    INSERT INTO library_items (source_type, url, url_hash, captured_at, project, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.sourceType ?? 'note',
    opts.url ?? null,
    opts.urlHash ?? null,
    now,
    opts.project ?? 'general',
    now,
  );
  return row.lastInsertRowid as number;
}

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

  describe('indexes', () => {
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

    it('updating non-text columns does not rewrite FTS', () => {
      // FTS5 external-content tables have no way to observe whether a row
      // has been re-indexed. To assert "no reindex happened" we rely on the
      // fact that deleting a row from item_content_fts with a stale
      // content_rowid fails — if the update trigger had erroneously run a
      // delete+insert cycle, we'd still see one row, so this is an indirect
      // sanity check. The stronger assertion is structural: the trigger
      // definition in sqlite_master must scope to "UPDATE OF text".
      const db = _getTestDb();
      const sql = db.prepare(
        `SELECT sql FROM sqlite_master WHERE name = 'item_content_fts_update'`,
      ).get() as { sql: string };
      expect(sql.sql).toMatch(/UPDATE OF text/);
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
});

describe('LIBRARY_ROOT config', () => {
  it('resolves LIBRARY_ROOT to an absolute path, defaulting to the ClaudeClaw flash drive', async () => {
    // Dynamic import so we get a fresh evaluation under the test env
    const config = await import('./config.js');
    expect(config.LIBRARY_ROOT).toMatch(/claudeclaw-library$/);
    expect(config.LIBRARY_ROOT.startsWith('/')).toBe(true);
  });
});

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

    // 2. Second item (needed for the relationship row below) — uses the new helper
    const itemId2 = insertTestItem(db, { sourceType: 'reddit', project: 'pure_bliss' });

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

describe('library cascade deletes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('deleting a library_item removes all satellite rows', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    // Create two items so we can test that only the target's satellites are deleted
    const itemA = insertTestItem(db, { sourceType: 'tiktok', project: 'pure_bliss' });
    const itemB = insertTestItem(db, { sourceType: 'reddit', project: 'pure_bliss' });

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

    const itemId = insertTestItem(db);
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

describe('library url_hash uniqueness', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('rejects a second library_item with the same url_hash', () => {
    const db = _getTestDb();

    insertTestItem(db, {
      sourceType: 'tiktok',
      url: 'https://tiktok.com/1',
      urlHash: 'samehash',
    });

    expect(() => {
      insertTestItem(db, {
        sourceType: 'tiktok',
        url: 'https://tiktok.com/2',
        urlHash: 'samehash',
      });
    }).toThrow(/UNIQUE constraint failed: library_items\.url_hash/);
  });

  it('allows multiple items with NULL url_hash (notes, voice, screenshots)', () => {
    const db = _getTestDb();

    insertTestItem(db, { sourceType: 'note' });
    insertTestItem(db, { sourceType: 'voice' });
    insertTestItem(db, { sourceType: 'screenshot' });

    const count = (db.prepare(`SELECT COUNT(*) AS n FROM library_items WHERE url_hash IS NULL`).get() as { n: number }).n;
    expect(count).toBe(3);
  });
});

describe('library schema on existing database', () => {
  // No beforeEach: this test deliberately runs _initTestDatabase() once and
  // then simulates a second boot via _reapplyTestSchema() to verify that
  // rerunning createSchema on a populated DB does not drop any data.
  it('re-running createSchema on a populated DB preserves existing data', () => {
    _initTestDatabase();
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    // Seed a pre-existing non-library row (simulates data from before the
    // library tables existed) plus a library row and its satellite (simulates
    // a DB that already contains library data when the next boot happens).
    db.prepare(`
      INSERT INTO hive_mind (agent_id, chat_id, action, summary, created_at)
      VALUES ('main', 'chat1', 'seeded', 'existed before reboot', ?)
    `).run(now);

    const seededItem = insertTestItem(db, { sourceType: 'note', project: 'general' });
    db.prepare(`
      INSERT INTO item_content (item_id, content_type, text, created_at)
      VALUES (?, 'user_note', 'survives reboot', ?)
    `).run(seededItem, now);

    // Simulate a fresh boot: re-run the actual createSchema function on the
    // same DB. This is the real scenario we care about — if a future edit to
    // createSchema accidentally DROPs or TRUNCATEs, this test catches it.
    _reapplyTestSchema();

    // Pre-existing non-library row unchanged
    const hive = db.prepare(`SELECT summary FROM hive_mind`).all() as Array<{ summary: string }>;
    expect(hive.length).toBe(1);
    expect(hive[0].summary).toBe('existed before reboot');

    // Pre-existing library rows unchanged
    const items = db.prepare(`SELECT COUNT(*) AS n FROM library_items`).get() as { n: number };
    expect(items.n).toBe(1);
    const content = db.prepare(`SELECT text FROM item_content WHERE item_id = ?`).get(seededItem) as { text: string };
    expect(content.text).toBe('survives reboot');

    // FTS still wired up on the preserved content
    const hits = db.prepare(
      `SELECT item_id FROM item_content_fts WHERE item_content_fts MATCH 'reboot'`,
    ).all() as Array<{ item_id: number }>;
    expect(hits.some((h) => h.item_id === seededItem)).toBe(true);
  });
});

describe('library.ts URL helpers', () => {
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
    }).toThrow(/CHECK constraint failed: source_type IN/);
  });

  it('rejects an unknown project', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    expect(() => {
      db.prepare(`
        INSERT INTO library_items (source_type, captured_at, project, created_at)
        VALUES ('tiktok', ?, 'world_domination', ?)
      `).run(now, now);
    }).toThrow(/CHECK constraint failed: project IN/);
  });

  it('rejects an unknown media_type', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = insertTestItem(db, { sourceType: 'tiktok' });
    expect(() => {
      db.prepare(`
        INSERT INTO item_media (item_id, media_type, storage, created_at)
        VALUES (?, 'gif', 'local', ?)
      `).run(itemId, now);
    }).toThrow(/CHECK constraint failed: media_type IN/);
  });

  it('rejects an unknown storage value', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = insertTestItem(db, { sourceType: 'tiktok' });
    expect(() => {
      db.prepare(`
        INSERT INTO item_media (item_id, media_type, storage, created_at)
        VALUES (?, 'image', 's3', ?)
      `).run(itemId, now);
    }).toThrow(/CHECK constraint failed: storage IN/);
  });

  it('rejects an unknown relation_type', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const a = insertTestItem(db, { sourceType: 'tiktok' });
    const b = insertTestItem(db, { sourceType: 'reddit' });
    expect(() => {
      db.prepare(`
        INSERT INTO item_relationships (source_item_id, target_item_id, relation_type, created_at)
        VALUES (?, ?, 'quantum_entangled', ?)
      `).run(a, b, now);
    }).toThrow(/CHECK constraint failed: relation_type IN/);
  });

  it('rejects an unknown tag_type', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = insertTestItem(db, { sourceType: 'tiktok' });
    expect(() => {
      db.prepare(`
        INSERT INTO item_tags (item_id, tag, tag_type, created_at)
        VALUES (?, 'abc', 'unknown_bucket', ?)
      `).run(itemId, now);
    }).toThrow(/CHECK constraint failed: tag_type IN/);
  });

  it('rejects an unknown content_type', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = insertTestItem(db, { sourceType: 'tiktok' });
    expect(() => {
      db.prepare(`
        INSERT INTO item_content (item_id, content_type, text, created_at)
        VALUES (?, 'video_transcription_beta', 'hi', ?)
      `).run(itemId, now);
    }).toThrow(/CHECK constraint failed: content_type IN/);
  });
});
