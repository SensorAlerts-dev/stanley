# Processor Agent — Design (Phase 3)

**Date:** 2026-04-23
**Status:** Design approved, ready for implementation plan
**Scope:** Phase 3 of 5 in the research library multi-agent build
**Depends on:**
- `docs/superpowers/specs/2026-04-23-research-library-schema-design.md` (Phase 1, shipped)
- `docs/superpowers/specs/2026-04-23-memobot-collector-design.md` (Phase 2, shipped)

---

## 1. Purpose

Memobot captures items cheaply (URL + minimal metadata, or file path + caption, or raw note). Most saves land with `enriched_at = NULL` and a `mission_tasks` row queued for deeper work. Phase 3 Processor is the background worker that drains that queue.

For every unenriched item, Processor runs the appropriate extractor (OCR, transcription, scrape, text-extract), writes raw text to `item_content` so FTS5 can search it, runs a local Qwen 2.5 3B model to produce a short summary, optionally rewrites the item's title when the scraped one is generic, and marks `enriched_at`.

Processor has no Telegram bot, no `@BotFather` token, no dedicated agent directory. It runs as scheduled code inside the existing ClaudeClaw process via `src/scheduler.ts`.

Primary user payoff: once Processor ships, `/find kefir` matches items by their OCR'd screenshot text, video transcript, and scraped page body — not just by captions and URLs.

## 2. Scope

**In scope (this spec):**
- Queue drain + fallback sweep scheduling.
- Per-media-type enrichers: URL scrape, image OCR, PDF extract, audio/video transcribe.
- Local Ollama summarization via Qwen 2.5 3B Instruct.
- Schema touch: add `ai_summary` value to `item_content.content_type` CHECK constraint.
- Retry policy, error handling, hive_mind observability.
- Unit + integration tests.

