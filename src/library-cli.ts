#!/usr/bin/env node
/**
 * ClaudeClaw Research Library CLI
 *
 * Used by memobot and future agents to read/write the library tables.
 * Every subcommand outputs JSON to stdout on success, or errors to
 * stderr with a non-zero exit code.
 */

import { initDatabase } from './db.js';
import { canonicalizeUrl, urlHash, _getTestDb } from './library.js';
import type { SourceType, Project } from './library.js';

initDatabase();

const argv = process.argv.slice(2);

function usage(): void {
  console.log(`Usage: library-cli <subcommand> [args]

Subcommands:
  check-url <url>                Check if a URL is already saved (JSON output).
  save [flags]                   Save a new library item. See --help save.
  find <query> [--project X]     Full-text search via FTS5.
  open <id>                      Show full item with satellites.
  recent [--limit N]             List most recent saves (default 10).
  delete <id>                    Delete an item (cascades).
  update <id> [flags]            Update project/pinned/reviewed/reenrich.
  help                           Show this help.

Examples:
  library-cli check-url "https://tiktok.com/@x/video/1"
  library-cli save --source-type article --url https://... --title "..." --enriched
  library-cli find kefir --project pure_bliss
  library-cli open 42`);
}

if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
  usage();
  process.exit(0);
}

const [subcommand, ...rest] = argv;

