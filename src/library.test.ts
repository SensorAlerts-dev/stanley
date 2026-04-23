import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { _initTestDatabase, _getTestDb, _reapplyTestSchema, _rerunMigrations } from './db.js';

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

  it('canonicalizeUrl preserves t= on non-tiktok hosts (youtube playback timestamp)', async () => {
    const { canonicalizeUrl } = await import('./library.js');
    expect(canonicalizeUrl('https://youtube.com/watch?v=abc&t=120'))
      .toBe('https://youtube.com/watch?v=abc&t=120');
  });

  it('canonicalizeUrl preserves ref= on github.com (canonical branch selector)', async () => {
    const { canonicalizeUrl } = await import('./library.js');
    expect(canonicalizeUrl('https://github.com/user/repo/blob/main/file.ts?ref=main'))
      .toBe('https://github.com/user/repo/blob/main/file.ts?ref=main');
  });

  it('canonicalizeUrl strips ref= on non-github hosts', async () => {
    const { canonicalizeUrl } = await import('./library.js');
    expect(canonicalizeUrl('https://example.com/article?ref=newsletter&id=1'))
      .toBe('https://example.com/article?id=1');
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
    expect(inferProject('octopus mascot for new water kefir brand')).toBe('octohive');
  });
});

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
    const { insertItem, urlHash, canonicalizeUrl } = await import('./library.js');
    const res = insertItem({ source_type: 'article', url: 'https://example.com/x' });
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

describe('library.ts satellite helpers', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('addMedia inserts an item_media row and returns its id', async () => {
    const { insertItem, addMedia, _getTestDb: getDb } = await import('./library.js');
    const item = insertItem({ source_type: 'screenshot' });
    const mediaId = addMedia(item.id, {
      media_type: 'image',
      file_path: 'general/screenshots/20260423-1512_1_test.png',
      storage: 'local',
      mime_type: 'image/png',
      bytes: 4096,
    });
    expect(mediaId).toBeGreaterThan(0);
    const db = getDb();
    const row = db.prepare(`SELECT * FROM item_media WHERE id = ?`).get(mediaId) as Record<string, unknown>;
    expect(row.item_id).toBe(item.id);
    expect(row.media_type).toBe('image');
    expect(row.storage).toBe('local');
    expect(row.bytes).toBe(4096);
  });

  it('addContent inserts an item_content row and returns its id', async () => {
    const { insertItem, addContent, _getTestDb: getDb } = await import('./library.js');
    const item = insertItem({ source_type: 'article', url: 'https://example.com/a' });
    const contentId = addContent(item.id, {
      content_type: 'scraped_summary',
      text: 'brief summary here',
      source_agent: 'memobot',
    });
    expect(contentId).toBeGreaterThan(0);
    const db = getDb();
    const row = db.prepare(`SELECT * FROM item_content WHERE id = ?`).get(contentId) as Record<string, unknown>;
    expect(row.item_id).toBe(item.id);
    expect(row.content_type).toBe('scraped_summary');
    expect(row.text).toBe('brief summary here');
  });

  it('addContent triggers FTS5 index (content is searchable after insert)', async () => {
    const { insertItem, addContent, _getTestDb: getDb } = await import('./library.js');
    const item = insertItem({ source_type: 'note' });
    addContent(item.id, {
      content_type: 'user_note',
      text: 'unique-fts-probe-platypus',
      source_agent: 'memobot',
    });
    const db = getDb();
    const hits = db.prepare(`SELECT item_id FROM item_content_fts WHERE item_content_fts MATCH 'platypus'`).all() as Array<{ item_id: number }>;
    expect(hits.length).toBe(1);
    expect(hits[0].item_id).toBe(item.id);
  });

  it('addTag inserts an item_tags row (idempotent on composite PK)', async () => {
    const { insertItem, addTag, _getTestDb: getDb } = await import('./library.js');
    const item = insertItem({ source_type: 'tiktok', url: 'https://tiktok.com/@x/1' });
    addTag(item.id, { tag: '@brewlife', tag_type: 'person', source_agent: 'memobot', confidence: 1.0 });
    addTag(item.id, { tag: 'kefir', tag_type: 'topic', source_agent: 'memobot' });

    const db = getDb();
    const tags = db.prepare(`SELECT tag, tag_type FROM item_tags WHERE item_id = ? ORDER BY tag`).all(item.id);
    expect(tags.length).toBe(2);
    expect(tags).toEqual([
      { tag: '@brewlife', tag_type: 'person' },
      { tag: 'kefir', tag_type: 'topic' },
    ]);
  });

  it('addTag is idempotent -- duplicate tag on same item does not throw', async () => {
    const { insertItem, addTag } = await import('./library.js');
    const item = insertItem({ source_type: 'tiktok', url: 'https://tiktok.com/@x/1' });
    addTag(item.id, { tag: '@brewlife', tag_type: 'person', source_agent: 'memobot' });
    expect(() => {
      addTag(item.id, { tag: '@brewlife', tag_type: 'person', source_agent: 'memobot' });
    }).not.toThrow();
  });
});

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
    const { insertItem, queueProcessorTask, _getTestDb: getDb } = await import('./library.js');
    const db = getDb();
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

