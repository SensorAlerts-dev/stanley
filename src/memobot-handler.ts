/**
 * Deterministic capture handler for memobot.
 *
 * Memobot's primary job (save URLs/notes/commands) is simple enough
 * to be done without an LLM. This module intercepts well-understood
 * message shapes before bot.ts invokes the Claude agent, calling
 * library-cli directly and returning the reply.
 *
 * Handled shapes:
 *   - URL (with or without trailing note text)
 *   - Plain text (saved as note)
 *   - Slash commands: /recent /find /open /delete /help
 *
 * Unhandled: image/voice/forwarded/empty/ambiguous -> null (caller
 * falls through to the agent).
 */

import { execFile } from 'child_process';
import path from 'path';
import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

const CLI = path.join(PROJECT_ROOT, 'dist', 'library-cli.js');

// ── Source type inference from URL domain ─────────────────────────────

const DOMAIN_SOURCE_MAP: Array<{ test: (host: string) => boolean; type: string }> = [
  { test: (h) => h.endsWith('tiktok.com'), type: 'tiktok' },
  { test: (h) => h.endsWith('instagram.com'), type: 'instagram' },
  { test: (h) => h.endsWith('facebook.com') || h.endsWith('fb.com') || h.endsWith('fb.watch'), type: 'facebook' },
  { test: (h) => h.endsWith('reddit.com') || h.endsWith('redd.it'), type: 'reddit' },
  { test: (h) => h.endsWith('twitter.com') || h.endsWith('x.com') || h.endsWith('t.co'), type: 'twitter' },
  { test: (h) => h.endsWith('youtube.com') || h.endsWith('youtu.be'), type: 'youtube' },
  { test: (h) => h.endsWith('threads.net'), type: 'threads' },
  { test: (h) => h.endsWith('linkedin.com'), type: 'linkedin' },
];

export function inferSourceType(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const rule of DOMAIN_SOURCE_MAP) {
      if (rule.test(host)) return rule.type;
    }
  } catch {
    /* fall through */
  }
  return 'article';
}

// ── CLI invocation ────────────────────────────────────────────────────

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err && (err as { code?: number }).code ? (err as { code: number }).code : err ? 1 : 0;
      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        exitCode,
      });
    });
  });
}

// ── Id parsing (accepts "22" or "#22") ────────────────────────────────

export function parseId(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#/, '');
  return /^\d+$/.test(cleaned) ? cleaned : null;
}

// ── URL detection ─────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"']+/i;

export function extractFirstUrl(text: string): { url: string; rest: string } | null {
  const match = text.match(URL_REGEX);
  if (!match) return null;
  const url = match[0].replace(/[.,;:!?)\]}]+$/, '');  // strip trailing punctuation
  const rest = text.replace(match[0], '').trim();
  return { url, rest };
}

// ── Main handler ──────────────────────────────────────────────────────

export interface HandlerResult {
  reply: string;
}

/**
 * Try to handle the message deterministically. Returns the reply if
 * handled, or null if the caller should fall through to the agent.
 */
export async function handleMemobotMessage(message: string): Promise<HandlerResult | null> {
  const trimmed = message.trim();

  // Empty / whitespace-only
  if (trimmed.length === 0) {
    return { reply: 'Nothing to save - send a URL, file, or note.' };
  }

  // Slash commands
  if (trimmed.startsWith('/')) {
    return handleSlashCommand(trimmed);
  }

  // Stanley's bot layer prepends one of these prefixes when the user
  // sends an attachment. Intercept those BEFORE the URL / note fallbacks
  // so memobot saves the file instead of treating the prompt as text.
  const attachment = detectAttachment(trimmed);
  if (attachment) {
    return saveAttachment(attachment);
  }

  // Voice notes arrive as "[Voice transcribed]: <text>" (Telegram/Groq
  // handles transcription before we see it). Save as source_type=voice
  // with the transcript as the note body.
  const voiceMatch = trimmed.match(/^\[Voice transcribed\]:\s*([\s\S]+)$/);
  if (voiceMatch) {
    return saveVoiceTranscript(voiceMatch[1].trim());
  }

  // URL (with or without accompanying text)
  const urlMatch = extractFirstUrl(trimmed);
  if (urlMatch) {
    return saveUrl(urlMatch.url, urlMatch.rest);
  }

  // Plain text -> save as note
  return saveNote(trimmed);
}

