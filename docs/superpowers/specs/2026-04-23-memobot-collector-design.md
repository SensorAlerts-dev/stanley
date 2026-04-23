# MemoBot Collector Agent — Design (Phase 2)

**Date:** 2026-04-23
**Status:** Design approved, ready for implementation plan
**Scope:** Phase 2 of 5 in the research library multi-agent build
**Depends on:** `docs/superpowers/specs/2026-04-23-research-library-schema-design.md` (Phase 1, already shipped)

---

## 1. Purpose

Memobot is the user-facing Telegram agent that turns incoming messages into library rows. When Remy sends a URL, file, screenshot, voice note, forwarded message, or free-form text to `@MemoVizBot`, memobot:

1. Classifies what kind of input it received.
2. Scrapes, transcribes, or reads enough content to describe it.
3. Writes a `library_items` row (plus satellites: `item_media`, `item_content`, `item_tags`).
4. Replies with a short summary that includes the item's DB id so Remy can act on it later.
5. Drops a `mission_task` for the future Processor agent when deeper enrichment is needed.

Primary user goal: **capture at the speed of thought, verify at a glance.** The summary reply is the confirmation — no "are you sure?" prompts, no second messages.

## 2. Scope

**In scope (this spec):**
- Full behavioral design of memobot for every input type: URLs across 10 platforms, screenshots, files, voice notes, forwarded messages, free-form text.
- A new shared data-access layer: `src/library.ts` (TypeScript) + `src/library-cli.ts` (CLI wrapper).
- Memobot's CLAUDE.md system prompt structure.
- Slash command surface for ops (find, delete, reassign, pin, review, open, recent, help).
- Reply format templates.
- Failure-mode behavior for every realistic error path.

**In implementation plan, not this spec:**
- Exact TDD test steps for every `library.ts` function.
- Wave-by-wave rollout order (specified generally below, detailed in the plan).

**Out of scope (later phases):**
- Phase 3: Processor agent (OCR, file text extraction, transcripts).
- Phase 4: Relationship agent (embeddings, typed relationships, semantic tags).
- Phase 5: Analyst agent (virality scoring, topic suggestions).
- Google Drive optional mirror (Phase 2 writes locally; Drive uploads are a later extension).

## 3. Architecture at a Glance

```
              ┌──────────────────────────────┐
  Telegram → │     @MemoVizBot (memobot)    │
             │    Haiku 4.5, isolated proc   │
             └──────────────┬───────────────┘
                            │
                            ▼
                ┌────────────────────────────┐
                │   Playwright MCP (scrape)  │  URL items only
                └─────────────┬──────────────┘
                              │
                              ▼
              ┌──────────────────────────────┐
              │      library-cli.ts          │ one subcommand per op
              │   (save / find / update ...) │
              └──────────────┬───────────────┘
                             │ imports
                             ▼
              ┌──────────────────────────────┐
              │         library.ts           │ dedup, url canon, inserts
              └──────────────┬───────────────┘
                             │
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
       library_items    item_media     item_content
       item_tags        mission_tasks  hive_mind
                        (push to       (activity
                         processor)     feed)
                             │
                             ▼
              $LIBRARY_ROOT/<project>/<bucket>/<filename>
              (/Volumes/ClaudeClaw/claudeclaw-library/...)
```

Memobot never writes raw SQL. Every DB touch goes through `library-cli.ts`, which delegates to `library.ts`. Benefits:
- URL canonicalization + hash generation live in one place.
- Dedup logic is testable without a running bot.
- Future agents (Processor, Relationship, Analyst) reuse the same data layer.
- Haiku's system prompt stays readable — no embedded SQL.

## 4. Data-Access Layer

### 4.1 `src/library.ts` — TypeScript functions

Signatures (types are descriptive, not final; implementation plan locks exact types):

