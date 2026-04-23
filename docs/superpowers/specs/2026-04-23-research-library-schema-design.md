# Research Library — Data Model & Storage (Phase 1)

**Date:** 2026-04-23
**Status:** Design approved, ready for implementation plan
**Scope:** Phase 1 of 5 in the multi-agent research library build
**Author:** Remy + Stanley

---

## 1. Purpose

Build the foundation for a centralized research library so a future pipeline of four specialized agents (Collector, Processor, Relationship Mapper, Analyst) can populate and mine it.

The library captures items from across the user's research surfaces (tiktok, instagram, facebook, reddit, twitter, youtube, threads, linkedin, generic articles, screenshots, uploaded files, free-form notes, voice notes, and forwarded messages) into a single searchable store.

The primary user goal is **"help me get back to it."** Every item keeps a clickable pointer to the original source (URL or Google Drive file). Full content archiving is explicitly out of scope.

## 2. Scope of This Phase

**In scope:**
- SQLite schema (new tables added to existing `store/claudeclaw.db` via a migration).
- Google Drive folder layout that the Collector agent will target in Phase 2.
- Lifecycle model for how later agents know what to work on.
- Indexing + full-text search strategy.

**Out of scope (covered in later specs):**
- Phase 2: Collector agent (Playwright scraping, Telegram ingestion UX, Drive upload flow).
- Phase 3: Processor agent (OCR, file text extraction, transcripts).
- Phase 4: Relationship agent (embeddings, typed relationships, tags).
- Phase 5: Analyst agent (virality scoring, topic suggestions, review queue).

## 3. Architecture at a Glance

```
┌──────────────────────────────────────────────────────────────┐
│                     store/claudeclaw.db                      │
│                                                              │
│  EXISTING:   sessions, memories, hive_mind, mission_tasks,   │
│              conversation_log, embeddings, ... (20+ tables)  │
│                                                              │
│  NEW (this spec):                                            │
│    library_items       ← the canonical item row             │
│    item_media          ← attached files (Drive refs)         │
│    item_content        ← searchable text (OCR/scrape/note)   │
│    item_tags           ← typed tags (topic/person/brand/...) │
│    item_relationships  ← typed links between items           │
│    item_embeddings     ← vector blobs for semantic search    │
│    item_content_fts    ← FTS5 virtual table over content     │
└──────────────────────────────────────────────────────────────┘

                          ▲
                          │ reads/writes
                          │
    ┌─────────────┬───────┴───────┬─────────────┬─────────────┐
    │  Collector  │   Processor   │ Relationship│   Analyst   │
    │  (Phase 2)  │   (Phase 3)   │  (Phase 4)  │  (Phase 5)  │
    └─────────────┴───────────────┴─────────────┴─────────────┘

                  Flash drive: /Volumes/ClaudeClaw/claudeclaw-library/
                    pure_bliss/  octohive/  personal/  general/
                  (Google Drive mirror optional, per-item.)
```

Inter-agent coordination reuses **existing** infrastructure:
- `mission_tasks` queue for real-time handoff (Collector drops task for Processor, etc.).
- `hive_mind` table for cross-agent activity feed.
- `src/scheduler.ts` + `schedule-cli.ts` for periodic sweeps as a fallback when a handoff is missed.
- `src/embeddings.ts` reused by the Relationship agent.

Files live on an external SSD (`/Volumes/ClaudeClaw`) that stays mounted on remy. The existing Cloudflare tunnel exposes the dashboard for phone access, so flash-drive-only storage does not cost off-network accessibility.

## 4. Data Model

### 4.1 `library_items` — canonical row

One row per saved item. Everything else hangs off this.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | autoincrement |
| `agent_id` | TEXT | which agent created this row (default `collector`) |
| `chat_id` | TEXT | Telegram chat it came from (for multi-user future) |
| `source_type` | TEXT NOT NULL CHECK | enum, see §4.1.1 |
| `url` | TEXT | nullable (notes/voice/screenshots may have no URL) |
| `url_hash` | TEXT | SHA1 of canonicalized URL, nullable, UNIQUE INDEX |
| `title` | TEXT | scraped or user-supplied |
| `author` | TEXT | @handle, creator name, or byline |
| `captured_at` | INTEGER | unix ts, set at ingest |
| `last_seen_at` | INTEGER | bumped when dupe is re-ingested |
| `project` | TEXT NOT NULL | `pure_bliss` \| `octohive` \| `personal` \| `general` |
| `user_note` | TEXT | anything the user typed alongside the save |
| `source_meta` | TEXT | JSON blob for source-specific fields (views, upvotes, subreddit, hashtags) |
| `reviewed_at` | INTEGER | nullable; set when user marks "I've looked at this" |
| `pinned` | INTEGER | 0/1; pins to top of dashboard |
| `enriched_at` | INTEGER | Processor agent sets this when OCR/scrape is done |
| `related_at` | INTEGER | Relationship agent sets this when tags/relationships written |
| `analyzed_at` | INTEGER | Analyst agent sets this when virality scored |
| `created_at` | INTEGER | row insert time |

