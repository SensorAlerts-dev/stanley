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
});
