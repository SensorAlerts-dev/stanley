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

  it('drainQueue processes a note task: completes + marks enriched + logs hive_mind', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);
    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('note', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);

    db.prepare(`
      INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at)
      VALUES ('t1', 'process', 'Process library item ${itemId}: note capture', 'processor', 'queued', 'memobot', 0, ?)
    `).run(now);

    const result = await drainQueue({ maxTasks: 10 });
    expect(result.processed).toBe(1);
    expect(result.completed).toBe(1);

    // Task reached 'completed' status
    const taskRow = db.prepare(`SELECT status, completed_at, error FROM mission_tasks WHERE id = 't1'`).get() as { status: string; completed_at: number | null; error: string | null };
    expect(taskRow.status).toBe('completed');
    expect(taskRow.completed_at).toBeGreaterThan(0);
    expect(taskRow.error).toBeNull();

    // Item was marked enriched
    const item = db.prepare(`SELECT enriched_at FROM library_items WHERE id = ?`).get(itemId) as { enriched_at: number | null };
    expect(item.enriched_at).not.toBeNull();
    expect(item.enriched_at!).toBeGreaterThan(0);

    // hive_mind row written
    const hiveRow = db.prepare(`SELECT agent_id, action, summary FROM hive_mind WHERE agent_id = 'processor'`).get() as { agent_id: string; action: string; summary: string };
    expect(hiveRow).toBeDefined();
    expect(hiveRow.agent_id).toBe('processor');
    expect(hiveRow.action).toBe('enrich');
    expect(hiveRow.summary).toContain('enriched');
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