```ts
insertItem(opts: {
  source_type: SourceType;
  url?: string | null;
  user_note?: string | null;
  user_message?: string | null;   // raw Telegram text, for context
  project?: Project;              // explicit project override
  title?: string | null;
  author?: string | null;
  captured_at?: number;           // default now
  source_meta?: object | null;    // JSON blob for per-source stats
  enriched_at?: number | null;    // set if caller already enriched
}): { id: number; is_duplicate: boolean; existing_id?: number; last_seen_at_before?: number };

addMedia(itemId: number, opts: {
  media_type: 'image' | 'video' | 'pdf' | 'audio' | 'other';
  file_path: string;               // relative to $LIBRARY_ROOT
  mime_type?: string;
  bytes?: number;
  storage: 'local' | 'drive' | 'both';
  drive_file_id?: string;
  drive_url?: string;
}): number;

addContent(itemId: number, opts: {
  content_type: 'ocr' | 'scraped_summary' | 'transcript' | 'user_note';
  text: string;
  source_agent: string;
  token_count?: number;
}): number;

addTag(itemId: number, opts: {
  tag: string;
  tag_type: 'topic' | 'person' | 'brand' | 'hashtag' | 'mood' | 'other';
  source_agent: string;
  confidence?: number | null;
}): void;

markEnriched(itemId: number, at?: number): void;
markReviewed(itemId: number, at?: number): void;
setPinned(itemId: number, pinned: boolean): void;
setProject(itemId: number, project: Project): void;

getItem(itemId: number): FullItem;          // joins all satellites
deleteItem(itemId: number): void;            // cascades

searchLibrary(opts: {
  query?: string;                   // FTS5 MATCH; if absent, no text filter
  project?: Project;
  source_type?: SourceType;
  pinned?: boolean;
  reviewed?: boolean;
  limit?: number;                   // default 10
  since?: number;                   // unix ts
}): Array<ItemSearchRow>;

queueProcessorTask(itemId: number, reason: string): string;  // wraps mission_tasks insert

canonicalizeUrl(rawUrl: string): string;    // lowercase scheme+host, strip noise params
urlHash(canonical: string): string;         // SHA1 hex
inferProject(text: string, url?: string): Project;  // keyword-based
```

### 4.2 `src/library-cli.ts` — shell interface for memobot

Subcommands:

```
library-cli check-url <url>
  → outputs: {"is_duplicate": true|false, "existing_id": 42, "existing_captured_at": 1776...}
  cheap dedup-only query: canonicalizes URL, hashes, looks up url_hash.
  memobot calls this before deciding whether to Playwright-scrape.

library-cli save \
  --source-type SOURCE_TYPE \
  [--url URL] \
  [--user-note "text"] \
  [--user-message "raw telegram text"] \
  [--project pure_bliss|octohive|personal|general] \
  [--title "..."] \
  [--author "..."] \
  [--source-meta '{"views":123}'] \
  [--enriched]  # flag: mark enriched_at = now
  [--media-temp-path /tmp/foo.png --media-type image --media-mime image/png]
  # when --media-temp-path is given, save:
  #   1. inserts library_items → gets id
  #   2. computes final path: $LIBRARY_ROOT/<project>/<bucket>/YYYYMMDD-HHMM_<id>_<slug>.<ext>
  #      bucket is derived from --media-type (image→screenshots, pdf→pdfs, video→videos, audio→audio, other→other)
  #      slug is a lowercase-dashed version of user_note or "untitled"
  #   3. moves the temp file to the final path
  #   4. inserts item_media pointing at the final path (relative to $LIBRARY_ROOT)
  [--content content_type=scraped_summary,text="..."] \
  [--tag tag=@brewlife,tag_type=person] \
  [--queue-processor "reason"]

  → outputs: {"id": 42, "is_duplicate": false}
  save also performs dedup internally: if the url_hash already exists,
  it appends user-note to the existing row (\n---\n separator), bumps
  last_seen_at, and returns {"id": existing_id, "is_duplicate": true}.
  check-url is the faster path when the caller wants to skip an
  expensive pre-save step (e.g. Playwright scrape) on known duplicates.

library-cli delete <id>                   → removes item + cascades
library-cli find <query> [--project X] [--limit N] [--json]
library-cli open <id> [--json]            → full item with satellites
library-cli recent [--limit N]
library-cli update <id> \
  [--project X] [--pinned 1|0] [--reviewed] [--reenrich] \
  [--append-note "text"]                  # appends to user_note, bumps last_seen_at

library-cli help
```

All subcommands exit 0 on success, non-zero with JSON error on failure. Memobot reads stdout as JSON.

### 4.3 URL canonicalization rules

