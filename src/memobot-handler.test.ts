import { describe, it, expect } from 'vitest';
import { inferSourceType, extractFirstUrl, parseId, detectAttachment, classifyFile } from './memobot-handler.js';

describe('memobot-handler: detectAttachment', () => {
  it('detects Photo received', () => {
    const msg = `Photo received. File saved at: /tmp/123_photo.jpg\nCaption: "my screenshot"\nPlease analyze this image.`;
    const a = detectAttachment(msg);
    expect(a).toEqual({ kind: 'Photo', filePath: '/tmp/123_photo.jpg', caption: 'my screenshot' });
  });

  it('detects Photo without caption', () => {
    const msg = `Photo received. File saved at: /tmp/456_photo.png\nPlease analyze this image.`;
    const a = detectAttachment(msg);
    expect(a).toEqual({ kind: 'Photo', filePath: '/tmp/456_photo.png', caption: undefined });
  });

  it('detects Document with filename', () => {
    const msg = `Document received: Q4-report.pdf\nFile saved at: /tmp/789_report.pdf\nCaption: "earnings"\nPlease read and process this file.`;
    const a = detectAttachment(msg);
    expect(a).toEqual({ kind: 'Document', filename: 'Q4-report.pdf', filePath: '/tmp/789_report.pdf', caption: 'earnings' });
  });

  it('detects Video received', () => {
    const msg = `Video received. File saved at: /tmp/vid_123.mp4\nCaption: "kefir brewing"\nUse the gemini-api-dev skill ...`;
    const a = detectAttachment(msg);
    expect(a).toEqual({ kind: 'Video', filePath: '/tmp/vid_123.mp4', caption: 'kefir brewing' });
  });

  it('returns null for plain text', () => {
    expect(detectAttachment('just a note about things')).toBeNull();
    expect(detectAttachment('https://example.com')).toBeNull();
    expect(detectAttachment('')).toBeNull();
  });

  it('returns null when prefix is mid-string (not at start)', () => {
    expect(detectAttachment('something then Photo received. File saved at: /x')).toBeNull();
  });
});

describe('memobot-handler: classifyFile', () => {
  it('classifies images as screenshot', () => {
    expect(classifyFile('/tmp/foo.png').mediaType).toBe('image');
    expect(classifyFile('/tmp/foo.png').sourceType).toBe('screenshot');
    expect(classifyFile('/tmp/foo.jpg').mediaType).toBe('image');
    expect(classifyFile('/tmp/foo.jpeg').mime).toBe('image/jpeg');
    expect(classifyFile('/tmp/foo.heic').mime).toBe('image/heic');
  });

  it('classifies pdf', () => {
    expect(classifyFile('/tmp/report.pdf').mediaType).toBe('pdf');
    expect(classifyFile('/tmp/report.pdf').sourceType).toBe('file');
    expect(classifyFile('/tmp/report.pdf').mime).toBe('application/pdf');
  });

  it('classifies video', () => {
    expect(classifyFile('/tmp/clip.mp4').mediaType).toBe('video');
    expect(classifyFile('/tmp/clip.mov').mime).toBe('video/quicktime');
    expect(classifyFile('/tmp/clip.webm').mime).toBe('video/webm');
  });

  it('classifies audio', () => {
    expect(classifyFile('/tmp/song.mp3').mediaType).toBe('audio');
    expect(classifyFile('/tmp/voice.ogg').mediaType).toBe('audio');
  });

  it('falls back to other for unknown extensions', () => {
    expect(classifyFile('/tmp/random.xyz').mediaType).toBe('other');
    expect(classifyFile('/tmp/noext').mediaType).toBe('other');
  });

  it('is case-insensitive on extension', () => {
    expect(classifyFile('/tmp/FOO.PNG').mediaType).toBe('image');
    expect(classifyFile('/tmp/FOO.Pdf').mediaType).toBe('pdf');
  });
});

