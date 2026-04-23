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
