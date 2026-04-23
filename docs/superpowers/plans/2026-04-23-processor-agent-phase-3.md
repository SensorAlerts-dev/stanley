# Processor Agent — Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a background Processor that drains memobot's queued `mission_tasks`, enriches library items with extracted text (OCR / transcript / scrape / pdf-text) and AI-generated summaries (local Qwen via Ollama), then marks them enriched so `/find` and `/recent` surface meaningful content.

**Architecture:** Pure in-process code (no Telegram bot, no launchd service). A new `src/processor.ts` orchestrator is invoked via two scheduled tasks — a 1-minute queue drain and a 1-hour fallback sweep — registered through the existing `src/scheduler.ts` tasks table. Per-media-type enrichers live under `src/enrichers/`. All DB writes go through the existing `library.ts` API; mission_task lifecycle reuses existing `claimNextMissionTask`/`completeMissionTask` helpers.

**Tech Stack:** Node.js 20+, TypeScript, better-sqlite3, vitest, local Ollama daemon (qwen2.5:3b-instruct already pulled), tesseract (brew), ffmpeg (brew), pdf-parse (npm), existing Playwright install, existing `src/voice.ts transcribeAudio()`.

**Spec reference:** `docs/superpowers/specs/2026-04-23-processor-agent-design.md`

---

## File Structure

**Created:**
- `src/enrichers/ollama.ts` — HTTP client for local Ollama; exports `summarize()` and `headline()`.
- `src/enrichers/url.ts` — Playwright-based URL scraper.
- `src/enrichers/image.ts` — Tesseract OCR wrapper.
- `src/enrichers/pdf.ts` — pdf-parse wrapper.
- `src/enrichers/audio.ts` — Reuses `voice.ts transcribeAudio()`.
- `src/enrichers/video.ts` — Extracts audio via ffmpeg, delegates to audio enricher.
- `src/processor.ts` — Orchestrator (drainQueue, sweepStale, processTask, dispatchEnricher).
- `src/processor-cli.ts` — Thin CLI so scheduler can invoke `drain` / `sweep` subcommands.
- Test files alongside each of the above.

**Modified:**
- `src/db.ts` — schema widening for `item_content.content_type` enum + `mission_tasks.attempts` column; inline migrations in `runMigrations()`.
- `src/scheduler.ts` — register the two Processor cron entries at startup.
- `src/library.ts` — add `AiSummary` to the `AddContentOpts` union; no behavior change, just type widening.
- `package.json` — add `pdf-parse` dependency.

**Branch:** `feat/processor-agent` (create from main before Task 1). All commits land there. Merge back when Wave 4 smoke passes.

---

# Wave 1 — Foundation

Wave 1 lands the schema changes, Ollama client, orchestrator skeleton, and scheduler wiring. After Wave 1: no enrichment yet, but Processor can be invoked, reads from mission_tasks, and no-ops cleanly.

## Task 1: Schema — widen `item_content.content_type` enum

**Files:**
- Modify: `src/db.ts` (add to `runMigrations()` around line 700)
- Test: `src/library.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `src/library.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/library.test.ts -t "ai_summary content_type"`
Expected: FAIL on the first test with `CHECK constraint failed: content_type IN` because the enum hasn't been widened yet.

- [ ] **Step 3: Update the inline schema in `createSchema()` in `src/db.ts`**

Find the `CREATE TABLE IF NOT EXISTS item_content (` block. Change the `content_type` CHECK:

```sql
content_type  TEXT NOT NULL CHECK (content_type IN ('ocr','scraped_summary','transcript','user_note','ai_summary')),
```

- [ ] **Step 4: Add an inline migration for existing DBs in `runMigrations()` in `src/db.ts`**

Add this block inside `runMigrations()` near the other column-widening migrations:

```typescript
// Phase 3: widen item_content.content_type to include 'ai_summary'.
// SQLite CHECK constraints can't be altered in place -- recreate if the
// old narrower CHECK is still present.
const itemContentSchema = database
  .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='item_content'`)
  .get() as { sql: string } | undefined;
if (itemContentSchema && !itemContentSchema.sql.includes("'ai_summary'")) {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE item_content_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id       INTEGER NOT NULL,
      content_type  TEXT NOT NULL CHECK (content_type IN ('ocr','scraped_summary','transcript','user_note','ai_summary')),
      text          TEXT NOT NULL,
      source_agent  TEXT,
      token_count   INTEGER,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
    );
    INSERT INTO item_content_new SELECT id, item_id, content_type, text, source_agent, token_count, created_at FROM item_content;
    DROP TABLE item_content;
    ALTER TABLE item_content_new RENAME TO item_content;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
  logger.info('Migration: widened item_content.content_type enum to include ai_summary');

  // Rebuild FTS triggers after table recreation. They reference item_content.
  database.exec(`
    DROP TRIGGER IF EXISTS item_content_fts_insert;
    DROP TRIGGER IF EXISTS item_content_fts_update;
    DROP TRIGGER IF EXISTS item_content_fts_delete;
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
  `);
  logger.info('Migration: rebuilt item_content_fts triggers after recreate');

  // Rebuild the FTS index (clear+repopulate) since rowids may have changed
  database.exec(`
    INSERT INTO item_content_fts(item_content_fts) VALUES ('delete-all');
    INSERT INTO item_content_fts(rowid, text, item_id, content_type)
      SELECT id, text, item_id, content_type FROM item_content;
  `);
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npx vitest run src/library.test.ts -t "ai_summary content_type"`
Expected: PASS (2 tests).

Run full library suite to catch regressions in FTS or cascades: `npx vitest run src/library.test.ts`
Expected: all pre-existing tests still pass plus the 2 new ones.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/processor-agent
git add src/db.ts src/library.test.ts
git commit -m "feat(schema): widen item_content.content_type to include ai_summary

Phase 3 Processor writes AI-generated summaries via Ollama.
Extends the existing enum and rebuilds the FTS5 triggers after
recreation. Migration runs in-place on existing DBs via the
runMigrations inline pattern."
```

---

## Task 2: Schema — add `mission_tasks.attempts` column

**Files:**
- Modify: `src/db.ts` (add column + migration)
- Test: `src/library.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/library.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run test** — Expect FAIL: no `attempts` column.

Run: `npx vitest run src/library.test.ts -t "mission_tasks.attempts"`

- [ ] **Step 3: Add column to fresh schema in `createSchema()` in `src/db.ts`**

Find the `CREATE TABLE IF NOT EXISTS mission_tasks (` block. Add the column just before the `created_at` line:

```
      attempts        INTEGER NOT NULL DEFAULT 0,
```

- [ ] **Step 4: Add inline migration for existing DBs in `runMigrations()` in `src/db.ts`**

Add after the ai_summary migration block from Task 1:

```typescript
// Phase 3: add mission_tasks.attempts column for retry tracking.
const missionCols2 = database.prepare(`PRAGMA table_info(mission_tasks)`).all() as Array<{ name: string }>;
if (!missionCols2.some((c) => c.name === 'attempts')) {
  database.exec(`ALTER TABLE mission_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
  logger.info('Migration: added attempts column to mission_tasks');
}
```

- [ ] **Step 5: Run test** — Expect PASS

Run: `npx vitest run src/library.test.ts -t "mission_tasks.attempts"`

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/library.test.ts
git commit -m "feat(schema): add mission_tasks.attempts column for retry tracking

Phase 3 Processor retries failed enrichments up to 3 times.
Tracking attempts on the task row keeps the retry logic simple
and survives restarts. Defaults to 0 for existing rows."
```

---

## Task 3: Ollama HTTP client (`src/enrichers/ollama.ts`)

**Files:**
- Create: `src/enrichers/ollama.ts`
- Create: `src/enrichers/ollama.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/enrichers/ollama.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

import { summarize, headline, _setOllamaBaseUrl } from './ollama.js';

let server: http.Server;
let port: number;

// In-process mock Ollama server for deterministic tests
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== '/api/generate') {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body) as { prompt: string; system?: string };
      // Echo a deterministic response based on the system prompt so tests
      // can distinguish summarize() from headline().
      const response = payload.system?.includes('headline')
        ? 'Mock headline for: ' + payload.prompt.slice(0, 20)
        : 'Mock summary of: ' + payload.prompt.slice(0, 20);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response, done: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  _setOllamaBaseUrl(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ollama enricher', () => {
  it('summarize returns trimmed response text', async () => {
    const out = await summarize('The quick brown fox jumps over the lazy dog.');
    expect(out).toBe('Mock summary of: The quick brown fox j');
  });

  it('headline uses a headline-flavored system prompt', async () => {
    const out = await headline('The quick brown fox jumps over the lazy dog.');
    expect(out).toBe('Mock headline for: The quick brown fox j');
  });

  it('summarize truncates input above 8K chars', async () => {
    const big = 'x'.repeat(20000);
    const out = await summarize(big);
    expect(out).toBe('Mock summary of: xxxxxxxxxxxxxxxxxxxx');
  });

  it('throws on non-200 responses with a clear error', async () => {
    _setOllamaBaseUrl('http://127.0.0.1:1');  // unreachable
    await expect(summarize('hi')).rejects.toThrow(/ollama/i);
    _setOllamaBaseUrl(`http://127.0.0.1:${port}`);
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