**Out of scope (later phases or explicit non-goals):**
- Image vision description beyond OCR (describing what's visually IN the image). Needs a vision-capable model (llava, qwen2-vl). Defer.
- Video frame analysis. Same reason.
- Cross-item relationships / embeddings / typed tags. That is Phase 4.
- Virality scoring, trending topic suggestions, weekly digest. That is Phase 5.
- Google Drive upload of enriched artifacts.

## 3. Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────────┐
│              ClaudeClaw main process (already running)              │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  src/scheduler.ts                                             │  │
│  │    cron entry: processor drain  (every 1 minute)              │  │
│  │    cron entry: processor sweep  (every 1 hour)                │  │
│  └──────────────────────┬────────────────────────────────────────┘  │
│                         │                                           │
│                         ▼                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  src/processor.ts           (orchestrator + retry + dispatch) │  │
│  └─────┬────────────┬────────────┬────────────┬─────────────────┘  │
│        │            │            │            │                    │
│        ▼            ▼            ▼            ▼                    │
│   enrichers/    enrichers/    enrichers/   enrichers/              │
│   url.ts        image.ts      pdf.ts       audio.ts                │
│   (Playwright)  (tesseract)   (pdf-parse)  (voice.ts reused)       │
│        │            │            │            │                    │
│        └────────────┴──────┬─────┴────────────┘                    │
│                            │                                       │
│                            ▼                                       │
│                   enrichers/ollama.ts                              │
│                   (HTTP → localhost:11434/api/generate)            │
│                   qwen2.5:3b-instruct                              │
│                            │                                       │
│                            ▼                                       │
│          library-cli / library.ts direct API:                      │
│            addContent (content_type = ocr | transcript |           │
│                        scraped_summary | ai_summary)               │
│            markEnriched, setTitle (when generic)                   │
│            hive_mind log                                           │
└─────────────────────────────────────────────────────────────────────┘
```

Processor does NOT run as its own launchd service. The existing main ClaudeClaw process (the one running the orchestrator + main bot) registers two new scheduled tasks via `src/scheduler.ts`, and those tasks invoke `processor.ts` functions in-process.

## 4. Components

All files are **new**. No existing file's contents are modified except:
- `src/db.ts` — extend `item_content.content_type` CHECK enum.
- `src/scheduler.ts` or the scheduler bootstrap — register two cron entries.

### 4.1 `src/processor.ts` — orchestrator

Exports:
- `drainQueue()` — called by the 1-min cron. Processes ≤ N queued tasks sequentially.
- `sweepStale()` — called by the 1-hour cron. Queues mission_tasks for library_items where `enriched_at IS NULL` and no open mission_task exists.

Internal:
- `processTask(task)` — reads library_items + item_media, dispatches to the right enricher, writes results, updates task status, logs hive_mind.
- `dispatchEnricher({ source_type, media_type, ... })` — returns the appropriate enricher function.
- `shouldRetry(task)` — checks `attempt_count` (derived from mission_tasks.error history or a new column); 3 strikes and out.

Concurrency: strictly sequential (one task at a time). Qwen uses significant CPU/GPU; parallelism would thrash.

Drain cap: process ≤ 10 tasks per minute cron tick. Remaining items drain on subsequent ticks. Prevents one long-running enrichment (e.g. a 30-minute podcast transcription) from starving the rest.

### 4.2 `src/enrichers/url.ts`

Input: a library_items row with `source_type ∈ {tiktok, reddit, instagram, ..., article}` and a URL.

Steps:
1. Launch Playwright (Chromium, headless, new context per call — no cookies/state).
2. Navigate with 30s timeout.
3. Wait for `networkidle` or 10s, whichever comes first.
4. Extract: page title, og:title, og:description, main article body text (readability-style: strip nav/footer/script, grab `<article>` or `<main>` or the densest text block).
5. Close context.
6. Return `{ title, bodyText, meta }` to orchestrator.

Orchestrator then:
- Writes `item_content` row with `content_type='scraped_summary'`, `text=<bodyText>` (first ~10K chars, truncated if longer).
- If the existing `library_items.title` is generic ("TikTok - Make Your Day", "Instagram", "YouTube", etc.) or NULL, asks Ollama for a short headline over the body text and updates `library_items.title`.
- Asks Ollama for a 1-2 sentence summary over the body text, writes to `item_content` with `content_type='ai_summary'`.

Failure modes: Playwright timeout, DNS failure, bot-wall, requires-login. Return error; orchestrator retries. After 3 failures, mark task failed; keep the URL saved as-is.

### 4.3 `src/enrichers/image.ts`

Input: library_items row with attached `item_media` where `media_type='image'`.

Steps:
1. Resolve `file_path` → absolute path via `$LIBRARY_ROOT` + relative path.
2. Shell out: `tesseract <abs_path> - -l eng` (or `eng+<lang>` if we detect non-English; skip autodetect for now).
3. Capture stdout.
4. Return OCR text.

Orchestrator:
- Writes `item_content` with `content_type='ocr'`, `text=<ocr_output>`.
- If OCR text length ≥ 100 chars, asks Ollama for a 1-2 sentence summary, writes `ai_summary` row.
- If OCR text length < 100 chars, skip summarization (nothing meaningful to summarize).

Failure: tesseract not installed, file missing, unreadable image. Return error. If tesseract binary missing, error message instructs user to `brew install tesseract`.

### 4.4 `src/enrichers/pdf.ts`

Input: library_items row with `item_media.media_type='pdf'`.

Steps:
1. Read file at `$LIBRARY_ROOT` + `file_path`.
2. `pdf-parse` npm package extracts text.
3. Return `text` (first ~10K chars truncated).

Orchestrator:
- Writes `item_content` `content_type='transcript'` (repurposing for "file text contents"; alternative would be adding `pdf_text` to the enum, but transcript reads as generic-enough). Actually: choose content_type carefully. Decision: use `transcript` since it literally represents "the text of what's in this file." Not perfect semantically but fits the existing enum without adding another value.
- Asks Ollama for 1-2 sentence summary, writes `ai_summary` row.

Failure: pdf-parse throws on protected/malformed PDFs. Return error.

### 4.5 `src/enrichers/audio.ts` and `src/enrichers/video.ts`

Input: library_items row with `item_media.media_type ∈ {audio, video}`.

Audio enricher:
1. Resolve file_path.
2. Call the existing `src/voice.ts transcribeAudio()` — which already handles Groq (cloud) + whisper-cpp (local) fallback.
3. Return transcript.

Video enricher:
1. Resolve file_path.
2. Extract audio track via `ffmpeg -i <video> -vn -acodec pcm_s16le -ar 16000 -ac 1 <temp.wav>`.
3. Feed temp.wav to audio enricher.
4. Clean up temp file.

Orchestrator for both:
- Writes `item_content` `content_type='transcript'`, `text=<transcript>`.
- Asks Ollama for 1-2 sentence summary, writes `ai_summary`.

Failure: Groq API quota exhausted, no local whisper-cpp, ffmpeg missing, corrupt file. Return error with specific subcategory.

### 4.6 `src/enrichers/ollama.ts`

Input: `{ systemPrompt, userText, maxTokens }`. Output: `string`.

Steps:
1. POST to `http://localhost:11434/api/generate`:
   ```json
   { "model": "qwen2.5:3b-instruct",
     "system": "<system prompt>",
     "prompt": "<user text>",
     "stream": false,
     "options": { "num_predict": <maxTokens>, "temperature": 0.2 } }
   ```
2. Parse response, return `response` field.

Two public helpers:
- `summarize(rawText, { maxSentences = 2 })` — wraps generate with a summarization system prompt. Truncates input to first 8K chars (model context).
- `headline(rawText)` — wraps generate with a "one short descriptive title, no quotes" system prompt. Used to replace generic `library_items.title` values.

Failure: Ollama daemon not running → clear error "Start Ollama: `ollama serve`". Model not pulled → "Run: `ollama pull qwen2.5:3b-instruct`". Return error to orchestrator.

Timeout: 60s per call. A 3B model should return within 5-15s for 2-sentence outputs on M-series. 60s is generous.

### 4.7 `src/processor-cli.ts` — scheduled task entry point

Thin wrapper so `src/scheduler.ts` can invoke via an existing pattern. Exports `main()` that parses `drain` or `sweep` command, calls the corresponding function on `src/processor.ts`, logs result, exits.

The scheduler registers entries like:
```
node dist/processor-cli.js drain    # every 1 min
node dist/processor-cli.js sweep    # every 1 hour
```

### 4.8 Schema changes

Two inline changes in `src/db.ts`:

**Change 1 — widen `item_content.content_type` enum** to include `ai_summary`:

```
BEFORE:
  CHECK (content_type IN ('ocr','scraped_summary','transcript','user_note'))

AFTER:
  CHECK (content_type IN ('ocr','scraped_summary','transcript','user_note','ai_summary'))
```

SQLite can't alter CHECK constraints in place. Migration sequence in `runMigrations()` (the existing inline migration function in `src/db.ts`):
1. Detect via `PRAGMA table_info(item_content)` whether the enum already includes `ai_summary` (by probing with a test insert that we roll back, or by checking `sqlite_master.sql` text).
2. If not, create `item_content_new` with the widened enum, copy rows, drop old, rename. Recreate FTS triggers pointing at the new table.
3. Bump a `PRAGMA user_version` or migration marker so it runs once per DB.

**Change 2 — add `mission_tasks.attempts` column** for retry tracking:

```
ALTER TABLE mission_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
```

Straight `ALTER TABLE` — SQLite supports adding a NOT NULL column with a default. One-line addition in `runMigrations()`, guarded by a column-exists check via `PRAGMA table_info(mission_tasks)`.

Both changes are backward-compatible. Pre-Phase-3 items remain valid. Rollback path: drop `ai_summary` rows, recreate item_content with the narrower enum; drop the `attempts` column (SQLite 3.35+ supports `ALTER TABLE DROP COLUMN`).

## 5. Data Flow Per Source Type

### 5.1 URL

```
Queue picks task for library_items #42 (source_type=tiktok, url present, enriched_at=NULL)
  → url.ts opens Playwright, navigates, extracts body text (say 3KB of article text)
  → write item_content { item_id: 42, content_type: 'scraped_summary', text: <3KB raw body>, source_agent: 'processor' }
  → check library_items.title = "TikTok - Make Your Day" (generic)
  → ollama.headline(body) → "Kamil Banc breaks down Claude's new design features"
  → UPDATE library_items SET title = '...' WHERE id = 42
  → ollama.summarize(body) → "Creator argues Claude Code plus Google Stitch will replace web designers, with a 6-slide demo of the workflow."
  → write item_content { content_type: 'ai_summary', text: '...', source_agent: 'processor' }
  → UPDATE library_items SET enriched_at = NOW
  → UPDATE mission_tasks SET status = 'completed'
  → INSERT hive_mind "enriched #42 (general) Kamil Banc breaks down Claude's..."
```

### 5.2 Screenshot (image)

```
Task for library_items #43 (source_type=screenshot, item_media has media_type=image)
  → image.ts shells tesseract on /Volumes/ClaudeClaw/claudeclaw-library/general/screenshots/20260423-1539_43_untitled.jpg
  → gets 400 chars of OCR text
  → write item_content { content_type: 'ocr', text: <400 chars>, source_agent: 'processor' }
  → OCR text ≥ 100 chars → summarize
  → ollama.summarize → "Screenshot of a terminal showing Claude Code session cost metrics"
  → write item_content { content_type: 'ai_summary', ... }
  → library_items.title is NULL → set to summary
  → mark enriched_at, task completed, hive_mind log
```

### 5.3 Video

```
Task for library_items #44 (source_type=file, item_media.media_type=video)
  → video.ts extracts audio to /tmp/44.wav via ffmpeg
  → audio.ts calls voice.ts transcribeAudio(/tmp/44.wav) → Groq Whisper
  → gets transcript (say 2KB)
  → clean up /tmp/44.wav
  → write item_content { content_type: 'transcript', text: <2KB>, source_agent: 'processor' }
  → ollama.summarize(transcript) → "Speaker demos a Claude prompt that saves 50% on tokens by being terse."
  → write item_content { content_type: 'ai_summary', ... }
  → if library_items.title matches /untitled|Make Your Day|Instagram/ → replace with headline
  → mark enriched_at, task completed, hive_mind log
```

### 5.4 PDF / Audio-only

Symmetric to video, minus the ffmpeg step. Audio skips ffmpeg. PDF uses pdf-parse.

### 5.5 Voice note (already-transcribed at ingest)

Memobot's ingest path already writes the transcript. `enriched_at` is set at that point (voice saves go through the deterministic handler with `--enriched`). Processor's queue won't see voice notes unless memobot explicitly queued them.

For voice saves that reach Processor (currently memobot does NOT queue them; this may change), Processor treats them like audio files but skips re-transcription since item_content already has the transcript.

### 5.6 Note (user-typed text)

Memobot saves with `--enriched` and no processor task. Processor never sees these.

## 6. Trigger Strategy (from brainstorm §3)

- **Queue drain:** every 1 minute. Drains up to 10 `mission_tasks` rows (FIFO by priority then created_at) assigned to `processor`, status `queued`.
- **Fallback sweep:** every 1 hour. For each `library_items` where `enriched_at IS NULL` AND no open mission_task references it, insert a new queued mission_task. Catches items memobot failed to queue (bugs, old data, manual DB inserts).

Scheduler registration: during startup, check if the two task ids exist in `scheduled_tasks`; if not, insert them. Idempotent — won't duplicate on restart.

## 7. Error Handling

**Retry mechanics.** Each `mission_tasks` row gains an implicit attempt counter via its `error` column history. Simpler: add a new column `mission_tasks.attempts INTEGER NOT NULL DEFAULT 0` via inline schema update. On each attempt:
- Before enrichment: `UPDATE mission_tasks SET attempts = attempts + 1 WHERE id = ?`
- On success: `UPDATE mission_tasks SET status = 'completed', completed_at = NOW WHERE id = ?`
- On failure: `UPDATE mission_tasks SET error = ? WHERE id = ?`; if attempts ≥ 3, also set `status = 'failed'`.

Rows with `status = 'failed'` are skipped by the drain query.

**User-facing recovery.** `/reenrich <id>` already exists (memobot slash command). It nulls `enriched_at` and queues a fresh mission_task via `library-cli update`. That new task has `attempts = 0` and runs independently of any prior failed one.

**Enricher-specific error subcategories** (recorded in mission_tasks.error for diagnostics):
- `playwright_timeout`, `playwright_navigation_error`, `bot_wall_detected`
- `tesseract_not_installed`, `ocr_failed`, `image_unreadable`
- `pdf_parse_error`, `pdf_encrypted`
- `ffmpeg_not_installed`, `audio_extraction_failed`
- `whisper_groq_quota`, `whisper_local_missing`, `transcription_failed`
- `ollama_not_running`, `ollama_model_missing`, `ollama_timeout`
- `unsupported_source_type`

**Ollama unavailable** (daemon down or model missing): the whole Processor pauses gracefully. Raw extraction can still write to item_content (OCR, transcript), but the summary + headline steps are skipped. `enriched_at` still gets set because raw extraction succeeded. Processor logs a warning. This keeps the library usable even if Qwen is offline.

## 8. Observability

**hive_mind.** One row per successful enrichment, attributed to `agent_id='processor'`. Summary format:
```
enriched #<id> (<project>) <what_done>
```
Where `<what_done>` is a short description like "OCR + summary", "transcript + summary (234s audio)", "scrape + headline + summary".

**Errors.** Logged via `logger.error()` with context object (task id, item id, enricher name, error code). Not mirrored to hive_mind (hive_mind is for successful activity only).

**Dashboard counters.** The library panel (future work) can render:
- "N items enriched today"
- "M items pending enrichment"
- "K items failed"
by simple counts against `library_items` and `mission_tasks`.

## 9. External Dependencies

Must install once:
```bash
brew install tesseract                  # OCR binary, ~40 MB
brew install ffmpeg                     # audio extraction from video, ~80 MB
                                         # (often already installed on remy for video work)
npm install pdf-parse                   # ~400 KB, pure JS
ollama pull qwen2.5:3b-instruct        # ~1.9 GB (already done)
```

Already installed:
- Ollama daemon (user ran `brew install ollama` this session and verified the daemon)
- whisper-cpp (ClaudeClaw voice pipeline) OR Groq API (GROQ_API_KEY in .env)
- Playwright (ClaudeClaw MCP dep)

`npm run build` tree is unaffected by these choices — they're all runtime-shelled binaries except `pdf-parse`.

## 10. Testing

**Per-enricher unit tests:**
- `url.test.ts` — mock Playwright, verify body-text extraction logic on a known HTML fixture.
- `image.test.ts` — mock tesseract shell-out, verify output handling. Real OCR test uses a tiny PNG with known text as a fixture.
- `pdf.test.ts` — use a small fixture PDF, assert extraction works.
- `audio.test.ts` — mock voice.ts transcribeAudio, verify orchestration.
- `video.test.ts` — mock ffmpeg shell, then audio enricher.
- `ollama.test.ts` — mock HTTP with an in-test server, verify request shape + response parsing + timeout behavior.

**Integration test:** seed library_items + item_media + a queued mission_task, run `drainQueue()` with all enrichers mocked to deterministic outputs, assert:
- item_content rows created with correct content_types
- library_items.enriched_at set
- mission_tasks.status = 'completed'
- hive_mind row created

**Real-world smoke test** (manual, after implementation):
- Clean all data from DB
- Send 5 mixed items via memobot: URL, screenshot, PDF, video, voice note
- Wait 2 minutes (cron ticks)
- Verify via `/recent` that each item has a meaningful title + summary
- Verify `/find <keyword>` finds items by their transcript/OCR content

## 11. Success Criteria

Phase 3 is done when:

- [ ] Running Processor on the 6 currently-queued mission_tasks drains them all successfully within 30 minutes.
- [ ] Each formerly-unenriched item has: `enriched_at` set, ≥ 1 `item_content` row with raw extraction, ≥ 1 row with `ai_summary` when extraction produced meaningful text.
- [ ] `/find kefir` and similar FTS queries match items by their transcript/OCR/scraped content (not just captions).
- [ ] `/recent` displays meaningful labels (summaries/headlines) instead of `(no content)` or filenames.
- [ ] Running Processor a second time is a no-op: items with `enriched_at IS NOT NULL` are skipped.
- [ ] All existing tests (151 as of Phase 2 close) still pass. New Processor tests add ≥ 20 cases, all passing.
- [ ] Ollama being offline does not crash Processor: raw extraction still runs, summaries are skipped, warnings logged.
- [ ] Tesseract being missing produces a clear error with install instructions and marks the task failed after 3 attempts.

## 12. Assumptions and Open Questions

**Locked in:**
- Ollama daemon runs as a background service on remy (user confirmed this session).
- `qwen2.5:3b-instruct` is the default summarization model.
- Scheduler (existing `src/scheduler.ts`) can run the drain and sweep as standard `scheduled_tasks` rows.
- `library.ts` API (Phase 2) is the sole interface to the DB. Processor does not write raw SQL.

**Deferred:**
- Exact retry backoff (linear, exponential, or fixed 1-min cron spacing?). Plan: fixed cron spacing. Acceptable because each attempt waits ≥ 1 min anyway.
- Output length caps for raw extraction. Tentative: truncate raw text to 10K chars before storing in item_content to keep FTS index reasonable.
- Whether to record `mission_tasks.attempts` as a column or derive it from error-field history. Plan: add the column (~5 lines in the migration).
- Vision-capable OCR alternatives (llava, qwen2-vl). Defer to Phase 3.5 or later.

**Open questions:**
- If both Groq and local whisper-cpp fail on an audio file, do we leave the item unenriched forever or try an alternative? Plan: let it hit 3 retries, fail, user can `/reenrich <id>` after fixing the underlying tool. No auto-fallback.
- Does the `/find` surface summaries vs raw text preferentially? Plan: FTS indexes both raw + summary in `item_content_fts`; snippet includes whichever matched. No preference — both are useful.

---

## Next Step

After this design is approved, the implementation plan is drafted via **writing-plans**. Plan breakdown likely follows waves similar to Phase 2:
- Wave 1: foundation (schema migration, scheduler wiring, orchestrator skeleton, Ollama client, trivial note-pass-through).
- Wave 2: URL + image enrichers (the two most common).
- Wave 3: PDF + audio + video enrichers.
- Wave 4: retry + error recovery polish, integration test, real-world smoke.