describe('library.ts lifecycle setters', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('markEnriched sets enriched_at to given timestamp', async () => {
    const { insertItem, markEnriched, _getTestDb: getDb } = await import('./library.js');
    const db = getDb();
    const item = insertItem({ source_type: 'note' });
    const ts = 1800000000;
    markEnriched(item.id, ts);
    const row = db.prepare(`SELECT enriched_at FROM library_items WHERE id = ?`).get(item.id) as { enriched_at: number };
    expect(row.enriched_at).toBe(ts);
  });

  it('markEnriched defaults to now when no timestamp given', async () => {
    const { insertItem, markEnriched, _getTestDb: getDb } = await import('./library.js');
    const db = getDb();
    const item = insertItem({ source_type: 'note' });
    const before = Math.floor(Date.now() / 1000);
    markEnriched(item.id);
    const row = db.prepare(`SELECT enriched_at FROM library_items WHERE id = ?`).get(item.id) as { enriched_at: number };
    expect(row.enriched_at).toBeGreaterThanOrEqual(before);
  });

  it('markReviewed sets reviewed_at', async () => {
    const { insertItem, markReviewed, _getTestDb: getDb } = await import('./library.js');
    const db = getDb();
    const item = insertItem({ source_type: 'note' });
    markReviewed(item.id, 1800000000);
    const row = db.prepare(`SELECT reviewed_at FROM library_items WHERE id = ?`).get(item.id) as { reviewed_at: number };
    expect(row.reviewed_at).toBe(1800000000);
  });

  it('setPinned toggles the pinned flag', async () => {
    const { insertItem, setPinned, _getTestDb: getDb } = await import('./library.js');
    const db = getDb();
    const item = insertItem({ source_type: 'note' });
    setPinned(item.id, true);
    expect((db.prepare(`SELECT pinned FROM library_items WHERE id = ?`).get(item.id) as { pinned: number }).pinned).toBe(1);
    setPinned(item.id, false);
    expect((db.prepare(`SELECT pinned FROM library_items WHERE id = ?`).get(item.id) as { pinned: number }).pinned).toBe(0);
  });

  it('setProject updates project column', async () => {
    const { insertItem, setProject, _getTestDb: getDb } = await import('./library.js');
    const db = getDb();
    const item = insertItem({ source_type: 'note', project: 'general' });
    setProject(item.id, 'pure_bliss');
    expect((db.prepare(`SELECT project FROM library_items WHERE id = ?`).get(item.id) as { project: string }).project).toBe('pure_bliss');
  });

  it('setProject rejects invalid project', async () => {
    const { insertItem, setProject } = await import('./library.js');
    const item = insertItem({ source_type: 'note' });
    expect(() => setProject(item.id, 'invalid_project' as never)).toThrow();
  });

  it('deleteItem cascades to satellites', async () => {
    const { insertItem, addMedia, addContent, addTag, deleteItem, _getTestDb: getDb } = await import('./library.js');
    const db = getDb();
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

describe('library.ts extractOgMeta', () => {
  it('extracts og:title, og:description, og:image', async () => {
    const { extractOgMeta } = await import('./library.js');
    const html = `<!DOCTYPE html>
<html><head>
  <meta property="og:title" content="Great Article Title">
  <meta property="og:description" content="A short description of the article.">
  <meta property="og:image" content="https://example.com/thumb.jpg">
</head><body></body></html>`;
    const meta = extractOgMeta(html, 'https://example.com/article');
    expect(meta.title).toBe('Great Article Title');
    expect(meta.description).toBe('A short description of the article.');
    expect(meta.image).toBe('https://example.com/thumb.jpg');
  });

  it('falls back to <title> tag when og:title is absent', async () => {
    const { extractOgMeta } = await import('./library.js');
    const html = `<html><head><title>Page Title Here</title></head></html>`;
    const meta = extractOgMeta(html, 'https://example.com/x');
    expect(meta.title).toBe('Page Title Here');
  });

  it('decodes HTML entities', async () => {
    const { extractOgMeta } = await import('./library.js');
    const html = `<meta property="og:title" content="Ben &amp; Jerry&#39;s">`;
    const meta = extractOgMeta(html, 'https://example.com/');
    expect(meta.title).toBe("Ben & Jerry's");
  });

  it('handles reversed attribute order', async () => {
    const { extractOgMeta } = await import('./library.js');
    const html = `<meta content="Reversed" property="og:title" />`;
    const meta = extractOgMeta(html, 'https://example.com/');
    expect(meta.title).toBe('Reversed');
  });

  it('returns null fields when no meta tags present', async () => {
    const { extractOgMeta } = await import('./library.js');
    const meta = extractOgMeta('<html><body>Nothing here</body></html>', 'https://example.com/');
    expect(meta.title).toBeNull();
    expect(meta.description).toBeNull();
  });

  it('extracts twitter:* as fallback when og:* missing', async () => {
    const { extractOgMeta } = await import('./library.js');
    const html = `<meta name="twitter:title" content="Twitter Title Only">`;
    const meta = extractOgMeta(html, 'https://example.com/');
    expect(meta.title).toBe('Twitter Title Only');
  });

  it('extracts article:author', async () => {
    const { extractOgMeta } = await import('./library.js');
    const html = `<meta property="article:author" content="Jane Doe">`;
    const meta = extractOgMeta(html, 'https://example.com/');
    expect(meta.author).toBe('Jane Doe');
  });

  it('sets finalUrl from argument', async () => {
    const { extractOgMeta } = await import('./library.js');
    const meta = extractOgMeta('<html></html>', 'https://example.com/after-redirect');
    expect(meta.finalUrl).toBe('https://example.com/after-redirect');
  });
});

describe('library.ts fetchOgMeta', () => {
  it('fetches a local server and extracts og: metadata', async () => {
    const { fetchOgMeta } = await import('./library.js');
    const http = await import('http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html><head>
  <meta property="og:title" content="Local Test Title">
  <meta property="og:description" content="A local test description.">
</head></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const meta = await fetchOgMeta(`http://127.0.0.1:${port}/x`);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe('Local Test Title');
    expect(meta!.description).toBe('A local test description.');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 15000);

  it('returns null on connection refused', async () => {
    const { fetchOgMeta } = await import('./library.js');
    const meta = await fetchOgMeta('http://127.0.0.1:1/unreachable');
    expect(meta).toBeNull();
  }, 15000);

  it('follows a redirect', async () => {
    const { fetchOgMeta } = await import('./library.js');
    const http = await import('http');
    const server = http.createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { 'Location': '/final' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<meta property="og:title" content="Redirected Page">`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const meta = await fetchOgMeta(`http://127.0.0.1:${port}/start`);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe('Redirected Page');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 15000);
});

describe('schema migration: ai_summary content_type', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('accepts ai_summary as a content_type', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('note', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);

    expect(() => {
      db.prepare(`
        INSERT INTO item_content (item_id, content_type, text, created_at)
        VALUES (?, 'ai_summary', 'one line summary', ?)
      `).run(itemId, now);
    }).not.toThrow();
  });

  it('still rejects unknown content_type values', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('note', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);

    expect(() => {
      db.prepare(`
        INSERT INTO item_content (item_id, content_type, text, created_at)
        VALUES (?, 'bogus', 'nope', ?)
      `).run(itemId, now);
    }).toThrow(/CHECK constraint failed/);
  });
});

describe('schema migration: ai_summary content_type — migration path', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('migrates existing DB: preserves data, rebuilds FTS, new enum works', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    // Roll the schema back to the NARROW CHECK to simulate a pre-migration DB.
    db.exec(`
      DROP TRIGGER IF EXISTS item_content_fts_insert;
      DROP TRIGGER IF EXISTS item_content_fts_update;
      DROP TRIGGER IF EXISTS item_content_fts_delete;
      DROP TABLE item_content;
      CREATE TABLE item_content (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id       INTEGER NOT NULL,
        content_type  TEXT NOT NULL CHECK (content_type IN ('ocr','scraped_summary','transcript','user_note')),
        text          TEXT NOT NULL,
        source_agent  TEXT,
        token_count   INTEGER,
        created_at    INTEGER NOT NULL,
        FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_item_content_item_id ON item_content(item_id);
      CREATE TRIGGER item_content_fts_insert AFTER INSERT ON item_content BEGIN
        INSERT INTO item_content_fts(rowid, text, item_id, content_type)
          VALUES (new.id, new.text, new.item_id, new.content_type);
      END;
      CREATE TRIGGER item_content_fts_update AFTER UPDATE OF text ON item_content BEGIN
        INSERT INTO item_content_fts(item_content_fts, rowid, text, item_id, content_type)
          VALUES ('delete', old.id, old.text, old.item_id, old.content_type);
        INSERT INTO item_content_fts(rowid, text, item_id, content_type)
          VALUES (new.id, new.text, new.item_id, new.content_type);
      END;
      CREATE TRIGGER item_content_fts_delete AFTER DELETE ON item_content BEGIN
        INSERT INTO item_content_fts(item_content_fts, rowid, text, item_id, content_type)
          VALUES ('delete', old.id, old.text, old.item_id, old.content_type);
      END;
      -- Clear FTS since the table recreate above leaves it empty
      INSERT INTO item_content_fts(item_content_fts) VALUES ('delete-all');
    `);

    // Seed a parent item and some content rows using the old narrow enum.
    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('note', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);

    db.prepare(`INSERT INTO item_content (item_id, content_type, text, created_at) VALUES (?, 'user_note', 'original fermentation notes', ?)`).run(itemId, now);
    db.prepare(`INSERT INTO item_content (item_id, content_type, text, created_at) VALUES (?, 'transcript', 'some transcribed speech', ?)`).run(itemId, now);

    // Sanity: narrow CHECK still in effect — ai_summary insert must fail.
    expect(() => {
      db.prepare(`INSERT INTO item_content (item_id, content_type, text, created_at) VALUES (?, 'ai_summary', 'nope', ?)`).run(itemId, now);
    }).toThrow(/CHECK constraint failed/);

    // Run the migration.
    _rerunMigrations();

    // 1. Pre-migration rows survived.
    const rows = db.prepare(`SELECT content_type, text FROM item_content WHERE item_id = ? ORDER BY id`).all(itemId) as Array<{ content_type: string; text: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe('original fermentation notes');
    expect(rows[1].text).toBe('some transcribed speech');

    // 2. ai_summary inserts succeed post-migration.
    expect(() => {
      db.prepare(`INSERT INTO item_content (item_id, content_type, text, created_at) VALUES (?, 'ai_summary', 'rebuilt works', ?)`).run(itemId, now);
    }).not.toThrow();

    // 3. FTS index finds pre-migration text.
    const ftsHits = db.prepare(`SELECT rowid FROM item_content_fts WHERE item_content_fts MATCH 'fermentation'`).all() as Array<{ rowid: number }>;
    expect(ftsHits.length).toBeGreaterThan(0);

    // 4. UPDATE OF text fires the rebuilt update trigger.
    const firstContentId = (db.prepare(`SELECT id FROM item_content WHERE item_id = ? ORDER BY id LIMIT 1`).get(itemId) as { id: number }).id;
    db.prepare(`UPDATE item_content SET text = 'completely new text about kimchi' WHERE id = ?`).run(firstContentId);
    const kimchiHits = db.prepare(`SELECT rowid FROM item_content_fts WHERE item_content_fts MATCH 'kimchi'`).all() as Array<{ rowid: number }>;
    expect(kimchiHits.length).toBeGreaterThan(0);
    const fermentationHits = db.prepare(`SELECT rowid FROM item_content_fts WHERE item_content_fts MATCH 'fermentation'`).all() as Array<{ rowid: number }>;
    // The updated row's old 'fermentation' text should be gone; the other row didn't contain it.
    expect(fermentationHits.length).toBe(0);
  });
});

describe('schema migration: mission_tasks.attempts column', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('mission_tasks has an attempts column defaulting to 0', () => {
    const db = _getTestDb();
    const cols = db.prepare(`PRAGMA table_info(mission_tasks)`).all() as Array<{ name: string; dflt_value: string | null }>;
    const attempts = cols.find((c) => c.name === 'attempts');
    expect(attempts).toBeDefined();
    expect(attempts!.dflt_value).toBe('0');
  });

  it('increments attempts on UPDATE', () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at)
      VALUES ('t1', 'test', 'p', 'processor', 'queued', 'test', 0, ?)
    `).run(now);

    db.prepare(`UPDATE mission_tasks SET attempts = attempts + 1 WHERE id = 't1'`).run();
    db.prepare(`UPDATE mission_tasks SET attempts = attempts + 1 WHERE id = 't1'`).run();

    const row = db.prepare(`SELECT attempts FROM mission_tasks WHERE id = 't1'`).get() as { attempts: number };
    expect(row.attempts).toBe(2);
  });

  it('migrates an existing DB without attempts column', () => {
    const db = _getTestDb();
    // Roll back: recreate mission_tasks without the attempts column
    db.exec(`
      DROP TABLE mission_tasks;
      CREATE TABLE mission_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        assigned_agent TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        result TEXT,
        error TEXT,
        created_by TEXT NOT NULL DEFAULT 'dashboard',
        priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      );
    `);
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at) VALUES ('m1', 't', 'p', 'processor', 'queued', 'test', 0, ?)`).run(now);

    _rerunMigrations();

    const row = db.prepare(`SELECT attempts FROM mission_tasks WHERE id = 'm1'`).get() as { attempts: number };
    expect(row.attempts).toBe(0);
  });
});