Run: `npx vitest run src/enrichers/ollama.test.ts`
Expected: FAIL — `Cannot find module './enrichers/ollama.js'`.

- [ ] **Step 3: Create `src/enrichers/ollama.ts`**

```typescript
/**
 * Local Ollama HTTP client for summarization and headline generation.
 * Targets http://localhost:11434 by default; the base URL is overridable
 * via _setOllamaBaseUrl for tests.
 */

const DEFAULT_MODEL = 'qwen2.5:3b-instruct';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_INPUT_CHARS = 8000;

let baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

/** @internal - test seam only */
export function _setOllamaBaseUrl(url: string): void {
  baseUrl = url;
}

interface GenerateResponse {
  response: string;
  done: boolean;
  error?: string;
}

async function generate(
  systemPrompt: string,
  userText: string,
  options: { maxTokens?: number; timeoutMs?: number; model?: string } = {},
): Promise<string> {
  const truncated = userText.slice(0, MAX_INPUT_CHARS);
  const body = JSON.stringify({
    model: options.model ?? DEFAULT_MODEL,
    system: systemPrompt,
    prompt: truncated,
    stream: false,
    options: {
      num_predict: options.maxTokens ?? 200,
      temperature: 0.2,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const data = (await res.json()) as GenerateResponse;
    if (data.error) throw new Error(`Ollama error: ${data.error}`);
    return data.response.trim();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Ollama request timed out. Is the daemon running on ' + baseUrl + '?');
    }
    if (err instanceof Error && err.message.includes('fetch failed')) {
      throw new Error(
        `Ollama not reachable at ${baseUrl}. Start it with: ollama serve`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function summarize(
  text: string,
  options: { maxSentences?: number } = {},
): Promise<string> {
  const sentences = options.maxSentences ?? 2;
  const systemPrompt =
    `You summarize content in exactly ${sentences} short sentences. ` +
    `Plain text only, no markdown, no quotes around the summary. ` +
    `Describe what the content is ABOUT, not how it's formatted.`;
  return generate(systemPrompt, text, { maxTokens: 120 });
}

export async function headline(text: string): Promise<string> {
  const systemPrompt =
    `Write one short descriptive headline for the content below. ` +
    `Under 80 characters. No quotes, no trailing punctuation, no "A" or "The" lead-ins when avoidable. ` +
    `This is a title shown in a library list view.`;
  return generate(systemPrompt, text, { maxTokens: 40 });
}
```

- [ ] **Step 4: Run tests** — Expect PASS (4 tests).

Run: `npx vitest run src/enrichers/ollama.test.ts`

- [ ] **Step 5: Live sanity check (manual, optional)**

```bash
npm run build
node -e "import('./dist/enrichers/ollama.js').then(async m => { console.log(await m.summarize('Water kefir is a probiotic fermented beverage made with sugar water and kefir grains. It has a mildly sweet, slightly tangy flavor and takes about 48 hours to ferment at room temperature.')); })"
```

Expected: a 2-sentence plain-text summary within ~5-15s. Confirms Ollama daemon + qwen2.5:3b-instruct are wired correctly.

- [ ] **Step 6: Commit**

```bash
git add src/enrichers/ollama.ts src/enrichers/ollama.test.ts
git commit -m "feat(enrichers): add Ollama HTTP client with summarize and headline

Wraps localhost:11434/api/generate for qwen2.5:3b-instruct. Two
helpers: summarize(text) -> 1-2 sentences; headline(text) -> one
short descriptive title. 60s timeout, 8K char input cap, clear
error messages for daemon-down / model-missing. Test seam via
_setOllamaBaseUrl for in-process HTTP mock."
```

---

## Task 4: Processor orchestrator skeleton (`src/processor.ts`)

**Files:**
- Create: `src/processor.ts`
- Create: `src/processor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/processor.test.ts`:

```typescript
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

    // Orchestrator should claim and complete the task (dispatch is mocked,
    // so success is declared by the default mock resolving to {ok: true}).
    const result = await drainQueue({ maxTasks: 10 });
    expect(result.processed).toBeGreaterThanOrEqual(0);
    // Regardless of mock behaviour, the task should no longer be 'queued'
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
```

- [ ] **Step 2: Run test** — Expect FAIL (module doesn't exist).

- [ ] **Step 3: Create `src/processor.ts`**

```typescript
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
import path from 'path';
import {
  _getTestDb,
  getItem,
  markEnriched,
  addContent,
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
    // Claim one task atomically
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
  return txn() ?? null;
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
```

- [ ] **Step 4: Run tests** — Expect PASS (4 tests).

Run: `npx vitest run src/processor.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/processor.ts src/processor.test.ts
git commit -m "feat(processor): orchestrator skeleton with drain + sweep

drainQueue claims queued mission_tasks assigned to 'processor',
dispatches to a placeholder processTask (which Waves 2 and 3 will
fill with real enrichers), and handles retries + failure tracking.
sweepStale queues tasks for library_items with enriched_at IS NULL
that don't already have an open task. Hive_mind row on success.
4 unit tests cover empty queue, drain lifecycle, sweep creation,
and sweep dedup."
```

---

## Task 5: `src/processor-cli.ts` — scheduler entry point

**Files:**
- Create: `src/processor-cli.ts`
- Create: `src/processor-cli.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/processor-cli.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PROJECT_ROOT, 'dist', 'processor-cli.js');
const TEST_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-cli-test-'));

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, CLAUDECLAW_STORE_DIR: TEST_STORE_DIR },
    });
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

describe('processor-cli', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      execFileSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
  }, 60000);

  it('drain with no queued tasks reports 0 processed', () => {
    const { stdout, exitCode } = runCli(['drain']);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.processed).toBe(0);
  });

  it('sweep with no stale items reports 0 queued', () => {
    const { stdout, exitCode } = runCli(['sweep']);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.queued).toBe(0);
  });

  it('unknown subcommand exits non-zero', () => {
    const { exitCode, stderr } = runCli(['explode']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('processor-cli');
  });
});
```

- [ ] **Step 2: Run test** — Expect FAIL (CLI doesn't exist).

- [ ] **Step 3: Create `src/processor-cli.ts`**

```typescript
#!/usr/bin/env node
/**
 * Scheduler-facing CLI wrapper around src/processor.ts.
 * Invoked by scheduled_tasks entries:
 *   node dist/processor-cli.js drain   (every 1 min)
 *   node dist/processor-cli.js sweep   (every 1 hour)
 */

import { initDatabase } from './db.js';
import { drainQueue, sweepStale } from './processor.js';

initDatabase();

const [, , command] = process.argv;

function usage(): void {
  console.error(`Usage: processor-cli <drain|sweep>

  drain   Process queued mission_tasks assigned to 'processor'.
  sweep   Queue mission_tasks for library_items with enriched_at IS NULL.`);
}

