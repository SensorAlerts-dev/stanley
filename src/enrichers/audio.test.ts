import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../voice.js', () => ({
  transcribeAudio: vi.fn(),
}));

import { enrichAudio } from './audio.js';
import { transcribeAudio } from '../voice.js';

let existingFile: string;

beforeAll(() => {
  // Create a real temporary file so fs.existsSync returns true naturally
  existingFile = path.join(os.tmpdir(), `audio-enricher-test-${Date.now()}.mp3`);
  fs.writeFileSync(existingFile, 'fake audio data');
});

afterAll(() => {
  if (fs.existsSync(existingFile)) fs.unlinkSync(existingFile);
});

describe('audio enricher', () => {
  it('delegates to voice.transcribeAudio and returns the transcript', async () => {
    (transcribeAudio as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('hello world transcript');

    const out = await enrichAudio(existingFile);
    expect(out.ok).toBe(true);
    expect(out.text).toBe('hello world transcript');
  });

  it('returns ok:false when transcription throws with quota error', async () => {
    (transcribeAudio as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GROQ quota exhausted'));

    const out = await enrichAudio(existingFile);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('GROQ');
    expect(out.errorCode).toBe('whisper_groq_quota');
  });

  it('returns ok:false file_missing when file does not exist', async () => {
    const missingPath = `/tmp/audio-enricher-nope-${Date.now()}.mp3`;
    const out = await enrichAudio(missingPath);
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('file_missing');
  });
});