// ── Attachment detection + save ───────────────────────────────────────

export interface DetectedAttachment {
  kind: 'Photo' | 'Document' | 'Video';
  filePath: string;
  filename?: string;
  caption?: string;
}

/**
 * Detect Stanley's "Photo received / Document received / Video received"
 * prefixes and extract path + caption. Returns null when the message is
 * not an attachment prompt.
 */
export function detectAttachment(message: string): DetectedAttachment | null {
  // "Photo received. File saved at: <path>\nCaption: \"...\"\n..."
  let m = message.match(/^Photo received\. File saved at: (.+?)(?:\n|$)/);
  if (m) {
    return { kind: 'Photo', filePath: m[1].trim(), caption: extractCaption(message) };
  }

  // "Document received: <filename>\nFile saved at: <path>\n..."
  m = message.match(/^Document received: (.+?)\nFile saved at: (.+?)(?:\n|$)/);
  if (m) {
    return {
      kind: 'Document',
      filename: m[1].trim(),
      filePath: m[2].trim(),
      caption: extractCaption(message),
    };
  }

  // "Video received. File saved at: <path>\n..."
  m = message.match(/^Video received\. File saved at: (.+?)(?:\n|$)/);
  if (m) {
    return { kind: 'Video', filePath: m[1].trim(), caption: extractCaption(message) };
  }

  return null;
}

function extractCaption(message: string): string | undefined {
  const m = message.match(/^Caption: "([^"]*)"/m);
  return m ? m[1] : undefined;
}

/**
 * Classify a file by extension into the media_type + source_type the
 * CLI expects. Returns 'other' for unknown extensions.
 */
export function classifyFile(filePath: string): {
  mediaType: 'image' | 'video' | 'pdf' | 'audio' | 'other';
  sourceType: 'screenshot' | 'file';
  mime: string;
} {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');

  // Images -> treated as screenshots in source_type
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'].includes(ext)) {
    return {
      mediaType: 'image',
      sourceType: 'screenshot',
      mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext === 'heic' ? 'heic' : ext}`,
    };
  }
  if (ext === 'pdf') return { mediaType: 'pdf', sourceType: 'file', mime: 'application/pdf' };
  if (['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'].includes(ext)) {
    return { mediaType: 'video', sourceType: 'file', mime: `video/${ext === 'mov' ? 'quicktime' : ext}` };
  }
  if (['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'].includes(ext)) {
    return { mediaType: 'audio', sourceType: 'file', mime: `audio/${ext}` };
  }
  return { mediaType: 'other', sourceType: 'file', mime: 'application/octet-stream' };
}

async function saveAttachment(a: DetectedAttachment): Promise<HandlerResult> {
  const classified = classifyFile(a.filename ?? a.filePath);
  const note = a.caption ?? '';
  const queueReason =
    classified.mediaType === 'image' ? 'screenshot needs OCR' :
    classified.mediaType === 'video' ? 'video needs transcription' :
    classified.mediaType === 'audio' ? 'audio needs transcription' :
    classified.mediaType === 'pdf' ? 'pdf needs text extraction' :
    'file needs extraction';

  const args = [
    'save',
    '--source-type', classified.sourceType,
    '--media-temp-path', a.filePath,
    '--media-type', classified.mediaType,
    '--media-mime', classified.mime,
    '--queue-processor', queueReason,
  ];
  if (note.length > 0) args.push('--user-note', note);

  const result = await runCli(args);
  if (result.exitCode !== 0) {
    logger.error({ stderr: result.stderr, args }, 'library-cli save failed (attachment)');
    return { reply: `Save failed: ${result.stderr.trim() || 'unknown error'}. Try again.` };
  }

  let parsed: { id: number };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { reply: 'Save failed: invalid CLI output. Try again.' };
  }

  const label = note.length > 0 ? note : a.filename ?? path.basename(a.filePath);
  return {
    reply: `#${parsed.id} saved (${classified.mediaType}): ${label.length > 60 ? label.slice(0, 60) + '...' : label}\nEnrichment coming when processor runs.`,
  };
}