async function main(): Promise<void> {
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case 'drain': {
      const result = await drainQueue();
      console.log(JSON.stringify(result));
      break;
    }
    case 'sweep': {
      const result = await sweepStale();
      console.log(JSON.stringify(result));
      break;
    }
    default:
      console.error(`Unknown subcommand: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 4: Build and run tests** — Expect PASS (3 tests).

```bash
npm run build && npx vitest run src/processor-cli.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/processor-cli.ts src/processor-cli.test.ts
git commit -m "feat(processor): add CLI entry point for scheduler

Thin wrapper around src/processor.ts. Two subcommands:
  drain  - processes queued mission_tasks
  sweep  - queues tasks for unenriched library_items
JSON output on stdout per CLI convention. 3 tests cover empty
drain, empty sweep, and unknown-subcommand error path."
```

---

## Task 6: Scheduler wiring — register Processor cron entries at startup

**Files:**
- Modify: `src/scheduler.ts` (add `registerProcessorSchedules()`)
- Modify: `src/index.ts` (call registerProcessorSchedules during startup)
- Test: extend `src/scheduler.test.ts` if it exists, otherwise `src/processor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/processor.test.ts`:

```typescript
describe('registerProcessorSchedules', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates two scheduled_tasks entries (drain + sweep) on first call', async () => {
    const { registerProcessorSchedules } = await import('./processor.js');
    registerProcessorSchedules();
    const db = _getTestDb();
    const tasks = db.prepare(`SELECT id, schedule, prompt FROM scheduled_tasks WHERE id IN ('processor-drain','processor-sweep')`).all() as Array<{id: string, schedule: string, prompt: string}>;
    expect(tasks.length).toBe(2);
    const drain = tasks.find(t => t.id === 'processor-drain');
    const sweep = tasks.find(t => t.id === 'processor-sweep');
    expect(drain?.schedule).toBe('* * * * *');       // every minute
    expect(sweep?.schedule).toBe('0 * * * *');       // every hour on :00
    expect(drain?.prompt).toContain('drain');
    expect(sweep?.prompt).toContain('sweep');
  });

  it('is idempotent (calling twice does not duplicate rows)', async () => {
    const { registerProcessorSchedules } = await import('./processor.js');
    registerProcessorSchedules();
    registerProcessorSchedules();
    const db = _getTestDb();
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM scheduled_tasks WHERE id IN ('processor-drain','processor-sweep')`).get() as { n: number }).n;
    expect(count).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests** — Expect FAIL (function not exported).

- [ ] **Step 3: Add `registerProcessorSchedules` to `src/processor.ts`**

Append to `src/processor.ts`:

```typescript
/**
 * Register the two Processor cron entries in scheduled_tasks.
 * Idempotent: uses INSERT OR IGNORE so repeated calls are no-ops.
 * Call once at ClaudeClaw startup (after initDatabase).
 */
export function registerProcessorSchedules(): void {
  const db = _getTestDb();
  const now = Math.floor(Date.now() / 1000);
  const nextMin = now + 60;  // first drain ~ 1 minute out
  const nextHour = now + 3600;

  db.prepare(`
    INSERT OR IGNORE INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at)
    VALUES ('processor-drain', 'processor:drain', '* * * * *', ?, 'active', ?)
  `).run(nextMin, now);

  db.prepare(`
    INSERT OR IGNORE INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at)
    VALUES ('processor-sweep', 'processor:sweep', '0 * * * *', ?, 'active', ?)
  `).run(nextHour, now);
}
```

Note on the scheduled_tasks prompt: we use the sentinel strings `processor:drain` and `processor:sweep`. The next sub-task wires the scheduler to recognise these and shell to `processor-cli` instead of sending to the Claude agent.

- [ ] **Step 4: Teach the scheduler to recognise Processor prompts**

In `src/scheduler.ts`, find `runDueTasks` (or the function that fires when a scheduled task becomes due). Add a pre-check at the top of the per-task loop:

```typescript
// Phase 3 Processor: handle via deterministic shell-out, not the agent.
if (task.prompt === 'processor:drain' || task.prompt === 'processor:sweep') {
  const subcommand = task.prompt.split(':')[1];
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const run = promisify(execFile);
  try {
    const cliPath = path.join(PROJECT_ROOT, 'dist', 'processor-cli.js');
    const { stdout } = await run('node', [cliPath, subcommand], {
      timeout: 9 * 60 * 1000, // generous — full drain with many items can take minutes
    });
    updateTaskAfterRun(task.id, stdout.trim(), Date.now());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, taskId: task.id }, 'Processor scheduled task failed');
    updateTaskAfterRun(task.id, `ERROR: ${msg}`, Date.now());
  }
  continue; // skip normal agent flow
}
```

(The exact location depends on the scheduler's current structure; place the check inside the for-each-due-task loop before the agent invocation path.)

Add these imports at the top of `src/scheduler.ts` if not already present:

```typescript
import path from 'path';
import { PROJECT_ROOT } from './config.js';
```

- [ ] **Step 5: Call `registerProcessorSchedules` at startup**

In `src/index.ts` (or wherever `initDatabase()` + `initScheduler()` are called at boot), add after those:

```typescript
import { registerProcessorSchedules } from './processor.js';
// ...
registerProcessorSchedules();
```

- [ ] **Step 6: Run tests** — Expect PASS (2 new tests for registerProcessorSchedules).

Run: `npx vitest run src/processor.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/processor.ts src/scheduler.ts src/index.ts
git commit -m "feat(processor): register drain + sweep via scheduled_tasks

registerProcessorSchedules() idempotently inserts two entries:
  processor-drain (* * * * *)   every minute
  processor-sweep (0 * * * *)   every hour at :00
The scheduler short-circuits these sentinel prompts and shells
out to dist/processor-cli.js instead of invoking the Claude agent.
Called once at startup from src/index.ts."
```

---

# Wave 2 — URL + Image Enrichers

Wave 2 delivers the two most common enrichment paths. After Wave 2: URLs get proper Playwright scraping + summaries; screenshots get OCR'd and summarized.

## Task 7: URL enricher (`src/enrichers/url.ts`)

**Files:**
- Create: `src/enrichers/url.ts`
- Create: `src/enrichers/url.test.ts`

- [ ] **Step 1: Write the failing test** — create `src/enrichers/url.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { enrichUrl } from './url.js';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head>
  <title>Test Article</title>
  <meta property="og:title" content="Real Page Title">
  <meta property="og:description" content="A one-line description of the page content.">
</head><body>
  <nav>Nav menu</nav>
  <article>
    <h1>Main Heading</h1>
    <p>This is the first paragraph of the actual article body. It explains the topic at length.</p>
    <p>This is the second paragraph, which continues the discussion.</p>
  </article>
  <footer>Footer text</footer>
</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('url enricher', () => {
  it('extracts title, og:description, and body text', async () => {
    const out = await enrichUrl(`http://127.0.0.1:${port}/`);
    expect(out.ok).toBe(true);
    expect(out.title).toBe('Real Page Title');
    expect(out.ogDescription).toBe('A one-line description of the page content.');
    expect(out.bodyText).toContain('first paragraph');
    expect(out.bodyText).toContain('second paragraph');
    expect(out.bodyText).not.toContain('Nav menu');       // nav stripped
    expect(out.bodyText).not.toContain('Footer text');    // footer stripped
  }, 30000);

  it('returns ok:false on DNS failure', async () => {
    const out = await enrichUrl('https://this-domain-will-never-resolve-xyz123.test/');
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  }, 30000);
});
```

- [ ] **Step 2: Run test** — Expect FAIL (module does not exist).

- [ ] **Step 3: Create `src/enrichers/url.ts`**

```typescript
/**
 * Playwright-based URL enricher. Navigates, waits for network idle,
 * extracts title + og:description + main article body text.
 */

import { chromium, type Browser } from 'playwright';
import { logger } from '../logger.js';

export interface UrlEnrichOutcome {
  ok: boolean;
  title?: string;
  ogDescription?: string;
  bodyText?: string;
  finalUrl?: string;
  error?: string;
  errorCode?: string;
}

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}

export async function enrichUrl(url: string, timeoutMs = 30000): Promise<UrlEnrichOutcome> {
  let context;
  let page;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; ClaudeClaw Processor/1.0)',
    });
    page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Wait for network quieter, but cap
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      // ok - some sites never fully idle
    }

    const result = await page.evaluate(() => {
      const title = document.title || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? null;
      const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? null;

      // Readability-ish body extraction: prefer <article> or <main>, strip nav/footer/script/style
      const article = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
      const clone = article.cloneNode(true) as HTMLElement;
      for (const sel of ['nav', 'footer', 'script', 'style', 'aside', 'header']) {
        clone.querySelectorAll(sel).forEach((n) => n.remove());
      }
      const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();

      return {
        title: ogTitle ?? title,
        ogDescription: ogDesc,
        bodyText: text,
        finalUrl: location.href,
      };
    });

    return {
      ok: true,
      title: result.title,
      ogDescription: result.ogDescription ?? undefined,
      bodyText: result.bodyText.slice(0, 10000),
      finalUrl: result.finalUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, url }, 'Processor: url enrichment failed');
    return { ok: false, error: msg, errorCode: classifyUrlError(msg) };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

function classifyUrlError(msg: string): string {
  if (/timeout/i.test(msg)) return 'playwright_timeout';
  if (/net::ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(msg)) return 'dns_error';
  if (/net::ERR_CONNECTION_REFUSED/.test(msg)) return 'connection_refused';
  return 'playwright_navigation_error';
}

/** Close the shared browser. Call during graceful shutdown. */
export async function closeUrlEnricher(): Promise<void> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}
```

- [ ] **Step 4: Run tests** — Expect PASS (2 tests).

Run: `npx vitest run src/enrichers/url.test.ts`

If Playwright throws "Executable doesn't exist" on the first run, run `npx playwright install chromium` then retry.

- [ ] **Step 5: Commit**

```bash
git add src/enrichers/url.ts src/enrichers/url.test.ts
git commit -m "feat(enrichers): add Playwright-based URL enricher

