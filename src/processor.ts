/**
 * Phase 3 Processor orchestrator.
 *
 * Two entry points called by scheduled tasks:
 *   drainQueue({ maxTasks }) — claim and process queued mission_tasks
 *                              assigned to 'processor'.
 *   sweepStale()             — queue mission_tasks for library_items where
 *                              enriched_at IS NULL and no task exists.
 *
 * Per-media-type enrichment is delegated to src/enrichers/*.ts.
 * Retries up to MAX_ATTEMPTS times. Failures record task.error; permanent
 * failures set status='failed' so they stop being picked up.
 */

import { randomBytes } from 'crypto';
import {
  _getTestDb,
  getItem,
  markEnriched,
  type FullItem,
} from './library.js';
import { logger } from './logger.js';

const PROCESSOR_AGENT_ID = 'processor';
const MAX_ATTEMPTS = 3;
const DEFAULT_MAX_TASKS = 10;

export interface DrainResult {
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface SweepResult {
  queued: number;
}

export interface EnrichOutcome {
  ok: boolean;
  rawText?: string;
  rawContentType?: 'ocr' | 'scraped_summary' | 'transcript' | 'user_note';
  summaryHint?: string;
  titleHint?: string | null;
  error?: string;
  errorCode?: string;
}

export async function drainQueue(opts: { maxTasks?: number } = {}): Promise<DrainResult> {
  const maxTasks = opts.maxTasks ?? DEFAULT_MAX_TASKS;
  const db = _getTestDb();
  const result: DrainResult = { processed: 0, completed: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < maxTasks; i++) {
    const task = claimOne(db);
    if (!task) break;

    result.processed++;

    // Increment attempts before the work (so a crash mid-work still counts)
    db.prepare(`UPDATE mission_tasks SET attempts = attempts + 1 WHERE id = ?`).run(task.id);

    try {
      const itemId = parseItemId(task.prompt);
      if (!itemId) {
        completeTask(db, task.id, 'failed', 'could not parse item id from prompt');
        result.failed++;
        continue;
      }

      const item = getItem(itemId);
      if (!item) {
        completeTask(db, task.id, 'failed', `item ${itemId} not found`);
        result.failed++;
        continue;
      }

      if (item.enriched_at) {
        completeTask(db, task.id, 'completed', null);
        result.skipped++;
        continue;
      }

      const outcome = await processTask(item);
      if (outcome.ok) {
        markEnriched(item.id);
        completeTask(db, task.id, 'completed', null);
        logHiveMind(db, item.id, item.project, outcome.summaryHint ?? item.source_type);
        result.completed++;
      } else {
        const currentAttempts =
          (db.prepare(`SELECT attempts FROM mission_tasks WHERE id = ?`).get(task.id) as { attempts: number }).attempts;
        if (currentAttempts >= MAX_ATTEMPTS) {
          completeTask(db, task.id, 'failed', outcome.error ?? 'unknown error');
          result.failed++;
        } else {
          // Leave it queued by flipping status back from 'running'
          db.prepare(`UPDATE mission_tasks SET status = 'queued', error = ?, started_at = NULL WHERE id = ?`)
            .run(outcome.error ?? 'unknown error', task.id);
          result.skipped++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, taskId: task.id }, 'Processor: unhandled error during processTask');
      completeTask(db, task.id, 'failed', msg);
      result.failed++;
    }
  }

  return result;
}

export async function sweepStale(): Promise<SweepResult> {
  const db = _getTestDb();
  const now = Math.floor(Date.now() / 1000);

  // Items that need enrichment but don't already have an open processor task
  const items = db.prepare(`
    SELECT li.id
    FROM library_items li
    WHERE li.enriched_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM mission_tasks mt
        WHERE mt.assigned_agent = 'processor'
          AND mt.status IN ('queued', 'running')
          AND mt.prompt LIKE '%item ' || li.id || ':%'
      )
  `).all() as Array<{ id: number }>;

  let queued = 0;
  for (const { id } of items) {
    const taskId = randomBytes(4).toString('hex');
    db.prepare(`
      INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at)
      VALUES (?, ?, ?, 'processor', 'queued', 'processor-sweep', 0, ?)
    `).run(taskId, `process item ${id}`, `Process library item ${id}: fallback sweep`, now);
    queued++;
  }

  if (queued > 0) logger.info({ queued }, 'Processor: fallback sweep queued tasks');
  return { queued };
}

// ── Internal helpers ──────────────────────────────────────────────────

interface ClaimedTask {
  id: string;
  prompt: string;
  attempts: number;
}

function claimOne(db: ReturnType<typeof _getTestDb>): ClaimedTask | null {
  const txn = db.transaction(() => {
    const task = db.prepare(`
      SELECT id, prompt, attempts FROM mission_tasks
      WHERE assigned_agent = 'processor' AND status = 'queued'
        AND attempts < ${MAX_ATTEMPTS}
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get() as ClaimedTask | undefined;
    if (!task) return null;
    db.prepare(`UPDATE mission_tasks SET status = 'running', started_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000), task.id);
    return task;
  });
  return txn.immediate() ?? null;
}

