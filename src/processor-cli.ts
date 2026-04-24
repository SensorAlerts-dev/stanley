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
