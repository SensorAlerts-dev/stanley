import { describe, it, expect } from 'vitest';
import path from 'path';
import { enrichPdf } from './pdf.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'test.pdf');

describe('pdf enricher', () => {
  it('extracts text from a simple PDF', async () => {
    const out = await enrichPdf(FIXTURE);
    expect(out.ok).toBe(true);
    expect(out.text?.toLowerCase()).toContain('kefir');
    expect(typeof out.numPages).toBe('number');
  });

  it('returns ok:false for a missing file', async () => {
    const out = await enrichPdf('/tmp/does-not-exist-xyz.pdf');
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('file_missing');
  });
});
