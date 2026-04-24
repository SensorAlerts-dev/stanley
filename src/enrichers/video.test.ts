import { describe, it, expect, vi } from 'vitest';

vi.mock('../voice.js', () => ({
  transcribeAudio: vi.fn().mockResolvedValue('video audio transcript here'),
}));

import { enrichVideo } from './video.js';

describe('video enricher', () => {
  it('returns ok:false for a missing file', async () => {
    const out = await enrichVideo('/tmp/does-not-exist.mp4');
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBeTruthy();
  });
});