async function saveVoiceTranscript(transcript: string): Promise<HandlerResult> {
  if (transcript.length === 0) return { reply: 'Empty voice note.' };

  const args = [
    'save',
    '--source-type', 'voice',
    '--user-note', transcript,
    '--content', `content_type=transcript,text=${transcript}`,
    '--enriched',
  ];
  const result = await runCli(args);
  if (result.exitCode !== 0) {
    logger.error({ stderr: result.stderr }, 'library-cli save failed (voice)');
    return { reply: `Save failed: ${result.stderr.trim() || 'unknown error'}. Try again.` };
  }

  let parsed: { id: number };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { reply: 'Save failed: invalid CLI output. Try again.' };
  }

  const preview = transcript.length > 50 ? transcript.slice(0, 50) + '...' : transcript;
  return { reply: `#${parsed.id} saved (voice): ${preview}` };
}

// ── URL save ──────────────────────────────────────────────────────────

async function saveUrl(url: string, extraNote: string): Promise<HandlerResult> {
  const sourceType = inferSourceType(url);
  const args = [
    'save',
    '--source-type', sourceType,
    '--url', url,
    '--auto-scrape',
  ];
  if (extraNote.length > 0) {
    args.push('--user-note', extraNote);
  }

  const result = await runCli(args);
  if (result.exitCode !== 0) {
    logger.error({ stderr: result.stderr, args }, 'library-cli save failed (URL)');
    return { reply: `Save failed: ${result.stderr.trim() || 'unknown error'}. Try again.` };
  }

  let parsed: { id: number; is_duplicate: boolean; existing_id?: number };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    logger.error({ stdout: result.stdout }, 'library-cli save returned non-JSON');
    return { reply: 'Save failed: invalid CLI output. Try again.' };
  }

  if (parsed.is_duplicate) {
    return { reply: `Already have this as #${parsed.existing_id ?? parsed.id}. Note appended.` };
  }
  return { reply: `#${parsed.id} saved.\n${url}` };
}

// ── Note save ─────────────────────────────────────────────────────────

async function saveNote(text: string): Promise<HandlerResult> {
  const args = [
    'save',
    '--source-type', 'note',
    '--user-note', text,
    '--content', `content_type=user_note,text=${text}`,
    '--enriched',
  ];

  const result = await runCli(args);
  if (result.exitCode !== 0) {
    logger.error({ stderr: result.stderr }, 'library-cli save failed (note)');
    return { reply: `Save failed: ${result.stderr.trim() || 'unknown error'}. Try again.` };
  }

  let parsed: { id: number };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { reply: 'Save failed: invalid CLI output. Try again.' };
  }

  const preview = text.length > 40 ? text.slice(0, 40) + '...' : text;
  return { reply: `#${parsed.id} saved: ${preview}` };
}

// ── Slash commands ────────────────────────────────────────────────────