**Rationale for nullable lifecycle timestamps:** a NULL column means "this stage hasn't run yet," which gives each agent a trivial "what's my work?" query (`WHERE enriched_at IS NULL`) and gives the dashboard live pipeline counters.

#### 4.1.1 Allowed `source_type` values

```
tiktok, instagram, facebook, reddit, twitter, youtube, threads,
linkedin, article, screenshot, file, note, voice, forwarded
```

The Collector defaults to `article` when a URL's domain is unrecognized, and the user can override via the dashboard or a `/retype` Telegram command (Phase 2 spec).

#### 4.1.2 Allowed `project` values

Start with four: `pure_bliss`, `octohive`, `personal`, `general`. The Collector picks based on keywords in the user's message, recent project context, or asks. User can reassign from the dashboard. Adding a new project is a config change, not a migration.

#### 4.1.3 Dedup behavior

`url_hash` has a UNIQUE INDEX (NULLs allowed, so note/voice/screenshot items without URLs are exempt). If an item with the same hash already exists:
- `last_seen_at` is updated.
- `user_note` is **appended** (with a `\n---\n` separator), not overwritten.
- Bot replies "already have this, updated your note. /open <id> to view."

URL canonicalization rules (implemented by the Collector in Phase 2, spec only mandates the schema supports it):
- Lowercased scheme + host.
- Query params from a known-noise list stripped (`utm_*`, `fbclid`, `igshid`, `ref`, `si`).
- Trailing slash normalized.
- Shortener domains resolved before hashing where possible.

### 4.2 `item_media` — file attachments

One item can have multiple media (e.g. a reddit post with 3 screenshots). Flash drive is the primary store; Google Drive is optional per-item cloud mirror.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `item_id` | INTEGER NOT NULL | FK → library_items.id ON DELETE CASCADE |
| `media_type` | TEXT NOT NULL | `image` \| `video` \| `pdf` \| `audio` \| `other` |
| `file_path` | TEXT | path relative to `$LIBRARY_ROOT` (e.g. `pure_bliss/screenshots/20260423-1512_42_kefir.png`). Required for local-stored items. |
| `storage` | TEXT NOT NULL | `local` \| `drive` \| `both` (describes where the file actually lives) |
| `drive_file_id` | TEXT | nullable; Google Drive file ID when `storage` includes `drive` |
| `drive_url` | TEXT | nullable; clickable Drive link |
| `mime_type` | TEXT | |
| `bytes` | INTEGER | |
| `ocr_text` | TEXT | nullable; Processor populates per-media |
| `created_at` | INTEGER | |

`file_path` is stored **relative** to `$LIBRARY_ROOT` so the library is portable (rename or remount the drive without rewriting rows). The dashboard and any file-serving code resolves to an absolute path at runtime.

### 4.3 `item_content` — searchable text

Produced by Processor (OCR, scrape summary, transcript) and by the user (their note). Multiple rows per item are fine.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `item_id` | INTEGER NOT NULL | FK → library_items.id ON DELETE CASCADE |
| `content_type` | TEXT NOT NULL CHECK | `ocr` \| `scraped_summary` \| `transcript` \| `user_note` |
| `text` | TEXT NOT NULL | |
| `source_agent` | TEXT | which agent wrote it |
| `token_count` | INTEGER | nullable; useful for cost tracking later |
| `created_at` | INTEGER | |

A shadow **FTS5 virtual table** `item_content_fts` indexes `text` with `item_id` and `content_type` columns unindexed. Triggers keep it in sync on insert/update/delete. Full-text queries from dashboard and Telegram hit the virtual table, then join back to `library_items`.

### 4.4 `item_tags` — typed tags

| Column | Type | Notes |
|---|---|---|
| `item_id` | INTEGER NOT NULL | FK → library_items.id ON DELETE CASCADE |
| `tag` | TEXT NOT NULL | lowercased, e.g. `kefir`, `@brewlife`, `#waterkefir` |
| `tag_type` | TEXT NOT NULL CHECK | `topic` \| `person` \| `brand` \| `hashtag` \| `mood` \| `other` |
| `confidence` | REAL | 0–1; NULL = manual/user-added |
| `source_agent` | TEXT | which agent wrote it |
| `created_at` | INTEGER | |
| PRIMARY KEY | | (`item_id`, `tag`, `tag_type`) |

Typed tags let the dashboard filter "show me everyone tagged as a `person` with viral items" separately from "show me everything tagged `topic:kefir`."