describe('memobot-handler: parseId', () => {
  it('accepts plain numeric id', () => {
    expect(parseId('22')).toBe('22');
    expect(parseId('1')).toBe('1');
    expect(parseId('999')).toBe('999');
  });

  it('strips leading #', () => {
    expect(parseId('#22')).toBe('22');
    expect(parseId('#1')).toBe('1');
  });

  it('trims whitespace', () => {
    expect(parseId('  22  ')).toBe('22');
    expect(parseId(' #22 ')).toBe('22');
  });

  it('returns null for non-numeric', () => {
    expect(parseId('abc')).toBeNull();
    expect(parseId('22abc')).toBeNull();
    expect(parseId('')).toBeNull();
    expect(parseId('#')).toBeNull();
    expect(parseId('##22')).toBeNull();
  });
});

describe('memobot-handler: inferSourceType', () => {
  it('recognises tiktok', () => {
    expect(inferSourceType('https://www.tiktok.com/@x/video/123')).toBe('tiktok');
    expect(inferSourceType('https://tiktok.com/t/ABC')).toBe('tiktok');
  });

  it('recognises reddit', () => {
    expect(inferSourceType('https://www.reddit.com/r/foo/comments/bar/')).toBe('reddit');
    expect(inferSourceType('https://redd.it/abc')).toBe('reddit');
  });

  it('recognises twitter and x.com', () => {
    expect(inferSourceType('https://twitter.com/user/status/1')).toBe('twitter');
    expect(inferSourceType('https://x.com/user/status/1')).toBe('twitter');
  });

  it('recognises youtube', () => {
    expect(inferSourceType('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
    expect(inferSourceType('https://youtu.be/abc')).toBe('youtube');
  });

  it('recognises instagram, facebook, threads, linkedin', () => {
    expect(inferSourceType('https://www.instagram.com/p/xyz/')).toBe('instagram');
    expect(inferSourceType('https://www.facebook.com/story/123')).toBe('facebook');
    expect(inferSourceType('https://fb.com/foo')).toBe('facebook');
    expect(inferSourceType('https://www.threads.net/@x/post/123')).toBe('threads');
    expect(inferSourceType('https://www.linkedin.com/pulse/xyz/')).toBe('linkedin');
  });

  it('falls back to article for unknown domains', () => {
    expect(inferSourceType('https://example.com/blog/post')).toBe('article');
    expect(inferSourceType('https://substack.com/foo')).toBe('article');
  });

  it('falls back to article for malformed URLs', () => {
    expect(inferSourceType('not a url')).toBe('article');
    expect(inferSourceType('')).toBe('article');
  });
});

describe('memobot-handler: extractFirstUrl', () => {
  it('returns null when no URL present', () => {
    expect(extractFirstUrl('just plain text')).toBeNull();
    expect(extractFirstUrl('')).toBeNull();
  });

  it('extracts a bare URL', () => {
    expect(extractFirstUrl('https://example.com/post')).toEqual({
      url: 'https://example.com/post',
      rest: '',
    });
  });

  it('extracts URL + trailing note', () => {
    expect(extractFirstUrl('https://example.com for later')).toEqual({
      url: 'https://example.com',
      rest: 'for later',
    });
  });

  it('extracts URL + leading note', () => {
    expect(extractFirstUrl('check this: https://example.com/post')).toEqual({
      url: 'https://example.com/post',
      rest: 'check this:',
    });
  });

  it('strips trailing punctuation from URL', () => {
    expect(extractFirstUrl('great: https://example.com/post.')).toEqual({
      url: 'https://example.com/post',
      rest: 'great:',
    });
  });

  it('uses first URL when multiple present', () => {
    const result = extractFirstUrl('https://a.com or https://b.com');
    expect(result?.url).toBe('https://a.com');
  });

  it('handles http and https', () => {
    expect(extractFirstUrl('http://old-site.com')?.url).toBe('http://old-site.com');
    expect(extractFirstUrl('HTTPS://CAPS.com')?.url).toBe('HTTPS://CAPS.com');
  });
});