Implemented in `canonicalizeUrl(rawUrl)`:
- Lowercase scheme + host.
- Strip trailing slash from path (unless path is `/`).
- Remove query params: `utm_*`, `fbclid`, `igshid`, `gclid`, `ref`, `ref_src`, `si`, `t` (tiktok share tokens).
- Resolve known shorteners (`bit.ly`, `t.co`, `tinyurl.com`, `youtu.be` → youtube.com) via one HTTP HEAD follow. Fallback: use the shortener URL as-is if the follow fails.
- Strip leading/trailing whitespace.

`urlHash(canonical)` = SHA1 hex of the canonicalized string. That hash is what the schema's unique partial index enforces.

### 4.4 Project inference rules

Implemented in `inferProject(text, url?)`. Keyword matching, conservative fallback to `general`:

| Project | Signals |
|---|---|
| `pure_bliss` | text/url contains: `kefir`, `water kefir`, `fermented`, `hydration`, `pure bliss`, `probiotic`, `scoby`, `gut health` (+ known competitor brand names) |
| `octohive` | text/url contains: `octopus`, `cephalopod`, `tentacle`, `aquarium`, `marine biology`, `octohive` |
| `personal` | Telegram message metadata suggests personal context (family names, journal-style language), explicit `/project personal` flag |
| `general` | default when no category keywords match |

The keyword lists live in `src/library.ts` as exported constants so tests can assert them and future tuning is a single-file edit.

## 5. Memobot Behavior Per Input Type

### 5.1 URL (Wave 1)

Detection: the Telegram message text contains a URL matching `https?://` (first URL wins if multiple).

Flow:
1. Run `library-cli check-url <url>` — cheap dedup-only query.
2. **If duplicate** (`is_duplicate: true`): call `library-cli update <existing_id> --append-note "<user's extra text>"`. Reply with `DUPLICATE` template. Done. No Playwright.
3. **If not duplicate**: open the canonicalized URL via Playwright MCP. Scrape enough for `title`, `author` (creator/byline if visible), and a 1-2 sentence summary. Read visible stats into a `source_meta` JSON (views, upvotes, likes, published_at, hashtags).
4. Call `library-cli save --source-type <inferred from domain> --url <canon> --title ... --author ... --source-meta '<json>' --content content_type=scraped_summary,text=<summary> --tag tag=@<creator>,tag_type=person --tag tag=<#hashtag>,tag_type=hashtag --enriched`.
5. Reply with `SAVE_URL_OK` template using the returned id.

Source-type inference from domain:
- `tiktok.com` → `tiktok`
- `instagram.com` → `instagram`
- `facebook.com`, `fb.com` → `facebook`
- `reddit.com` → `reddit`
- `twitter.com`, `x.com` → `twitter`
- `youtube.com`, `youtu.be` → `youtube`
- `threads.net` → `threads`
- `linkedin.com` → `linkedin`
- everything else → `article`

**Playwright depth (per Question 3 in brainstorm):** general guidance only. Haiku sees the page, picks what looks useful, writes a short summary. No per-platform scripts in this phase.

### 5.2 Screenshot / image attachment (Wave 1)

Detection: Telegram message contains an image attachment.

Flow:
1. Download the image to a temp file.
2. Infer project from the caption (if any). No URL to help, so defaults to `general` often.
3. Call `library-cli save --source-type screenshot --project <inferred> --user-note <caption> --media-temp-path <temp> --media-type image --media-mime <mime> --queue-processor "screenshot needs OCR"`. The CLI:
   - inserts the `library_items` row,
   - generates the final path using the new id (§4.2),
   - moves the temp file to `$LIBRARY_ROOT/<project>/screenshots/YYYYMMDD-HHMM_<id>_<slug>.<ext>`,
   - inserts `item_media` with that path,
   - queues the processor mission_task.
4. **Do NOT** set `--enriched`. OCR is the Processor's job (Phase 3). `enriched_at` stays NULL.
5. Reply with `SAVE_SCREENSHOT` template.

### 5.3 Free-form text note (Wave 1)

Detection: Telegram message is just text, no URL, no attachment.

Flow:
1. `library-cli save --source-type note --project <inferred> --user-note <text> --content content_type=user_note,text=<text> --enriched`.
2. Reply: `"#43 (general) — <first 40 chars of note>"`.