function completeTask(
  db: ReturnType<typeof _getTestDb>,
  id: string,
  status: 'completed' | 'failed',
  error: string | null,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE mission_tasks SET status = ?, error = ?, completed_at = ? WHERE id = ?`)
    .run(status, error, now, id);
}

function parseItemId(prompt: string): number | null {
  const m = prompt.match(/item (\d+):/);
  return m ? parseInt(m[1], 10) : null;
}

function logHiveMind(
  db: ReturnType<typeof _getTestDb>,
  itemId: number,
  project: string,
  what: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  const summary = `enriched #${itemId} (${project}) ${what.slice(0, 80)}`;
  db.prepare(`
    INSERT INTO hive_mind (agent_id, chat_id, action, summary, artifacts, created_at)
    VALUES (?, '', 'enrich', ?, NULL, ?)
  `).run(PROCESSOR_AGENT_ID, summary, now);
}

async function processTask(item: FullItem): Promise<EnrichOutcome> {
  // Placeholder dispatcher. Real enrichers get wired in Waves 2 and 3.
  // For Wave 1 the orchestrator just declares success for notes (which are
  // already enriched at ingest) and defers everything else.
  if (item.source_type === 'note') {
    return { ok: true, summaryHint: 'note (already enriched)' };
  }
  return {
    ok: false,
    error: `no enricher registered for source_type=${item.source_type}`,
    errorCode: 'no_enricher',
  };
}

/**
 * Register the two Processor cron entries in scheduled_tasks.
 * Idempotent: uses INSERT OR IGNORE so repeated calls are no-ops.
 * Call once at ClaudeClaw startup (after initDatabase).
 *
 * processor-drain: runs every minute — claims and processes queued mission_tasks.
 * processor-sweep: runs every hour  — queues tasks for unenriched library_items.
 *
 * agent_id defaults to 'main' (the default column value) so the main scheduler
 * picks these up. The processor-cli shelling logic in scheduler.ts intercepts
 * these prompts before they reach the Claude agent.
 */
export function registerProcessorSchedules(): void {
  const db = _getTestDb();
  const now = Math.floor(Date.now() / 1000);
  const nextMin = now + 60;    // first drain fires ~1 minute after startup
  const nextHour = now + 3600; // first sweep fires ~1 hour after startup

  db.prepare(`
    INSERT OR IGNORE INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at)
    VALUES ('processor-drain', 'processor:drain', '* * * * *', ?, 'active', ?)
  `).run(nextMin, now);

  db.prepare(`
    INSERT OR IGNORE INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at)
    VALUES ('processor-sweep', 'processor:sweep', '0 * * * *', ?, 'active', ?)
  `).run(nextHour, now);
}
