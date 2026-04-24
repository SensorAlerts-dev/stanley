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
    // Prime the DB so migration INFO logs (which pino writes to stdout) are
    // flushed before any test parses JSON from stdout. Without this, the first
    // CLI call in a fresh CLAUDECLAW_STORE_DIR would emit migration logs
    // mixed with JSON, breaking JSON.parse.
    runCli(['drain']);
  }, 120000);

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
