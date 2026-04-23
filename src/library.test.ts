import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { _initTestDatabase, _getTestDb } from './db.js';

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
