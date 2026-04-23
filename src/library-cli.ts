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
