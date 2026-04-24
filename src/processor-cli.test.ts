import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

  afterAll(() => {
    fs.rmSync(TEST_STORE_DIR, { recursive: true, force: true });
  });

  it('drain with no queued tasks reports 0 processed and produces clean JSON stdout', () => {
    // Use a fresh temp dir so migrations fire on this run -- exercises the
    // case that caused the prior stdout-pollution bug.
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-cli-fresh-'));
    try {
      const r = execFileSync('node', [CLI, 'drain'], {
        encoding: 'utf-8',
        env: { ...process.env, CLAUDECLAW_STORE_DIR: freshDir },
      });
      // stdout must be exactly one JSON line -- no pino log interleaving.
      const lines = r.trim().split('\n');
      expect(lines.length).toBe(1);
      const out = JSON.parse(lines[0]);
      expect(out.processed).toBe(0);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
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