### 4.5 `item_relationships` — typed links between items

Written by the Relationship agent.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `source_item_id` | INTEGER NOT NULL | FK → library_items.id ON DELETE CASCADE |
| `target_item_id` | INTEGER NOT NULL | FK → library_items.id ON DELETE CASCADE |
| `relation_type` | TEXT NOT NULL CHECK | `same_topic` \| `same_author` \| `similar_semantic` \| `cites` \| `manual_link` \| `duplicate` |
| `similarity_score` | REAL | 0–1; for semantic links |
| `reason` | TEXT | short human-readable explanation |
| `source_agent` | TEXT | |
| `created_at` | INTEGER | |
| UNIQUE | | (`source_item_id`, `target_item_id`, `relation_type`) |

Relationships are directional for the schema's simplicity (cheaper constraint check than symmetric). The Relationship agent writes both directions when a link is truly symmetric (e.g. `same_topic`).

### 4.6 `item_embeddings` — vector storage

Mirrors the existing `src/embeddings.ts` table conventions.

| Column | Type | Notes |
|---|---|---|
| `item_id` | INTEGER PK | FK → library_items.id ON DELETE CASCADE |
| `model` | TEXT NOT NULL | e.g. `gemini-embedding-exp-03-07` |
| `dimensions` | INTEGER NOT NULL | |
| `embedding` | BLOB NOT NULL | packed float32s |
| `source_text_hash` | TEXT | so we can skip re-embedding unchanged content |
| `created_at` | INTEGER | |

Embeddings are computed over the concatenated `item_content.text` rows for an item. The Relationship agent uses cosine similarity against this table to populate `similar_semantic` relationships.

### 4.7 Indexes

```sql
CREATE UNIQUE INDEX idx_library_items_url_hash   ON library_items(url_hash) WHERE url_hash IS NOT NULL;
CREATE INDEX idx_library_items_project            ON library_items(project);
CREATE INDEX idx_library_items_source_type        ON library_items(source_type);
CREATE INDEX idx_library_items_captured_at        ON library_items(captured_at DESC);
CREATE INDEX idx_library_items_reviewed_at        ON library_items(reviewed_at);
CREATE INDEX idx_library_items_enriched_null      ON library_items(id) WHERE enriched_at IS NULL;
CREATE INDEX idx_library_items_related_null       ON library_items(id) WHERE related_at  IS NULL;
CREATE INDEX idx_library_items_analyzed_null      ON library_items(id) WHERE analyzed_at IS NULL;

CREATE INDEX idx_item_media_item_id               ON item_media(item_id);
CREATE INDEX idx_item_content_item_id             ON item_content(item_id);
CREATE INDEX idx_item_tags_tag                    ON item_tags(tag, tag_type);
CREATE INDEX idx_item_relationships_source        ON item_relationships(source_item_id);
CREATE INDEX idx_item_relationships_target        ON item_relationships(target_item_id);
```

Partial indexes on the NULL lifecycle columns keep the agent sweep queries fast as the table grows.

## 5. Flash Drive Storage Layout

The Collector agent writes any files, screenshots, or captured videos to a dedicated library root on the attached SSD. Always-on + already-mounted means files are immediately readable by every other agent and by the dashboard.

**Library root env var (required, read from `.env`):**
```
LIBRARY_ROOT=/Volumes/ClaudeClaw/claudeclaw-library
```

**Physical layout (exists on disk as of 2026-04-23):**

```
/Volumes/ClaudeClaw/claudeclaw-library/
├── pure_bliss/
│   ├── screenshots/
│   ├── pdfs/
│   ├── videos/
│   ├── audio/
│   └── other/
├── octohive/
│   └── (same 5 buckets)
├── personal/
│   └── (same 5 buckets)
└── general/
    └── (same 5 buckets)
```

Mapping rules the Collector enforces:
- The item's `project` column determines the top-level folder.
- The `media_type` determines the subfolder.
- Filenames follow `YYYYMMDD-HHMM_<item_id>_<slug>.<ext>` so they sort chronologically and remain traceable to a DB row.
- `item_media.file_path` stores the path **relative** to `$LIBRARY_ROOT`, never absolute, so moving or renaming the drive only requires updating the env var.

**Phone access:** the existing Cloudflare tunnel already installed on remy exposes the dashboard publicly (token-authenticated). The dashboard's future Library panel serves previews and originals directly from `$LIBRARY_ROOT`, so there is no off-device accessibility loss from skipping Google Drive.

**Google Drive is an optional per-item mirror.** Use cases:
- Sharing a PDF with someone outside ClaudeClaw.
- Belt-and-suspenders backup for a specific high-value item.