function parseFlags(flagArgs: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = flagArgs[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

async function run(): Promise<void> {
  switch (subcommand) {
    case 'check-url': {
      const url = rest[0];
      if (!url || url.startsWith('--')) {
        console.error('Error: check-url requires a url argument');
        console.error('Usage: library-cli check-url <url>');
        process.exit(1);
      }
      const canonical = canonicalizeUrl(url);
      const hash = urlHash(canonical);
      const db = _getTestDb();
      const existing = db.prepare(
        `SELECT id, captured_at FROM library_items WHERE url_hash = ?`
      ).get(hash) as { id: number; captured_at: number } | undefined;

      if (existing) {
        console.log(JSON.stringify({
          is_duplicate: true,
          existing_id: existing.id,
          existing_captured_at: existing.captured_at,
          canonical,
        }));
      } else {
        console.log(JSON.stringify({ is_duplicate: false, canonical }));
      }
      break;
    }

    case 'save': {
      const flags = parseFlags(rest);

      const sourceType = flags['source-type'] as string;
      if (!sourceType) {
        console.error('Error: save requires --source-type');
        process.exit(1);
      }

      const enrichedAt = flags.enriched === true
        ? Math.floor(Date.now() / 1000)
        : undefined;

      const sourceMeta = typeof flags['source-meta'] === 'string'
        ? JSON.parse(flags['source-meta'] as string)
        : undefined;

      const { insertItem, addContent, addTag, queueProcessorTask } = await import('./library.js');

      const result = insertItem({
        source_type: sourceType as SourceType,
        url: typeof flags.url === 'string' ? flags.url : undefined,
        user_note: typeof flags['user-note'] === 'string' ? flags['user-note'] : undefined,
        user_message: typeof flags['user-message'] === 'string' ? flags['user-message'] : undefined,
        project: typeof flags.project === 'string' ? flags.project as Project : undefined,
        title: typeof flags.title === 'string' ? flags.title : undefined,
        author: typeof flags.author === 'string' ? flags.author : undefined,
        source_meta: sourceMeta,
        enriched_at: enrichedAt,
      });

      // Collect repeatable --content and --tag flags (parseFlags only keeps last)
      const allContentFlags: string[] = [];
      const allTagFlags: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--content' && rest[i + 1] !== undefined) allContentFlags.push(rest[i + 1]);
        if (rest[i] === '--tag' && rest[i + 1] !== undefined) allTagFlags.push(rest[i + 1]);
      }

      for (const cSpec of allContentFlags) {
        const parsed = Object.fromEntries(cSpec.split(',').map(kv => {
          const idx = kv.indexOf('=');
          return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
        }));
        addContent(result.id, {
          content_type: parsed.content_type as 'ocr' | 'scraped_summary' | 'transcript' | 'user_note',
          text: parsed.text,
          source_agent: 'memobot',
        });
      }

      for (const tSpec of allTagFlags) {
        const parsed = Object.fromEntries(tSpec.split(',').map(kv => {
          const idx = kv.indexOf('=');
          return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
        }));
        addTag(result.id, {
          tag: parsed.tag,
          tag_type: parsed.tag_type as 'topic' | 'person' | 'brand' | 'hashtag' | 'mood' | 'other',
          source_agent: 'memobot',
        });
      }

      if (typeof flags['queue-processor'] === 'string') {
        queueProcessorTask(result.id, flags['queue-processor'] as string);
      }

      // Handle --media-temp-path: insert library_items first (done above),
      // then move the temp file and insert item_media
      if (typeof flags['media-temp-path'] === 'string') {
        const { LIBRARY_ROOT } = await import('./config.js');
        const { addMedia } = await import('./library.js');
        const fs = await import('fs');
        const path = await import('path');

        const tempPath = flags['media-temp-path'] as string;
        const mediaType = (flags['media-type'] as string) || 'other';
        const mediaMime = (flags['media-mime'] as string) || undefined;

        // Route to subfolder by media type
        const bucket = (
          mediaType === 'image' ? 'screenshots' :
          mediaType === 'pdf' ? 'pdfs' :
          mediaType === 'video' ? 'videos' :
          mediaType === 'audio' ? 'audio' :
          'other'
        );

        // Filename: YYYYMMDD-HHMM_<id>_<slug>.<ext>
        const ts = new Date();
        const datePart = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}`;
        const timePart = `${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}`;
        const slug = ((typeof flags['user-note'] === 'string' ? flags['user-note'] : '') || 'untitled')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'untitled';
        const ext = path.extname(tempPath) || (
          mediaMime === 'image/png' ? '.png' :
          mediaMime === 'image/jpeg' ? '.jpg' :
          mediaMime === 'application/pdf' ? '.pdf' :
          ''
        );
        const finalFilename = `${datePart}-${timePart}_${result.id}_${slug}${ext}`;

        const project = typeof flags.project === 'string' ? flags.project : 'general';
        const relativePath = `${project}/${bucket}/${finalFilename}`;
        const absolutePath = path.join(LIBRARY_ROOT, relativePath);

        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        try {
          fs.renameSync(tempPath, absolutePath);
        } catch (err: unknown) {
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EXDEV') {
            // Cross-device move: copy then delete
            fs.copyFileSync(tempPath, absolutePath);
            fs.unlinkSync(tempPath);
          } else {
            throw err;
          }
        }

        const stats = fs.statSync(absolutePath);

        addMedia(result.id, {
          media_type: mediaType as 'image' | 'video' | 'pdf' | 'audio' | 'other',
          file_path: relativePath,
          storage: 'local',
          mime_type: mediaMime,
          bytes: stats.size,
        });
      }

      console.log(JSON.stringify(result));
      break;
    }

    case 'find': {
      const query = rest[0];
      if (!query || query.startsWith('--')) {
        console.error('Error: find requires a query argument');
        process.exit(1);
      }
      const flags = parseFlags(rest.slice(1));
      const { searchLibrary } = await import('./library.js');
      const results = searchLibrary({
        query,
        project: typeof flags.project === 'string' ? flags.project as Project : undefined,
        limit: typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : 10,
      });
      if (flags.json) {
        console.log(JSON.stringify(results));
      } else {
        for (const r of results) {
          console.log(`#${r.id} (${r.project}) ${r.source_type} - ${r.title ?? r.url ?? '(no title)'}`);
          if (r.snippet) console.log(`  ${r.snippet}`);
        }
      }
      break;
    }

    case 'open': {
      const id = parseInt(rest[0], 10);
      if (isNaN(id)) {
        console.error('Error: open requires a numeric id');
        process.exit(1);
      }
      const { getItem } = await import('./library.js');
      const item = getItem(id);
      if (!item) {
        console.error(`Item ${id} not found`);
        process.exit(1);
      }
      const flags = parseFlags(rest.slice(1));
      if (flags.json) {
        console.log(JSON.stringify(item));
      } else {
        console.log(`#${item.id} (${item.project})  captured ${new Date(item.captured_at * 1000).toISOString()}`);
        console.log(`Source: ${item.source_type} ${item.author ?? ''}`);
        if (item.title) console.log(`Title: ${item.title}`);
        if (item.url) console.log(`URL: ${item.url}`);
        if (item.user_note) console.log(`Note: ${item.user_note}`);
        console.log(`Media: ${item.media.length}, Content: ${item.content.length}, Tags: ${item.tags.length}`);
        console.log(`Reviewed: ${item.reviewed_at ? 'yes' : 'no'}  Pinned: ${item.pinned ? 'yes' : 'no'}`);
      }
      break;
    }

    case 'recent': {
      const flags = parseFlags(rest);
      const { searchLibrary } = await import('./library.js');
      const items = searchLibrary({
        limit: typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : 10,
      });
      if (flags.json) {
        console.log(JSON.stringify(items));
      } else {
        for (const r of items) {
          console.log(`#${r.id} (${r.project}) ${r.source_type} - ${r.title ?? r.url ?? '(no title)'}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      usage();
      process.exit(1);
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