async function handleSlashCommand(command: string): Promise<HandlerResult | null> {
  // Normalize: /find kefir  or  /open 42  etc.
  const [cmd, ...rest] = command.split(/\s+/);
  const lowered = cmd.toLowerCase();

  switch (lowered) {
    case '/help':
      return { reply: memobotHelpText() };

    case '/recent': {
      const limit = rest[0] && /^\d+$/.test(rest[0]) ? rest[0] : '10';
      const result = await runCli(['recent', '--limit', limit, '--json']);
      return { reply: formatItemList(result.stdout, 'No items yet.') };
    }

    case '/find': {
      if (rest.length === 0) return { reply: 'Usage: /find <query>' };
      const query = rest.join(' ');
      const result = await runCli(['find', query, '--json']);
      return { reply: formatItemList(result.stdout, `No items match "${query}".`) };
    }

    case '/open': {
      if (rest.length === 0) return { reply: 'Usage: /open <id> (accepts #<id> too)' };
      const id = parseId(rest[0]);
      if (!id) return { reply: 'Usage: /open <id> (numeric id)' };
      const result = await runCli(['open', id]);
      if (result.exitCode !== 0) return { reply: result.stderr.trim() || `#${id} not found.` };
      return { reply: result.stdout.trim() };
    }

    case '/delete': {
      if (rest.length === 0) return { reply: 'Usage: /delete <id> (accepts #<id> too)' };
      const id = parseId(rest[0]);
      if (!id) return { reply: 'Usage: /delete <id> (numeric id)' };

      // Grab a preview BEFORE deleting so the reply tells the user what went.
      const peek = await runCli(['open', id, '--json']);
      let previewLine = '';
      if (peek.exitCode === 0) {
        try {
          const item = JSON.parse(peek.stdout) as { user_note?: string | null; url?: string | null; title?: string | null };
          const snippet = item.user_note?.trim() || item.url || item.title || '';
          if (snippet) previewLine = ` (${snippet.length > 50 ? snippet.slice(0, 50) + '...' : snippet})`;
        } catch { /* ignore parse errors */ }
      }

      const result = await runCli(['delete', id]);
      if (result.exitCode !== 0) return { reply: result.stderr.trim() || `Delete failed for #${id}.` };
      return { reply: `#${id} deleted.${previewLine}` };
    }

    default:
      // Unknown slash command -> fall through to agent (null)
      return null;
  }
}

function memobotHelpText(): string {
  return [
    'MemoBot commands:',
    '  Paste a URL          -> save the link',
    '  Type any text        -> save as a note',
    '  /recent [N]          -> last N saves (default 10)',
    '  /find <query>        -> full-text search',
    '  /open <id>           -> show one item (accepts #id)',
    '  /delete <id>         -> delete an item (accepts #id)',
    '  /help                -> this help',
  ].join('\n');
}

// Generic og:titles that carry no information and should be ignored in /recent.
const USELESS_TITLES = new Set([
  'tiktok - make your day',
  'instagram',
  'facebook',
  'youtube',
  'x',
  'twitter',
  'reddit',
  'threads',
  'linkedin',
]);

function isUsefulTitle(title: string | null): title is string {
  if (!title) return false;
  return !USELESS_TITLES.has(title.trim().toLowerCase());
}

function formatRelativeTime(unixTs: number): string {
  const seconds = Math.floor(Date.now() / 1000) - unixTs;
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatItemList(stdout: string, emptyText: string): string {
  let items: Array<{
    id: number;
    source_type: string;
    project: string;
    title: string | null;
    url: string | null;
    user_note: string | null;
    captured_at: number;
    snippet?: string;
  }>;
  try {
    items = JSON.parse(stdout);
  } catch {
    return stdout.trim() || emptyText;
  }
  if (!Array.isArray(items) || items.length === 0) return emptyText;

  return items
    .map((r) => {
      const time = formatRelativeTime(r.captured_at);
      const projectTag = r.project !== 'general' ? ` [${r.project}]` : '';

      // Priority for the descriptive label:
      // 1. Useful title (scraped og:title that isn't platform-generic)
      // 2. User note (what the user typed — always informative)
      // 3. URL (clickable in Telegram)
      // 4. Fallback
      const note = r.user_note?.trim();
      const label = isUsefulTitle(r.title)
        ? r.title!
        : note && note.length > 0
          ? note.length > 80 ? note.slice(0, 80) + '...' : note
          : r.url ?? '(no content)';

      // Show URL as a separate line when we have one but used something else as label
      const urlLine = r.url && label !== r.url ? `\n   ${r.url}` : '';
      const snippet = r.snippet ? `\n   ${r.snippet}` : '';

      return `#${r.id} · ${time}${projectTag} · ${r.source_type}\n  ${label}${urlLine}${snippet}`;
    })
    .join('\n\n');
}