When `item_media.storage = 'drive'` or `'both'`, the Collector (Phase 2) uploads via the existing Google Drive MCP auth and records `drive_file_id` + `drive_url`. Google Drive is **never** the primary store.

**Drive availability handling:** if `$LIBRARY_ROOT` is unreachable (drive unmounted, reboot in progress), the Collector:
- Returns an error on ingest attempts that require file writes.
- Writes a `hive_mind` warning so the dashboard surfaces "flash drive offline."
- Queues the Telegram message for retry once the drive comes back (via `mission_tasks`).

## 6. Lifecycle Model

Hybrid push/pull so the pipeline is reactive when healthy and self-healing when not.

**Push (real-time, ~60s latency):** when any agent finishes writing its output, it drops a `mission_task` for the next agent. The existing `mission_tasks` queue + dispatcher handles delivery.

**Pull (periodic sweep, fallback):** each agent has a scheduled job (via `schedule-cli`) that runs every 15 minutes and looks for items where its stage timestamp is NULL. This catches anything missed by the push path (crashes, missed handoffs, backfills).

Stage transitions:

```
INSERT into library_items
       │
       ▼
  enriched_at IS NULL  ─────► Processor sets enriched_at, writes item_media.ocr_text + item_content rows
       │
       ▼
  related_at IS NULL   ─────► Relationship agent writes item_tags, item_relationships, item_embeddings; sets related_at
       │
       ▼
  analyzed_at IS NULL  ─────► Analyst agent writes virality/suggestion rows (schema TBD in Phase 5); sets analyzed_at
```

Any stage can be re-run by nulling the relevant timestamp (manual maintenance command or dashboard action).

## 7. Migration Plan

Single forward migration file added under `migrations/` (or inlined into `src/db.ts` following existing pattern — determined by the implementation plan):

1. Create the 6 new tables + 1 FTS5 virtual table + FTS triggers.
2. Create the indexes listed in §4.7.
3. No backfill required (all tables start empty).
4. Versioned in `migrations/version.json`.

Tested against a fresh DB **and** against a production DB with existing tables. Rollback = drop the 7 new tables; no impact to existing tables.

## 8. Dashboard Surface (skeleton only in this phase)

The existing Mission Control dashboard gets a new **Library** panel in a later phase. This spec only guarantees the schema supports what the panel will need:

- List view filtered by project, source_type, review state, date range.
- FTS search bar backed by `item_content_fts`.
- Detail view showing all `item_media`, all `item_content`, all `item_tags`, all `item_relationships` for a given item.
- Pipeline counters (`enriched_at IS NULL`, etc.) rendered from `library_items` directly.

No dashboard code is written in this phase.

## 9. Success Criteria

Phase 1 is done when:
- [ ] Migration runs cleanly on a fresh install and on the existing `store/claudeclaw.db`.
- [ ] All 6 tables + FTS5 virtual table exist with the columns and constraints defined above.
- [ ] All indexes in §4.7 exist.
- [ ] A round-trip test inserts a `library_items` row, attaches `item_media` + `item_content`, writes tags, writes a relationship to a second item, writes an embedding blob, and round-trips every field without loss.
- [ ] FTS5 triggers verified: inserting into `item_content` makes the row searchable via `item_content_fts`; updates and deletes propagate.
- [ ] Flash drive folder structure exists at `$LIBRARY_ROOT` and is documented (already created on `/Volumes/ClaudeClaw/claudeclaw-library`).
- [ ] `.env.example` updated with `LIBRARY_ROOT=/Volumes/ClaudeClaw/claudeclaw-library`.
- [ ] Optional Google Drive mirror requirements (OAuth scopes) noted for Phase 2.
- [ ] `docs/` includes a short reference of every table's purpose linked from the main README.

## 10. Assumptions & Open Questions

**Assumptions locked in:**
- Flash drive (`/Volumes/ClaudeClaw/claudeclaw-library`) is the primary file store. Always-on, 1.8 TB capacity.
- Google Drive is an optional per-item mirror only, never the primary store.
- Dashboard accessible off-network via existing Cloudflare tunnel + token auth.
- SQLite on disk, shared DB file (`store/claudeclaw.db`).
- Embeddings model reused from `src/embeddings.ts` defaults.
- Multi-user / multi-chat support is out of scope; `chat_id` captured for future use but no isolation logic.

**Open questions deferred to later phases:**
- Exact virality scoring formula (Phase 5).
- Whether relationships should eventually promote to a first-class `entities` table (Phase 4+).
- Whether to support private items / encryption-at-rest (security phase, not scoped).
- Retention policy for `item_media.local_cache_path` (pruning strategy).

---

## Next Step

After this design is approved, the implementation plan is drafted via the **writing-plans** skill. Subsequent phases (Collector, Processor, Relationship, Analyst) each get their own design + plan cycle.
