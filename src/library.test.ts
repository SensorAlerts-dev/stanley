import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { _initTestDatabase, _getTestDb } from './db.js';

// Raw schema introspection: fresh in-memory DB per test via _initTestDatabase(),
// then query sqlite_master / PRAGMA to verify tables, indexes, and triggers exist.
function getTables(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>)
    .map((r) => r.name);
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
});
