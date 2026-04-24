import { describe, it, expect } from 'vitest';
import path from 'path';
import { enrichImage } from './image.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'test-ocr.png');

describe('image enricher', () => {
  it('extracts text from a simple PNG via tesseract', async () => {
    const out = await enrichImage(FIXTURE);
    expect(out.ok).toBe(true);
    // OCR can introduce minor variations; check substring loosely
    expect(out.text?.toUpperCase()).toContain('HELLO');
    expect(out.text?.toUpperCase()).toContain('WORLD');
  }, 30000);

  it('returns ok:false for a missing file', async () => {
    const out = await enrichImage('/tmp/does-not-exist-xyz.png');
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBeTruthy();
  });
});