Shortest path. No Playwright, no scraping, no mission_task for Processor (nothing to enrich).

### 5.4 File (PDF / video / audio) (Wave 2)

Detection: Telegram message contains a non-image document attachment.

Flow (mirrors screenshot):
1. Download to temp.
2. Determine `--media-type` from mime: `application/pdf` → `pdf`, `video/*` → `video`, `audio/*` → `audio`, else `other`. The CLI routes to the matching bucket (`pdfs/`, `videos/`, `audio/`, `other/`) based on `--media-type`.
3. `library-cli save --source-type file --project <inferred> --user-note <caption> --media-temp-path <temp> --media-type <t> --media-mime <mime> --queue-processor "file needs text extraction"`.
4. `enriched_at = NULL` (no `--enriched` flag).
5. Reply with `SAVE_FILE` template.

### 5.5 Voice note (Wave 3)

Detection: Telegram message is a voice message (`voice` MIME).

Flow:
1. Download the audio to a temp file.
2. `library-cli save --source-type voice --project general --media-temp-path <temp> --media-type audio --media-mime audio/ogg --queue-processor "voice needs transcription"`. No user_note — the user didn't type one.
3. `enriched_at = NULL`.
4. Reply with `SAVE_VOICE` template.

The Processor (Phase 3) uses the existing Groq Whisper pipeline in `src/voice.ts` for transcription.

### 5.6 Forwarded Telegram message (Wave 3)

Detection: Telegram message has a `forward_from` or `forward_from_chat` field.

Flow:
1. Extract the text + any attachment from the forwarded message.
2. If the forwarded message contained a URL → treat as URL flow (§5.1) with `source_type = forwarded` (not the domain-inferred one, so you know it came via forward).
3. If the forwarded message was just text → save as `source_type = forwarded` with that text in `user_note` + `item_content` as `content_type=user_note`. Set `author` to the original Telegram sender if available.
4. Reply matches the URL / text flow with the word "forwarded" replaced.

### 5.7 Message with URL + extra text

The URL flow wins. The extra text goes into `user_note`. If the user typed `"check this out, for pure_bliss"`, memobot honors `pure_bliss` as an explicit project hint (overrides keyword inference) and saves the note verbatim.

Explicit project override syntax: any `for <project-name>` (case-insensitive) in the user text. If `<project-name>` is not one of the 4 allowed projects, ignore the hint.

### 5.8 Empty / sticker-only / emoji-only

No DB write. Reply: `"Nothing to save — send a URL, file, or note."`

## 6. Slash Commands (Ops Surface)

Memobot recognizes the following as commands, not as content to save. Ordered roughly by expected frequency.

### `/find <query>` — search

Calls `library-cli find <query>`. Returns top 10 hits as a numbered list:
```
1. #42 (pure_bliss) tiktok — How I brew water kefir
   https://tiktok.com/...
2. #37 (octohive) reddit — My octo died after...
   https://reddit.com/r/...
...
```

Supports filters: `/find kefir project:pure_bliss`, `/find viral since:7d`. Parsed by memobot, forwarded as CLI flags.

### `/recent [N]` — last N saves

Default 10. Same format as `/find` results.

### `/open <id>` — full view of one item

Returns:
```
#42 (pure_bliss)  captured 2026-04-23 15:12
Source: tiktok @brewlife
Title: How I brew water kefir
URL: https://...
Summary: Maker fermenting water kefir at home.
Media: 1 image (screenshots/20260423-1512_42_kefir.png)
Tags: kefir (topic), @brewlife (person), #waterkefir (hashtag)
Related: 3 items (use /open <id> to see each)
Reviewed: no  Pinned: no
```

### `/delete <id>`

Prompts once for confirmation: "Delete #42? Reply YES to confirm." Reduces risk of accidental taps.

### `/project <id> <name>`

Reassigns. E.g. `/project 42 octohive`. Rejects unknown project names.

### `/pin <id>` / `/unpin <id>`

Toggles the `pinned` flag.

### `/reviewed <id>`

Sets `reviewed_at = NOW`. Useful for marking "I've looked at this, don't surface it in unreviewed lists."

### `/reenrich <id>`

Nulls `enriched_at` and drops a mission_task for Processor. Useful if the original scrape was bad.

