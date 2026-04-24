/**
 * Tesseract-based OCR enricher. Shells out to the `tesseract` binary
 * (install: brew install tesseract). No tesseract.js — the native
 * binary is 10-20x faster and more accurate.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export interface ImageEnrichOutcome {
  ok: boolean;
  text?: string;
  error?: string;
  errorCode?: string;
}

export async function enrichImage(imagePath: string, languages = 'eng'): Promise<ImageEnrichOutcome> {
  if (!fs.existsSync(imagePath)) {
    return { ok: false, error: `file not found: ${imagePath}`, errorCode: 'file_missing' };
  }

  try {
    // tesseract <input> - -l <lang> writes OCR text to stdout
    const { stdout } = await execFileAsync('tesseract', [imagePath, '-', '-l', languages], {
      maxBuffer: 10 * 1024 * 1024,  // 10 MB
      timeout: 60_000,
      encoding: 'utf-8',
    });
    return { ok: true, text: String(stdout).trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, imagePath }, 'Processor: image OCR failed');
    if (/ENOENT.*tesseract/.test(msg)) {
      return {
        ok: false,
        error: 'tesseract binary not found. Install with: brew install tesseract',
        errorCode: 'tesseract_not_installed',
      };
    }
    return { ok: false, error: msg, errorCode: 'ocr_failed' };
  }
}
