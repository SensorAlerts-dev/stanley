import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PROJECT_ROOT, 'dist', 'library-cli.js');

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf-8' });
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

describe('library-cli help', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      execFileSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
  }, 60000);

  it('prints usage with no args', () => {
    const { stdout, exitCode } = runCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('library-cli');
    expect(stdout).toContain('save');
    expect(stdout).toContain('find');
    expect(stdout).toContain('check-url');
  });

  it('prints usage on --help', () => {
    const { stdout, exitCode } = runCli(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('library-cli');
  });
});

describe('library-cli check-url', () => {
  it('returns is_duplicate: false for unknown url', () => {
    const { stdout, exitCode } = runCli(['check-url', 'https://example.com/unknown-url-' + Date.now()]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.is_duplicate).toBe(false);
  });

  it('exits non-zero on missing URL', () => {
    const { exitCode, stderr } = runCli(['check-url']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('url');
  });
});

describe('library-cli save (no media)', () => {
  it('saves a URL item and returns id in JSON', () => {
    const url = 'https://example.com/save-test-' + Date.now();
    const { stdout, exitCode } = runCli([
      'save',
      '--source-type', 'article',
      '--url', url,
      '--title', 'My Article',
    ]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.id).toBeGreaterThan(0);
    expect(out.is_duplicate).toBe(false);
  });

  it('saving duplicate URL returns is_duplicate with existing id', () => {
    const url = 'https://example.com/dupe-' + Date.now();
    const first = runCli(['save', '--source-type', 'article', '--url', url]);
    const firstOut = JSON.parse(first.stdout);
    const second = runCli(['save', '--source-type', 'article', '--url', url, '--user-note', 'second save']);
    const secondOut = JSON.parse(second.stdout);
    expect(secondOut.is_duplicate).toBe(true);
    expect(secondOut.id).toBe(firstOut.id);
  });

  it('save without url (note type) works', () => {
    const { stdout, exitCode } = runCli([
      'save',
      '--source-type', 'note',
      '--user-note', 'hello from CLI test',
    ]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.id).toBeGreaterThan(0);
  });

  it('save with --tag flag adds a tag row', async () => {
    const { stdout } = runCli([
      'save',
      '--source-type', 'tiktok',
      '--url', 'https://tiktok.com/@x/test-' + Date.now(),
      '--tag', 'tag=@testcreator,tag_type=person',
    ]);
    const out = JSON.parse(stdout);
    expect(out.id).toBeGreaterThan(0);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'), { readonly: true });
    const tags = db.prepare(`SELECT tag FROM item_tags WHERE item_id = ?`).all(out.id) as Array<{ tag: string }>;
    expect(tags.map(t => t.tag)).toContain('@testcreator');
    db.close();
  });

  it('save with --content flag adds a content row', async () => {
    const { stdout } = runCli([
      'save',
      '--source-type', 'article',
      '--url', 'https://example.com/content-test-' + Date.now(),
      '--content', 'content_type=scraped_summary,text=A brief summary of the article',
    ]);
    const out = JSON.parse(stdout);
    expect(out.id).toBeGreaterThan(0);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'), { readonly: true });
    const rows = db.prepare(`SELECT text FROM item_content WHERE item_id = ?`).all(out.id) as Array<{ text: string }>;
    expect(rows.map(r => r.text)).toContain('A brief summary of the article');
    db.close();
  });

  it('save with --queue-processor creates mission_task', async () => {
    const { stdout } = runCli([
      'save',
      '--source-type', 'screenshot',
      '--user-note', 'test screenshot caption',
      '--queue-processor', 'screenshot needs OCR',
    ]);
    const out = JSON.parse(stdout);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'), { readonly: true });
    const tasks = db.prepare(`SELECT prompt FROM mission_tasks WHERE assigned_agent = 'processor' AND prompt LIKE ?`).all('%' + out.id + '%') as Array<{ prompt: string }>;
    expect(tasks.length).toBeGreaterThan(0);
    db.close();
  });

  it('save with --enriched flag sets enriched_at', async () => {
    const url = 'https://example.com/enriched-' + Date.now();
    const { stdout } = runCli([
      'save',
      '--source-type', 'article',
      '--url', url,
      '--enriched',
    ]);
    const out = JSON.parse(stdout);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'), { readonly: true });
    const row = db.prepare(`SELECT enriched_at FROM library_items WHERE id = ?`).get(out.id) as { enriched_at: number | null };
    expect(row.enriched_at).toBeGreaterThan(0);
    db.close();
  });
});

describe('library-cli save with --media-temp-path', () => {
  it('moves temp file to $LIBRARY_ROOT and inserts item_media row', async () => {
    // Create a temp fake PNG
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'libtest-'));
    const tempFile = path.join(tmp, 'test-image.png');
    fs.writeFileSync(tempFile, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

    const { stdout, exitCode } = runCli([
      'save',
      '--source-type', 'screenshot',
      '--project', 'general',
      '--user-note', 'test shot',
      '--media-temp-path', tempFile,
      '--media-type', 'image',
      '--media-mime', 'image/png',
    ]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.id).toBeGreaterThan(0);

    expect(fs.existsSync(tempFile)).toBe(false);  // moved

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'), { readonly: true });
    const media = db.prepare(`SELECT file_path, media_type, storage FROM item_media WHERE item_id = ?`).get(out.id) as { file_path: string; media_type: string; storage: string };
    expect(media.media_type).toBe('image');
    expect(media.storage).toBe('local');
    expect(media.file_path).toMatch(/^general\/screenshots\/\d{8}-\d{4}_\d+_.+\.png$/);

    const { LIBRARY_ROOT } = await import('./config.js');
    expect(fs.existsSync(path.join(LIBRARY_ROOT, media.file_path))).toBe(true);

    fs.unlinkSync(path.join(LIBRARY_ROOT, media.file_path));
    fs.rmdirSync(tmp);
    db.close();
  });
});

