/**
 * Audio transcription enricher. Reuses the existing voice.ts
 * transcribeAudio() which handles Groq Whisper + whisper-cpp fallback.
 */

import fs from 'fs';
import { transcribeAudio } from '../voice.js';
import { logger } from '../logger.js';

export interface AudioEnrichOutcome {
  ok: boolean;
  text?: string;
  error?: string;
  errorCode?: string;
}

const MAX_TEXT_CHARS = 10000;

export async function enrichAudio(audioPath: string): Promise<AudioEnrichOutcome> {
  if (!fs.existsSync(audioPath)) {
    return { ok: false, error: `file not found: ${audioPath}`, errorCode: 'file_missing' };
  }
  try {
    const text = await transcribeAudio(audioPath);
    return { ok: true, text: (text ?? '').slice(0, MAX_TEXT_CHARS) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, audioPath }, 'Processor: audio transcription failed');
    if (/quota|429|rate/i.test(msg)) return { ok: false, error: msg, errorCode: 'whisper_groq_quota' };
    if (/ENOENT/i.test(msg) && /whisper/i.test(msg)) return { ok: false, error: msg, errorCode: 'whisper_local_missing' };
    return { ok: false, error: msg, errorCode: 'transcription_failed' };
  }
}
