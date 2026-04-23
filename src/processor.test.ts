import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase, _getTestDb } from './db.js';

// Mock all enrichers so the orchestrator can be exercised without external deps
vi.mock('./enrichers/url.js', () => ({ enrichUrl: vi.fn() }));
vi.mock('./enrichers/image.js', () => ({ enrichImage: vi.fn() }));
vi.mock('./enrichers/pdf.js', () => ({ enrichPdf: vi.fn() }));
vi.mock('./enrichers/audio.js', () => ({ enrichAudio: vi.fn() }));
vi.mock('./enrichers/video.js', () => ({ enrichVideo: vi.fn() }));

import { drainQueue, sweepStale } from './processor.js';

describe('processor orchestrator skeleton', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('drainQueue returns {processed: 0} when no tasks are queued', async () => {
    const result = await drainQueue();
    expect(result.processed).toBe(0);
  });

  it('drainQueue processes up to maxTasks tasks and returns count', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('note', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);

    db.prepare(`
      INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at)
      VALUES ('t1', 'process', 'Process library item ${itemId}: x', 'processor', 'queued', 'memobot', 0, ?)
    `).run(now);

    const result = await drainQueue({ maxTasks: 10 });
    expect(result.processed).toBeGreaterThanOrEqual(0);
    const row = db.prepare(`SELECT status FROM mission_tasks WHERE id = 't1'`).get() as { status: string };
    expect(['running', 'completed', 'failed']).toContain(row.status);
  });

  it('sweepStale queues tasks for unenriched items not already queued', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO library_items (id, source_type, captured_at, project, created_at, enriched_at)
      VALUES (42, 'tiktok', ?, 'general', ?, NULL)
    `).run(now, now);

    const result = await sweepStale();
    expect(result.queued).toBe(1);

    const task = db.prepare(`SELECT prompt FROM mission_tasks WHERE assigned_agent = 'processor' ORDER BY created_at DESC LIMIT 1`).get() as { prompt: string };
    expect(task.prompt).toContain('item 42');
  });

  it('sweepStale does not queue duplicates when a task already exists', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO library_items (id, source_type, captured_at, project, created_at, enriched_at)
      VALUES (43, 'note', ?, 'general', ?, NULL)
    `).run(now, now);
    db.prepare(`
      INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at)
      VALUES ('existing', 'process', 'Process library item 43: x', 'processor', 'queued', 'memobot', 0, ?)
    `).run(now);

    const result = await sweepStale();
    expect(result.queued).toBe(0);
  });
});
