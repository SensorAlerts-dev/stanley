/**
 * Video enricher: extracts audio via ffmpeg, delegates to audio enricher.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { enrichAudio } from './audio.js';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export interface VideoEnrichOutcome {
  ok: boolean;
  text?: string;
  error?: string;
  errorCode?: string;
}

export async function enrichVideo(videoPath: string): Promise<VideoEnrichOutcome> {
  if (!fs.existsSync(videoPath)) {
    return { ok: false, error: `file not found: ${videoPath}`, errorCode: 'file_missing' };
  }

  // Temp wav output
  const tmpWav = path.join(os.tmpdir(), `proc-video-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);

  try {
    // Extract mono 16kHz WAV suitable for whisper input
    await execFileAsync('ffmpeg', [
      '-loglevel', 'error',
      '-i', videoPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-y',
      tmpWav,
    ], { timeout: 5 * 60 * 1000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT/i.test(msg) && /ffmpeg/i.test(msg)) {
      return { ok: false, error: 'ffmpeg not found. Install with: brew install ffmpeg', errorCode: 'ffmpeg_not_installed' };
    }
    logger.error({ err, videoPath }, 'Processor: ffmpeg audio extraction failed');
    return { ok: false, error: msg, errorCode: 'audio_extraction_failed' };
  }

  try {
    const audioOut = await enrichAudio(tmpWav);
    if (!audioOut.ok) {
      return { ok: false, error: audioOut.error, errorCode: audioOut.errorCode };
    }
    return { ok: true, text: audioOut.text };
  } finally {
    try {
      fs.unlinkSync(tmpWav);
    } catch {
      // temp already removed or inaccessible; ignore
    }
  }
}