### `/help`

Lists the commands with one-line descriptions.

## 7. Reply Format Templates (Source of Truth)

Every reply memobot sends follows one of these templates. Kept short, Telegram-friendly, always includes the DB id.

```
SAVE_URL_OK     = "#{id} ({project}) — {title}\n{summary}\n{url}"
SAVE_URL_FAIL   = "Saved #{id} — couldn't scrape, will retry. {url}"
SAVE_NOTE_OK    = "#{id} ({project}) — {first_40_chars_of_note}"
SAVE_SCREENSHOT = "#{id} ({project}) — {caption or filename}\nOCR coming when processor runs."
SAVE_FILE       = "#{id} ({project}) — {filename}\nExtraction coming when processor runs."
SAVE_VOICE      = "#{id} ({project}) — voice note saved. Transcript coming."

DUPLICATE       = "Already have this as #{id}, saved {relative_age}. Note appended."

ERR_NOTHING     = "Nothing to save — send a URL, file, or note."
ERR_DRIVE_OFF   = "Flash drive offline, queued #{id} for save when it's back."
ERR_DB_WRITE    = "Save failed: {error}. Try again."
```

Where `{relative_age}` is human-friendly: `"3 weeks ago"`, `"yesterday"`, `"an hour ago"`.

The CLAUDE.md system prompt contains all of these verbatim so Haiku doesn't improvise. Deviations from the templates count as bugs.

## 8. Memobot CLAUDE.md Structure

The agent config file at `~/.claudeclaw/agents/memobot/CLAUDE.md` gets fully rewritten from the blank `_template`. Sections:

1. **Role** (1 short paragraph): you are the ClaudeClaw research library collector.
2. **Environment**: project root via `git rev-parse --show-toplevel`, DB path, `$LIBRARY_ROOT`.
3. **Save flow per input type** (pointers back to §5 of this spec, but flattened into actionable prompts for Haiku).
4. **Reply templates** (verbatim, copied from §7).
5. **Slash commands** (verbatim, copied from §6).
6. **Project inference hints** (the keyword buckets from §4.4).
7. **Guardrails:**
   - Never write raw SQL — always use `library-cli.js`.
   - Never commit secrets.
   - Never delete or /project without the user's explicit command.
   - Stay brief in replies. Summary = 1-2 sentences max.
8. **Hive mind**: log a `hive_mind` row for each save (see existing template).

Target CLAUDE.md length: ~200 lines. Shorter than research/comms CLAUDE.md would be ideal but it's OK to be a little longer because memobot's behavior surface is larger.

## 9. Failure Modes

| Scenario | Memobot behavior |
|---|---|
| Playwright timeout or navigation fail | Save with `title = url`, `enriched_at = NULL`. Reply with `SAVE_URL_FAIL` template. Processor will retry. |
| URL resolves to 404 | Same as above — still save the row; the user has context. |
| Flash drive unmounted, URL item | Save proceeds normally (no file write needed). |
| Flash drive unmounted, file item | Do NOT save to DB. Drop a `mission_task` for memobot itself to retry when the drive is back. Write a `hive_mind` warning. Reply with `ERR_DRIVE_OFF`. |
| Telegram file > 50 MB | Telegram rejects at receive; memobot never sees it. No action. |
| DB write fails (disk full, lock contention) | Reply with `ERR_DB_WRITE`. Log error to hive_mind. Retry after a 5s backoff on lock contention. |
| Dedup detects duplicate | Append user text to existing `user_note` with `\n---\n` separator. Bump `last_seen_at`. Reply with `DUPLICATE` template. |
| Haiku produces invalid command / garbled reply | Hard limit on retries. If memobot's response does not parse as a valid action within 3 attempts, log to hive_mind, send a minimal fallback reply `"Saved #{id}. Something went wrong in summary generation."` |
| Drive fills up | Outside Phase 2 scope — handled by a monitoring task in a later phase. |

## 10. Implementation Waves

The spec is one coherent design. The implementation plan ships in three waves.