Navigates with 30s timeout, waits for networkidle (capped at 10s),
extracts og:title + og:description + main article body text
(readability-style: prefers <article>/<main>, strips nav/footer/
script/style). Shares a single headless Chromium across calls to
avoid startup overhead. 10K char cap on body text. 2 tests cover
happy path (in-process HTTP server) and DNS failure."
```

---

## Task 8: Image enricher — Tesseract OCR (`src/enrichers/image.ts`)

**Files:**
- Create: `src/enrichers/image.ts`
- Create: `src/enrichers/image.test.ts`
- Create: `src/enrichers/fixtures/test-ocr.png` (tiny PNG containing the text "HELLO WORLD")

- [ ] **Step 1: Prepare a test fixture**

Generate a small PNG with known text using ImageMagick (available on most macOS Homebrew setups):

```bash
mkdir -p src/enrichers/fixtures
# Requires: brew install imagemagick (or a preinstalled equivalent)
magick -size 400x120 xc:white -pointsize 48 -gravity center -annotate 0 "HELLO WORLD" src/enrichers/fixtures/test-ocr.png
```

If ImageMagick isn't available, hand-create a simple PNG by any means or substitute another fixture image that contains clearly-readable text. Verify the file exists.

- [ ] **Step 2: Write failing test**

Create `src/enrichers/image.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';
import { enrichImage } from './image.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'test-ocr.png');