describe('library-cli find / open / recent', () => {
  it('find returns JSON array of search results', () => {
    const unique = 'uniquesearchterm' + Date.now();
    runCli([
      'save',
      '--source-type', 'note',
      '--user-note', `this is a test note containing ${unique}`,
      '--content', `content_type=user_note,text=contains ${unique} for FTS`,
    ]);

    const { stdout, exitCode } = runCli(['find', unique, '--json']);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('find with --project filters results', () => {
    const unique = 'projfilter' + Date.now();
    runCli(['save', '--source-type', 'note', '--project', 'pure_bliss', '--content', `content_type=user_note,text=${unique}`]);
    runCli(['save', '--source-type', 'note', '--project', 'general', '--content', `content_type=user_note,text=${unique}`]);

    const { stdout } = runCli(['find', unique, '--project', 'pure_bliss', '--json']);
    const results = JSON.parse(stdout);
    for (const r of results) {
      expect(r.project).toBe('pure_bliss');
    }
  });

  it('open returns full item with satellites', () => {
    const saveRes = JSON.parse(runCli(['save', '--source-type', 'note', '--user-note', 'open test']).stdout);
    const { stdout, exitCode } = runCli(['open', String(saveRes.id), '--json']);
    expect(exitCode).toBe(0);
    const item = JSON.parse(stdout);
    expect(item.id).toBe(saveRes.id);
    expect(Array.isArray(item.media)).toBe(true);
    expect(Array.isArray(item.content)).toBe(true);
    expect(Array.isArray(item.tags)).toBe(true);
  });

  it('open on missing id exits non-zero', () => {
    const { exitCode, stderr } = runCli(['open', '9999999']);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain('not found');
  });

  it('recent returns JSON array of most recent items', () => {
    const { stdout, exitCode } = runCli(['recent', '--limit', '5', '--json']);
    expect(exitCode).toBe(0);
    const items = JSON.parse(stdout);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(5);
  });
});