**Wave 1:** URLs + free-form text + screenshots.
- Build `library.ts` + `library-cli.ts` + their tests.
- Write memobot's CLAUDE.md covering only the §5.1 (URL), §5.2 (screenshot), and §5.3 (text) flows plus all 8 slash commands.
- Wave 1 replies cover `SAVE_URL_*`, `SAVE_NOTE_OK`, `SAVE_SCREENSHOT`, `DUPLICATE`, `ERR_*`.
- After Wave 1 ships: real URLs and text notes land in the DB. Screenshots save files to disk with `enriched_at = NULL`.

**Wave 2:** Other file types (PDF, video, audio).
- Extends `library-cli save` to accept the new mime families (the data path is identical to screenshots; just routing).
- Extends CLAUDE.md §5.4 flow.
- Adds `SAVE_FILE` template.

**Wave 3:** Voice notes + forwarded messages.
- Voice: download + save + queue transcription task.
- Forwarded: detect `forward_from`, handle text and attachments.
- Extends CLAUDE.md §5.5 and §5.6 flows.

Each wave is independently shippable. Wave boundaries are plan-level; this spec does not re-decompose between them.

## 11. Success Criteria

Phase 2 is done when:

- [ ] `src/library.ts` exists with every function signature in §4.1, fully tested.
- [ ] `src/library-cli.ts` exists with every subcommand in §4.2, fully tested.
- [ ] Memobot's `CLAUDE.md` at `~/.claudeclaw/agents/memobot/CLAUDE.md` is rewritten per §8.
- [ ] Sending a URL to `@MemoVizBot` results in a `library_items` row with scraped title/summary and a reply matching `SAVE_URL_OK`.
- [ ] Sending the same URL a second time results in `DUPLICATE` reply and an appended `user_note`.
- [ ] Sending a screenshot results in a file at `$LIBRARY_ROOT/<project>/screenshots/...`, a `library_items` row with `enriched_at = NULL`, and a `mission_tasks` row queued for the Processor agent.
- [ ] Sending a free-form text note saves as `source_type=note` with `enriched_at` set.
- [ ] `/find <query>` returns FTS5-matched results.
- [ ] `/delete <id>` prompts for YES confirmation and cascades on confirm.
- [ ] `/project <id> <name>`, `/pin`, `/unpin`, `/reviewed`, `/reenrich`, `/open`, `/recent`, `/help` all behave per §6.
- [ ] With flash drive unmounted, file saves return the `ERR_DRIVE_OFF` reply and queue a retry task.
- [ ] Wave boundaries are honored — Wave 1 covers the URL / text / screenshot success criteria above; Waves 2 and 3 extend to file types and voice/forwarded.

## 12. Assumptions & Open Questions

**Assumptions locked in:**
- Memobot runs on Haiku 4.5 (already activated, confirmed live).
- Playwright MCP is available in memobot's environment (confirmed — user already saw it work).
- Every existing ClaudeClaw invariant applies: `PROJECT_ROOT` via `git rev-parse`, `store/claudeclaw.db` is the DB, `hive_mind` for cross-agent activity.
- `$LIBRARY_ROOT` exists at `/Volumes/ClaudeClaw/claudeclaw-library/` (Phase 1 confirmed).
- Keyword-based project inference is acceptably correct — misclassifications are recoverable via FTS5 keyword search + `/project` reassignment.

**Deferred to later phases:**
- OCR on screenshots (Phase 3).
- PDF/video text extraction (Phase 3).
- Voice transcription (Phase 3).
- Semantic topic tagging + item relationships + embeddings (Phase 4).
- Virality scoring + suggestion generation (Phase 5).
- Optional Google Drive mirror (later extension).
- Dashboard Library panel (separate spec after Phase 5).

**Known open questions:**
- **Concurrency under spam.** Memobot's Claude Code SDK session is serial. If 10 URLs arrive at once, they queue and each takes 10-20s. For now this is acceptable; if it becomes painful we add an explicit "fast-ack" path later.
- **Exact URL-shortener domain list.** §4.3 lists four common ones. New ones can be added by appending to a single constant in `library.ts`.
- **`last_seen_at_before` on dedup.** Returned by `insertItem` so memobot can render "saved 3 weeks ago" in the `DUPLICATE` reply. If this turns out awkward, fall back to "already have this" without the age.

---

## Next Step

After this design is approved, the implementation plan is drafted via the **writing-plans** skill. The plan will decompose into tasks per wave and per file, following the same TDD + subagent-driven-development cadence used in Phase 1.