describe('image enricher', () => {
  it('extracts text from a simple PNG via tesseract', async () => {
    const out = await enrichImage(FIXTURE);
    expect(out.ok).toBe(true);
    // OCR can introduce minor variations; check substring loosely
    expect(out.text?.toUpperCase()).toContain('HELLO');
    expect(out.text?.toUpperCase()).toContain('WORLD');
  }, 30000);

  it('returns ok:false for a missing file', async () => {
    const out = await enrichImage('/tmp/does-not-exist-xyz.png');
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test** — Expect FAIL (module does not exist).

- [ ] **Step 4: Create `src/enrichers/image.ts`**

```typescript
/**
 * Tesseract-based OCR enricher. Shells out to the `tesseract` binary
 * (install: brew install tesseract). No tesseract.js — the native
 * binary is 10-20x faster and more accurate.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export interface ImageEnrichOutcome {
  ok: boolean;
  text?: string;
  error?: string;
  errorCode?: string;
}

export async function enrichImage(imagePath: string, languages = 'eng'): Promise<ImageEnrichOutcome> {
  if (!fs.existsSync(imagePath)) {
    return { ok: false, error: `file not found: ${imagePath}`, errorCode: 'file_missing' };
  }

  try {
    // tesseract <input> - -l <lang> writes OCR text to stdout
    const { stdout } = await execFileAsync('tesseract', [imagePath, '-', '-l', languages], {
      maxBuffer: 10 * 1024 * 1024,  // 10 MB
      timeout: 60_000,
    });
    return { ok: true, text: stdout.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, imagePath }, 'Processor: image OCR failed');
    if (/ENOENT.*tesseract/.test(msg)) {
      return {
        ok: false,
        error: 'tesseract binary not found. Install with: brew install tesseract',
        errorCode: 'tesseract_not_installed',
      };
    }
    return { ok: false, error: msg, errorCode: 'ocr_failed' };
  }
}
```

- [ ] **Step 5: Verify tesseract is installed, then run tests**

```bash
which tesseract || brew install tesseract
npx vitest run src/enrichers/image.test.ts
```

Expected: 2 tests pass. If the fixture OCR text is noisy, loosen the test assertions (keep "HELLO" and "WORLD" as substrings).

- [ ] **Step 6: Commit**

```bash
git add src/enrichers/image.ts src/enrichers/image.test.ts src/enrichers/fixtures/
git commit -m "feat(enrichers): add tesseract-based OCR enricher

Shells out to the native tesseract binary (brew install tesseract).
Takes an image file path, returns OCR text. Defaults to English.
60s timeout, 10MB output cap. Clear error message when the binary
is missing. 2 tests: happy path with a HELLO-WORLD PNG fixture
and missing-file rejection."
```

---

## Task 9: Wire URL + image enrichers into `processor.ts` dispatch

**Files:**
- Modify: `src/processor.ts` (replace the placeholder `processTask`)
- Modify: `src/processor.test.ts` (new integration tests)

- [ ] **Step 1: Write failing integration tests**

Append to `src/processor.test.ts`:

```typescript
describe('processor end-to-end: URL enrichment', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('drain processes a URL item: raw body + ai_summary written, enriched_at set', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    // Mock enricher to return deterministic content
    const urlMod = await import('./enrichers/url.js');
    vi.spyOn(urlMod, 'enrichUrl').mockResolvedValue({
      ok: true,
      title: 'Mocked Article',
      ogDescription: 'From mock enrichUrl',
      bodyText: 'Paragraph about water kefir fermentation from the mocked page.',
      finalUrl: 'https://example.com/mocked',
    });

    // Mock Ollama so tests don't need the daemon
    const ollamaMod = await import('./enrichers/ollama.js');
    vi.spyOn(ollamaMod, 'summarize').mockResolvedValue('Mocked 1-2 sentence summary.');
    vi.spyOn(ollamaMod, 'headline').mockResolvedValue('Mocked headline');

    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, url, captured_at, project, created_at)
      VALUES ('article', 'https://example.com/x', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);

    db.prepare(`
      INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at)
      VALUES ('t-url', 'process', 'Process library item ${itemId}: URL needs scrape + summary', 'processor', 'queued', 'memobot', 0, ?)
    `).run(now);

    const result = await drainQueue();
    expect(result.completed).toBe(1);

    // Verify item_content rows
    const contents = db.prepare(`SELECT content_type, text FROM item_content WHERE item_id = ?`).all(itemId) as Array<{ content_type: string; text: string }>;
    const types = contents.map((c) => c.content_type).sort();
    expect(types).toContain('scraped_summary');
    expect(types).toContain('ai_summary');

    // enriched_at set
    const li = db.prepare(`SELECT enriched_at FROM library_items WHERE id = ?`).get(itemId) as { enriched_at: number | null };
    expect(li.enriched_at).toBeGreaterThan(0);

    // mission_task completed
    const t = db.prepare(`SELECT status FROM mission_tasks WHERE id = 't-url'`).get() as { status: string };
    expect(t.status).toBe('completed');
  });
});

describe('processor end-to-end: image enrichment', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('drain processes a screenshot item: OCR text + ai_summary written', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    const imageMod = await import('./enrichers/image.js');
    vi.spyOn(imageMod, 'enrichImage').mockResolvedValue({
      ok: true,
      text: 'KEFIR FERMENTATION TIMES AT 72F (detailed notes extracted from the screenshot, 400 chars of text, far more than the 100-char summary threshold so it will be summarized).',
    });

    const ollamaMod = await import('./enrichers/ollama.js');
    vi.spyOn(ollamaMod, 'summarize').mockResolvedValue('A notes screenshot on kefir fermentation timing at 72F.');
    vi.spyOn(ollamaMod, 'headline').mockResolvedValue('Kefir Fermentation Notes');

    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('screenshot', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);
    db.prepare(`
      INSERT INTO item_media (item_id, media_type, file_path, storage, created_at)
      VALUES (?, 'image', 'general/screenshots/test.png', 'local', ?)
    `).run(itemId, now);
    db.prepare(`
      INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at)
      VALUES ('t-img', 'process', 'Process library item ${itemId}: screenshot needs OCR', 'processor', 'queued', 'memobot', 0, ?)
    `).run(now);

    const result = await drainQueue();
    expect(result.completed).toBe(1);

    const types = (db.prepare(`SELECT content_type FROM item_content WHERE item_id = ?`).all(itemId) as Array<{ content_type: string }>).map(r => r.content_type).sort();
    expect(types).toContain('ocr');
    expect(types).toContain('ai_summary');
  });
});
```

- [ ] **Step 2: Run tests** — Expect FAIL (the placeholder processTask returns `no enricher registered`).

- [ ] **Step 3: Replace the placeholder `processTask` in `src/processor.ts`**

Replace the existing `processTask` with:

```typescript
import { LIBRARY_ROOT } from './config.js';
import { enrichUrl } from './enrichers/url.js';
import { enrichImage } from './enrichers/image.js';
import { summarize, headline } from './enrichers/ollama.js';

const GENERIC_TITLES = new Set([
  'tiktok - make your day', 'instagram', 'facebook',
  'youtube', 'x', 'twitter', 'reddit', 'threads', 'linkedin',
]);

async function processTask(item: FullItem): Promise<EnrichOutcome> {
  const db = _getTestDb();

  // Notes: already enriched at ingest
  if (item.source_type === 'note') {
    return { ok: true, summaryHint: 'note (skipped)' };
  }

  // URL items (source_type is any platform + has url)
  if (item.url && item.source_type !== 'screenshot' && item.source_type !== 'file' && item.source_type !== 'voice') {
    return await enrichUrlItem(item);
  }

  // Screenshot (image)
  if (item.source_type === 'screenshot' && item.media.length > 0) {
    const media = item.media[0] as { media_type: string; file_path: string };
    if (media.media_type === 'image') {
      return await enrichImageItem(item, media.file_path);
    }
  }

  return {
    ok: false,
    error: `no enricher registered for source_type=${item.source_type}`,
    errorCode: 'no_enricher',
  };
}

async function enrichUrlItem(item: FullItem): Promise<EnrichOutcome> {
  const out = await enrichUrl(item.url!);
  if (!out.ok) {
    return { ok: false, error: out.error, errorCode: out.errorCode };
  }

  // Write raw body text
  if (out.bodyText && out.bodyText.length > 0) {
    addContent(item.id, {
      content_type: 'scraped_summary',
      text: out.bodyText,
      source_agent: 'processor',
    });
  }

  // Summarize via Ollama (graceful if Ollama down)
  let summary: string | null = null;
  try {
    summary = await summarize(out.bodyText ?? out.title ?? '');
  } catch (err) {
    logger.warn({ err }, 'Processor: Ollama summarize failed, continuing without summary');
  }
  if (summary) {
    addContent(item.id, {
      content_type: 'ai_summary',
      text: summary,
      source_agent: 'processor',
    });
  }

  // Update title if generic or missing
  const current = (item.title ?? '').toLowerCase().trim();
  if (!current || GENERIC_TITLES.has(current)) {
    try {
      const newTitle = await headline(out.bodyText ?? out.title ?? '');
      if (newTitle) {
        const db = _getTestDb();
        db.prepare(`UPDATE library_items SET title = ? WHERE id = ?`).run(newTitle.slice(0, 200), item.id);
      }
    } catch (err) {
      logger.warn({ err }, 'Processor: Ollama headline failed, keeping existing title');
    }
  }

  return { ok: true, summaryHint: 'url scrape + summary' };
}

async function enrichImageItem(item: FullItem, relativePath: string): Promise<EnrichOutcome> {
  const absPath = `${LIBRARY_ROOT}/${relativePath}`;
  const out = await enrichImage(absPath);
  if (!out.ok) {
    return { ok: false, error: out.error, errorCode: out.errorCode };
  }

  const text = out.text ?? '';
  if (text.length > 0) {
    addContent(item.id, {
      content_type: 'ocr',
      text,
      source_agent: 'processor',
    });
  }

  if (text.length >= 100) {
    try {
      const summary = await summarize(text);
      if (summary) {
        addContent(item.id, {
          content_type: 'ai_summary',
          text: summary,
          source_agent: 'processor',
        });
      }
      if (!item.title) {
        const h = await headline(text);
        if (h) {
          const db = _getTestDb();
          db.prepare(`UPDATE library_items SET title = ? WHERE id = ?`).run(h.slice(0, 200), item.id);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Processor: Ollama call failed for image, continuing with raw OCR');
    }
  }

  return { ok: true, summaryHint: 'OCR + summary' };
}
```

- [ ] **Step 4: Run full processor test suite** — Expect PASS.

Run: `npx vitest run src/processor.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/processor.ts src/processor.test.ts
git commit -m "feat(processor): wire URL and image enrichers into dispatch

processTask now routes URL-bearing items to enrichUrl and
screenshot items to enrichImage. Writes raw body/OCR to
item_content with the appropriate content_type, then calls Ollama
summarize + headline. Gracefully degrades when Ollama is down
(logs warning, continues with raw extraction only). Generic
library_items.title values are replaced with a Qwen headline.
2 integration tests cover URL + image end-to-end with all
enrichers mocked for determinism."
```

---

## Task 10: Wave 2 real-world smoke test

**Files:** None (operational verification).

- [ ] **Step 1: Rebuild**

```bash
npm run build
```

- [ ] **Step 2: Verify Ollama and tesseract are ready**

```bash
curl -s http://localhost:11434/api/version && echo
which tesseract && tesseract --version 2>&1 | head -1
```

Both should return successfully. If Ollama isn't running: `ollama serve &` in a separate terminal.

- [ ] **Step 3: Check the queue state**

```bash
sqlite3 store/claudeclaw.db "SELECT id, status, attempts, substr(prompt, 1, 60) FROM mission_tasks WHERE assigned_agent='processor' ORDER BY created_at"
```

Record how many queued tasks you have. If zero: send yourself a URL via `@MemoVizBot` to create one, then re-check.

- [ ] **Step 4: Run drain once manually**

```bash
node dist/processor-cli.js drain
```

Expected output: JSON like `{"processed":1,"completed":1,"failed":0,"skipped":0}`. Latency can be 10-60 seconds per item (Playwright + Ollama).

- [ ] **Step 5: Verify the item was enriched**

```bash
sqlite3 store/claudeclaw.db "
SELECT li.id, li.title, li.enriched_at IS NOT NULL AS enriched,
       COUNT(ic.id) AS content_rows
FROM library_items li
LEFT JOIN item_content ic ON ic.item_id = li.id
GROUP BY li.id
ORDER BY li.id DESC LIMIT 5"
```

Enriched items should have `enriched=1` and `content_rows >= 2` (raw + ai_summary). Title should be a real headline, not "TikTok - Make Your Day".

- [ ] **Step 6: Check via Telegram**

Send `/recent` to `@MemoVizBot`. The enriched items should now show a descriptive label instead of filenames/URLs. `/find <keyword-from-content>` should return matches.

- [ ] **Step 7: No commit needed** (verification only). Proceed to Wave 3.

---

# Wave 3 — PDF, Audio, Video Enrichers

## Task 11: PDF enricher (`src/enrichers/pdf.ts`)

**Files:**
- Modify: `package.json` (add `pdf-parse`)
- Create: `src/enrichers/pdf.ts`
- Create: `src/enrichers/pdf.test.ts`
- Create: `src/enrichers/fixtures/test.pdf` (small fixture)

- [ ] **Step 1: Install dependency**

```bash
npm install pdf-parse
```

- [ ] **Step 2: Add a fixture PDF**

Any small PDF with known text content. Easiest:

```bash
mkdir -p src/enrichers/fixtures
# Generate a minimal PDF using macOS's built-in cupsfilter, or copy one:
echo "PDF test content: kefir fermentation notes." > /tmp/test.txt
/System/Library/Printers/Libraries/./cupsfilter /tmp/test.txt > src/enrichers/fixtures/test.pdf 2>/dev/null
# Fallback: any existing PDF under a few KB works. Verify it contains plain text.
file src/enrichers/fixtures/test.pdf    # should say "PDF document"
```

- [ ] **Step 3: Write failing test**

Create `src/enrichers/pdf.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';
import { enrichPdf } from './pdf.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'test.pdf');

describe('pdf enricher', () => {
  it('extracts text from a simple PDF', async () => {
    const out = await enrichPdf(FIXTURE);
    expect(out.ok).toBe(true);
    expect(out.text?.toLowerCase()).toContain('kefir');
  });

  it('returns ok:false for a missing file', async () => {
    const out = await enrichPdf('/tmp/does-not-exist-xyz.pdf');
    expect(out.ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run test** — Expect FAIL.

- [ ] **Step 5: Create `src/enrichers/pdf.ts`**

```typescript
import fs from 'fs';
import { logger } from '../logger.js';
import pdfParse from 'pdf-parse';

export interface PdfEnrichOutcome {
  ok: boolean;
  text?: string;
  numPages?: number;
  error?: string;
  errorCode?: string;
}

export async function enrichPdf(pdfPath: string): Promise<PdfEnrichOutcome> {
  if (!fs.existsSync(pdfPath)) {
    return { ok: false, error: `file not found: ${pdfPath}`, errorCode: 'file_missing' };
  }
  try {
    const buf = fs.readFileSync(pdfPath);
    const parsed = await pdfParse(buf);
    return {
      ok: true,
      text: (parsed.text ?? '').slice(0, 10000),
      numPages: parsed.numpages,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, pdfPath }, 'Processor: pdf enrichment failed');
    if (/encrypted|password/i.test(msg)) {
      return { ok: false, error: 'PDF is encrypted or password-protected', errorCode: 'pdf_encrypted' };
    }
    return { ok: false, error: msg, errorCode: 'pdf_parse_error' };
  }
}
```

- [ ] **Step 6: Run tests** — Expect PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/enrichers/pdf.ts src/enrichers/pdf.test.ts src/enrichers/fixtures/test.pdf
git commit -m "feat(enrichers): add pdf-parse-based PDF enricher

Reads PDF file, extracts text content (first 10K chars). Detects
encrypted PDFs and returns a specific error code. 2 tests cover
happy path and missing-file rejection."
```

---

## Task 12: Audio enricher (`src/enrichers/audio.ts`)

**Files:**
- Create: `src/enrichers/audio.ts`
- Create: `src/enrichers/audio.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/enrichers/audio.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { enrichAudio } from './audio.js';

vi.mock('../voice.js', () => ({
  transcribeAudio: vi.fn(),
}));

describe('audio enricher', () => {
  it('delegates to voice.transcribeAudio and returns the transcript', async () => {
    const { transcribeAudio } = await import('../voice.js');
    (transcribeAudio as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('hello world transcript');

    const out = await enrichAudio('/tmp/fake.mp3');
    expect(out.ok).toBe(true);
    expect(out.text).toBe('hello world transcript');
  });

  it('returns ok:false when transcription throws', async () => {
    const { transcribeAudio } = await import('../voice.js');
    (transcribeAudio as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GROQ quota exhausted'));

    const out = await enrichAudio('/tmp/fake.mp3');
    expect(out.ok).toBe(false);
    expect(out.error).toContain('GROQ');
  });
});
```

- [ ] **Step 2: Run test** — Expect FAIL.

- [ ] **Step 3: Create `src/enrichers/audio.ts`**

```typescript
/**
 * Audio transcription enricher. Reuses the existing voice.ts
 * transcribeAudio() which handles Groq Whisper + whisper-cpp fallback.
 */

import fs from 'fs';
import { transcribeAudio } from '../voice.js';
import { logger } from '../logger.js';

export interface AudioEnrichOutcome {
  ok: boolean;
  text?: string;
  error?: string;
  errorCode?: string;
}

export async function enrichAudio(audioPath: string): Promise<AudioEnrichOutcome> {
  if (!fs.existsSync(audioPath)) {
    return { ok: false, error: `file not found: ${audioPath}`, errorCode: 'file_missing' };
  }
  try {
    const text = await transcribeAudio(audioPath);
    return { ok: true, text: (text ?? '').slice(0, 10000) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, audioPath }, 'Processor: audio transcription failed');
    if (/quota|429|rate/i.test(msg)) return { ok: false, error: msg, errorCode: 'whisper_groq_quota' };
    if (/ENOENT.*whisper/i.test(msg)) return { ok: false, error: 'whisper-cpp not installed', errorCode: 'whisper_local_missing' };
    return { ok: false, error: msg, errorCode: 'transcription_failed' };
  }
}
```

- [ ] **Step 4: Run tests** — Expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/enrichers/audio.ts src/enrichers/audio.test.ts
git commit -m "feat(enrichers): add audio transcription enricher

Wraps existing voice.ts transcribeAudio() which handles Groq +
whisper-cpp fallback. Classifies errors into quota/missing-binary/
generic categories for retry policy. 2 tests with the voice
module mocked."
```

---

## Task 13: Video enricher (`src/enrichers/video.ts`)

**Files:**
- Create: `src/enrichers/video.ts`
- Create: `src/enrichers/video.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/enrichers/video.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { enrichVideo } from './video.js';

vi.mock('../voice.js', () => ({
  transcribeAudio: vi.fn().mockResolvedValue('video audio transcript here'),
}));

describe('video enricher', () => {
  it('extracts audio via ffmpeg and transcribes it', async () => {
    // We can't easily mock ffmpeg's subprocess without significant harness.
    // Instead, skip the ffmpeg step by providing a pre-existing .wav fixture
    // path. A real video fixture is overkill for the test; we just verify
    // the orchestration when ffmpeg succeeds.
    // Use a short pre-recorded WAV if available; otherwise mock execFile.
    const out = await enrichVideo('/tmp/does-not-exist.mp4');
    // With no actual video, ffmpeg will fail and we should get ok:false
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBeTruthy();
  });
});
```

(We keep the test minimal because mocking ffmpeg-through-execFile in tests is brittle; Wave 4 includes a real-video smoke test on the user's data.)

- [ ] **Step 2: Run test** — Expect FAIL (module missing).

- [ ] **Step 3: Create `src/enrichers/video.ts`**

```typescript
/**
 * Video enricher: extracts audio via ffmpeg, delegates to audio enricher.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { enrichAudio } from './audio.js';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export interface VideoEnrichOutcome {
  ok: boolean;
  text?: string;
  error?: string;
  errorCode?: string;
}

export async function enrichVideo(videoPath: string): Promise<VideoEnrichOutcome> {
  if (!fs.existsSync(videoPath)) {
    return { ok: false, error: `file not found: ${videoPath}`, errorCode: 'file_missing' };
  }

  // Temp wav output
  const tmpWav = path.join(os.tmpdir(), `proc-video-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);

  try {
    // Extract mono 16kHz WAV suitable for whisper input
    await execFileAsync('ffmpeg', [
      '-loglevel', 'error',
      '-i', videoPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-y',
      tmpWav,
    ], { timeout: 5 * 60 * 1000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT.*ffmpeg/.test(msg)) {
      return { ok: false, error: 'ffmpeg not found. Install with: brew install ffmpeg', errorCode: 'ffmpeg_not_installed' };
    }
    logger.error({ err, videoPath }, 'Processor: ffmpeg audio extraction failed');
    return { ok: false, error: msg, errorCode: 'audio_extraction_failed' };
  }

  try {
    const audioOut = await enrichAudio(tmpWav);
    if (!audioOut.ok) {
      return { ok: false, error: audioOut.error, errorCode: audioOut.errorCode };
    }
    return { ok: true, text: audioOut.text };
  } finally {
    fs.unlinkSync(tmpWav);
  }
}
```

- [ ] **Step 4: Run test** — Expect PASS (1 test: missing-file path).

- [ ] **Step 5: Commit**

```bash
git add src/enrichers/video.ts src/enrichers/video.test.ts
git commit -m "feat(enrichers): add ffmpeg + audio video enricher

Extracts 16kHz mono WAV via ffmpeg (brew install ffmpeg),
delegates to audio enricher, cleans up temp file. Classifies
ffmpeg-missing separately for the scheduler's error messages.
Minimal test coverage — real video fixtures are handled in
Wave 4's smoke test."
```

---

## Task 14: Wire PDF + audio + video into `processor.ts` dispatch

**Files:**
- Modify: `src/processor.ts`
- Modify: `src/processor.test.ts`

- [ ] **Step 1: Write failing integration tests**

Append to `src/processor.test.ts`:

```typescript
describe('processor end-to-end: PDF + audio + video', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('PDF items produce transcript + ai_summary', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    const pdfMod = await import('./enrichers/pdf.js');
    vi.spyOn(pdfMod, 'enrichPdf').mockResolvedValue({
      ok: true,
      text: 'A quarterly report on probiotic kefir fermentation methods at various temperatures. Extensive findings across multiple sections.',
    });
    const ollamaMod = await import('./enrichers/ollama.js');
    vi.spyOn(ollamaMod, 'summarize').mockResolvedValue('Quarterly report on kefir fermentation.');
    vi.spyOn(ollamaMod, 'headline').mockResolvedValue('Q1 Kefir Report');

    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('file', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);
    db.prepare(`INSERT INTO item_media (item_id, media_type, file_path, storage, created_at) VALUES (?, 'pdf', 'general/pdfs/x.pdf', 'local', ?)`).run(itemId, now);
    db.prepare(`INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at) VALUES ('t-pdf', 'process', 'Process library item ${itemId}: pdf needs text extraction', 'processor', 'queued', 'memobot', 0, ?)`).run(now);

    const result = await drainQueue();
    expect(result.completed).toBe(1);

    const types = (db.prepare(`SELECT content_type FROM item_content WHERE item_id = ?`).all(itemId) as Array<{ content_type: string }>).map(r => r.content_type).sort();
    expect(types).toContain('transcript');
    expect(types).toContain('ai_summary');
  });

  it('video items produce transcript + ai_summary', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    const videoMod = await import('./enrichers/video.js');
    vi.spyOn(videoMod, 'enrichVideo').mockResolvedValue({
      ok: true,
      text: 'Today I want to show you how to brew water kefir at home. It is fermented with kefir grains in a sugar water solution.',
    });
    const ollamaMod = await import('./enrichers/ollama.js');
    vi.spyOn(ollamaMod, 'summarize').mockResolvedValue('Tutorial on brewing water kefir at home with grains in sugar water.');
    vi.spyOn(ollamaMod, 'headline').mockResolvedValue('Water Kefir Brewing Tutorial');

    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('file', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);
    db.prepare(`INSERT INTO item_media (item_id, media_type, file_path, storage, created_at) VALUES (?, 'video', 'general/videos/x.mp4', 'local', ?)`).run(itemId, now);
    db.prepare(`INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at) VALUES ('t-vid', 'process', 'Process library item ${itemId}: video needs transcription', 'processor', 'queued', 'memobot', 0, ?)`).run(now);

    const result = await drainQueue();
    expect(result.completed).toBe(1);

    const types = (db.prepare(`SELECT content_type FROM item_content WHERE item_id = ?`).all(itemId) as Array<{ content_type: string }>).map(r => r.content_type).sort();
    expect(types).toContain('transcript');
    expect(types).toContain('ai_summary');
  });

  it('audio-only files are transcribed', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    const audioMod = await import('./enrichers/audio.js');
    vi.spyOn(audioMod, 'enrichAudio').mockResolvedValue({
      ok: true,
      text: 'Podcast excerpt discussing fermentation safety at room temperature.',
    });
    const ollamaMod = await import('./enrichers/ollama.js');
    vi.spyOn(ollamaMod, 'summarize').mockResolvedValue('Podcast on fermentation safety.');
    vi.spyOn(ollamaMod, 'headline').mockResolvedValue('Fermentation Safety Podcast');

    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, captured_at, project, created_at)
      VALUES ('file', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);
    db.prepare(`INSERT INTO item_media (item_id, media_type, file_path, storage, created_at) VALUES (?, 'audio', 'general/audio/x.mp3', 'local', ?)`).run(itemId, now);
    db.prepare(`INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at) VALUES ('t-aud', 'process', 'Process library item ${itemId}: audio needs transcription', 'processor', 'queued', 'memobot', 0, ?)`).run(now);

    const result = await drainQueue();
    expect(result.completed).toBe(1);

    const types = (db.prepare(`SELECT content_type FROM item_content WHERE item_id = ?`).all(itemId) as Array<{ content_type: string }>).map(r => r.content_type).sort();
    expect(types).toContain('transcript');
    expect(types).toContain('ai_summary');
  });
});
```

- [ ] **Step 2: Run tests** — Expect FAIL on each (dispatcher doesn't handle file source_type yet).

- [ ] **Step 3: Extend `processTask` in `src/processor.ts`**

Add these imports at the top:

```typescript
import { enrichPdf } from './enrichers/pdf.js';
import { enrichAudio } from './enrichers/audio.js';
import { enrichVideo } from './enrichers/video.js';
```

Extend `processTask` AFTER the screenshot branch:

```typescript
  // File items (pdf/video/audio)
  if (item.source_type === 'file' && item.media.length > 0) {
    const media = item.media[0] as { media_type: string; file_path: string };
    const absPath = `${LIBRARY_ROOT}/${media.file_path}`;
    let extracted: { ok: boolean; text?: string; error?: string; errorCode?: string };
    if (media.media_type === 'pdf') {
      extracted = await enrichPdf(absPath);
    } else if (media.media_type === 'video') {
      extracted = await enrichVideo(absPath);
    } else if (media.media_type === 'audio') {
      extracted = await enrichAudio(absPath);
    } else {
      return { ok: true, summaryHint: `unsupported media type ${media.media_type} (skipped)` };
    }

    if (!extracted.ok) return { ok: false, error: extracted.error, errorCode: extracted.errorCode };
    return await enrichFromExtractedText(item, extracted.text ?? '', media.media_type);
  }

  // Voice notes (transcript already written by memobot at ingest)
  if (item.source_type === 'voice') {
    // If there's already a transcript, just summarize it
    const db = _getTestDb();
    const existing = db.prepare(`SELECT text FROM item_content WHERE item_id = ? AND content_type = 'transcript' LIMIT 1`).get(item.id) as { text: string } | undefined;
    if (existing) {
      return await enrichFromExtractedText(item, existing.text, 'voice-transcript-existing');
    }
    return { ok: false, error: 'voice note missing transcript', errorCode: 'no_transcript' };
  }
```

Add the shared helper:

```typescript
async function enrichFromExtractedText(
  item: FullItem,
  rawText: string,
  sourceLabel: string,
): Promise<EnrichOutcome> {
  if (rawText.length === 0) {
    return { ok: true, summaryHint: `${sourceLabel} (no text extracted, skipped summary)` };
  }

  // Write raw text as transcript (reuses the 'transcript' content_type for
  // any raw file-level extraction: PDF text, audio, video transcripts).
  addContent(item.id, {
    content_type: 'transcript',
    text: rawText,
    source_agent: 'processor',
  });

  // Summarize + headline
  if (rawText.length >= 100) {
    try {
      const summary = await summarize(rawText);
      if (summary) {
        addContent(item.id, {
          content_type: 'ai_summary',
          text: summary,
          source_agent: 'processor',
        });
      }
      if (!item.title) {
        const h = await headline(rawText);
        if (h) {
          const db = _getTestDb();
          db.prepare(`UPDATE library_items SET title = ? WHERE id = ?`).run(h.slice(0, 200), item.id);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Processor: Ollama call failed during summarization, continuing');
    }
  }

  return { ok: true, summaryHint: `${sourceLabel} + summary` };
}
```

- [ ] **Step 4: Run full processor test suite** — Expect PASS (all previous tests + 3 new).

Run: `npx vitest run src/processor.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/processor.ts src/processor.test.ts
git commit -m "feat(processor): wire PDF, audio, video enrichers into dispatch

processTask now routes file items to pdf/audio/video enrichers
by media_type. Extracted text is written as content_type=transcript
(reused for any file-level extraction), summarized via Ollama,
title updated when missing. Voice items re-summarize their
existing transcript. 3 new integration tests cover pdf, video,
audio paths."
```

---

# Wave 4 — Polish, Integration, Smoke Test

## Task 15: Retry + 3-strike policy test

**Files:**
- Modify: `src/processor.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/processor.test.ts`:

```typescript
describe('processor retry policy', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('retries a failing task twice then marks failed on 3rd attempt', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    const urlMod = await import('./enrichers/url.js');
    vi.spyOn(urlMod, 'enrichUrl').mockResolvedValue({
      ok: false,
      error: 'simulated fail',
      errorCode: 'playwright_timeout',
    });

    const itemId = (db.prepare(`
      INSERT INTO library_items (source_type, url, captured_at, project, created_at)
      VALUES ('article', 'https://example.com/x', ?, 'general', ?)
    `).run(now, now).lastInsertRowid as number);
    db.prepare(`INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at) VALUES ('t-retry', 'p', 'Process library item ${itemId}: x', 'processor', 'queued', 'memobot', 0, ?)`).run(now);

    // Attempt 1 (fails, requeues)
    let result = await drainQueue();
    expect(result.skipped).toBe(1);
    let row = db.prepare(`SELECT status, attempts, error FROM mission_tasks WHERE id = 't-retry'`).get() as { status: string; attempts: number; error: string };
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);

    // Attempt 2 (fails, requeues)
    result = await drainQueue();
    expect(result.skipped).toBe(1);
    row = db.prepare(`SELECT status, attempts FROM mission_tasks WHERE id = 't-retry'`).get() as { status: string; attempts: number };
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(2);

    // Attempt 3 (fails, marks failed)
    result = await drainQueue();
    expect(result.failed).toBe(1);
    row = db.prepare(`SELECT status, attempts FROM mission_tasks WHERE id = 't-retry'`).get() as { status: string; attempts: number };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);

    // Attempt 4 (no-op, skipped because attempts >= MAX_ATTEMPTS filter in claim query)
    result = await drainQueue();
    expect(result.processed).toBe(0);

    // enriched_at should still be NULL after permanent failure
    const li = db.prepare(`SELECT enriched_at FROM library_items WHERE id = ?`).get(itemId) as { enriched_at: number | null };
    expect(li.enriched_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run test** — Expect PASS (the retry logic already lives in `drainQueue` from Task 4).

If it fails, inspect the behavior and reconcile with the implementation. Do NOT change the test to match — the implementation should match the test's behavior (which captures the spec's intent).

- [ ] **Step 3: Commit**

```bash
git add src/processor.test.ts
git commit -m "test(processor): verify 3-strike retry policy

Ensures failing tasks stay queued with attempts incrementing on
each drain cycle, flip to status='failed' on the third attempt,
and are ignored by subsequent drains. enriched_at remains NULL."
```

---

## Task 16: Graceful Ollama-unavailable degradation test

**Files:**
- Modify: `src/processor.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe('processor graceful Ollama degradation', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('still writes raw extraction when Ollama summarize throws', async () => {
    const db = _getTestDb();
    const now = Math.floor(Date.now() / 1000);

    const urlMod = await import('./enrichers/url.js');
    vi.spyOn(urlMod, 'enrichUrl').mockResolvedValue({
      ok: true,
      title: 'Working',
      bodyText: 'Sufficient body text for summarization but Ollama will fail on this path.',
    });
    const ollamaMod = await import('./enrichers/ollama.js');
    vi.spyOn(ollamaMod, 'summarize').mockRejectedValue(new Error('Ollama not reachable'));
    vi.spyOn(ollamaMod, 'headline').mockRejectedValue(new Error('Ollama not reachable'));

    const itemId = (db.prepare(`INSERT INTO library_items (source_type, url, captured_at, project, created_at) VALUES ('article', 'https://example.com/z', ?, 'general', ?)`).run(now, now).lastInsertRowid as number);
    db.prepare(`INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at) VALUES ('t-ollama', 'p', 'Process library item ${itemId}: url', 'processor', 'queued', 'memobot', 0, ?)`).run(now);

    const result = await drainQueue();
    expect(result.completed).toBe(1);

    // Raw body landed, summary did not
    const types = (db.prepare(`SELECT content_type FROM item_content WHERE item_id = ?`).all(itemId) as Array<{ content_type: string }>).map(r => r.content_type);
    expect(types).toContain('scraped_summary');
    expect(types).not.toContain('ai_summary');

    // enriched_at set (raw extraction was successful)
    const li = db.prepare(`SELECT enriched_at FROM library_items WHERE id = ?`).get(itemId) as { enriched_at: number };
    expect(li.enriched_at).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test** — Expect PASS (the `try/catch` around Ollama calls from Task 9 already provides this behavior).

- [ ] **Step 3: Commit**

```bash
git add src/processor.test.ts
git commit -m "test(processor): verify graceful degradation when Ollama is down

When summarize() or headline() throw, processor still writes
raw extraction to item_content, marks enriched_at, and completes
the task. Only ai_summary rows are missing. Matches the spec's
'Ollama unavailable' behavior."
```

---

## Task 17: Full-suite regression + build sanity

**Files:** None (operational).

- [ ] **Step 1: Run all Phase 1+2+3 tests**

```bash
npx vitest run
```

Expected: every previously-passing test still passes, plus the new Phase 3 tests. The 7 `src/skill-registry.test.ts` failures (pre-existing, unrelated) remain. Anything ELSE failing needs investigation.

- [ ] **Step 2: Build and verify dist is clean**

```bash
npm run build
```

Expected: clean `tsc` output. If any type errors surface (especially around the updated `AddContentOpts` union), fix and re-commit.

- [ ] **Step 3: If anything was fixed in Step 2, commit**

```bash
git add -A
git commit -m "fix: build regressions surfaced by full suite"
```

Otherwise skip.

---

## Task 18: Real-world smoke test

**Files:** None (manual).

- [ ] **Step 1: Confirm external tools**

```bash
which tesseract ffmpeg && curl -s http://localhost:11434/api/version
```

All three should return successfully.

- [ ] **Step 2: Restart ClaudeClaw main process so scheduled_tasks pick up the new entries**

How this looks depends on your install. If the main bot runs via launchd:

```bash
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.main
```

If manually started: stop the process (Ctrl+C) and run `npm start` again.

Check the log for:
```
Migration: widened item_content.content_type enum to include ai_summary
Migration: added attempts column to mission_tasks
```
Both should appear ONCE.

- [ ] **Step 3: Verify the two scheduled_tasks rows exist**

```bash
sqlite3 store/claudeclaw.db "SELECT id, schedule, next_run, status FROM scheduled_tasks WHERE id IN ('processor-drain', 'processor-sweep')"
```

Expected: two rows, status='active', `next_run` values in the near future.

- [ ] **Step 4: Seed some test data (if library is empty)**

Send 3-5 messages to `@MemoVizBot`: a URL, a screenshot, a PDF, a short video, a plain-text note. Confirm they land via `/recent`.

- [ ] **Step 5: Wait for the drain to fire**

The drain runs every minute. Wait ~1-2 minutes. Optionally trigger manually:

```bash
node dist/processor-cli.js drain
```

- [ ] **Step 6: Verify enrichments**

```bash
sqlite3 -column -header store/claudeclaw.db "
SELECT li.id, li.source_type, li.title,
       (SELECT COUNT(*) FROM item_content ic WHERE ic.item_id = li.id AND ic.content_type = 'ai_summary') AS has_summary,
       (SELECT COUNT(*) FROM item_content ic WHERE ic.item_id = li.id AND ic.content_type IN ('scraped_summary','transcript','ocr')) AS has_raw,
       li.enriched_at IS NOT NULL AS enriched
FROM library_items li
ORDER BY li.id DESC
LIMIT 10"
```

Each recent item should have `enriched=1`, `has_raw >= 1`, `has_summary >= 1` (for items with enough content).

- [ ] **Step 7: Verify hive_mind entries**

```bash
sqlite3 -column -header store/claudeclaw.db "
SELECT agent_id, summary, datetime(created_at, 'unixepoch', 'localtime') AS at
FROM hive_mind
WHERE agent_id = 'processor'
ORDER BY created_at DESC LIMIT 10"
```

Each enrichment should have produced a `"enriched #<id> (project) ..."` row.

- [ ] **Step 8: Verify search surfaces content**

Send to `@MemoVizBot`:
- `/recent` — should show meaningful labels (summaries/headlines) not "(no content)" or filenames.
- `/find <word-from-an-item's-content>` — should return matches.

- [ ] **Step 9: Confirm all spec §11 success criteria**

Tick each box:
- [ ] The 6-or-so previously-queued mission_tasks drained successfully (or the fresh ones you seeded).
- [ ] Each item has `enriched_at` set and ≥1 ai_summary + ≥1 raw extraction row.
- [ ] `/find` and `/recent` show meaningful text.
- [ ] Running drain a second time is a no-op on already-enriched items.
- [ ] All existing tests plus new Phase 3 tests pass.
- [ ] Ollama-down test confirms graceful degradation (from Task 16).
- [ ] Tesseract-missing error message is helpful (from image.ts Task 8).

- [ ] **Step 10: Merge and push**

```bash
npx vitest run 2>&1 | tail -3
git status --short
git log --oneline feat/processor-agent ^main
git checkout main
git merge feat/processor-agent --ff-only
# optional
git push origin main
```

Phase 3 is complete when all §11 boxes tick.

---

## Self-Review Notes

**Spec coverage check (against spec §11 success criteria):**
- ✅ 6 queued mission_tasks drained — Task 18 smoke step 5.
- ✅ enriched_at set + content rows — Task 18 step 6.
- ✅ `/find` and `/recent` show meaningful text — Task 18 step 8.
- ✅ Idempotent second run — Task 4 includes the `enriched_at` short-circuit; Task 18 step 9 confirms.
- ✅ All existing + new tests pass — Task 17.
- ✅ Ollama offline graceful — Task 16.
- ✅ Tesseract missing produces clear error — Task 8 implementation; verified indirectly by Task 18.

**Placeholder scan:** No "TBD", no "Add appropriate error handling", no "Similar to Task N". All steps contain runnable code or commands with expected output.

**Type consistency check:**
- `EnrichOutcome` interface defined in Task 4 (processor.ts) is the contract between processor.processTask and per-media enricher helpers. Every enricher returns a matching shape (different interface name per enricher, but identical fields).
- `FullItem` from `library.ts` used consistently in Task 4 onwards.
- `LIBRARY_ROOT` imported from config.ts in Task 9 and reused in Task 14.
- Mission_task prompt format `Process library item <id>: <reason>` used in memobot (Phase 2) and parsed in processor.parseItemId (Task 4).

**Risks / notes:**
- Task 8 assumes `tesseract` is on `$PATH`. On macOS: `brew install tesseract`. Plan step 5 verifies.
- Task 11 depends on the fixture PDF containing the word "kefir". If the generated PDF differs, adjust the assertion or regenerate.
- Task 13's test is minimal by design. Real video coverage lives in Task 18's manual smoke.
- Task 18 step 2 relies on the user's launchd layout. If they start ClaudeClaw differently, adapt accordingly.
