# Phase 2 Follow-up: Unlocking Waves 2 and 3

**Date:** 2026-04-23
**Status:** Deferred. Waves 2 (PDF/video/audio files) and 3 (voice notes + forwarded messages) are blocked on a small Stanley core change. Wave 1 (URLs + text notes) is shipped and working.

---

## What works today

Wave 1 is live. After merging `feat/memobot-collector` to main:

- Paste a URL to `@MemoVizBot` -> memobot scrapes with Playwright, saves with summary, replies with `#<id>`.
- Type free-form text -> saves verbatim as `source_type=note` with project auto-inferred from keywords.
- `library-cli` has the full subcommand surface (`check-url`, `save`, `find`, `open`, `recent`, `delete`, `update`, `help`) with 102 passing tests.
- Every new save auto-writes a `hive_mind` row attributed via `CLAUDECLAW_AGENT_ID`.

## What is deferred

- **Wave 2**: PDF, video, and audio file attachments sent to memobot via Telegram.
- **Wave 3**: Voice notes and forwarded Telegram messages.
- **Image attachments (Wave 1 section B)**: also affected by the same blocker below, although untested in the smoke run. Treat as deferred alongside Wave 2.

## Why it is deferred

`src/media.ts` builds the prompt text that gets prepended to the user's message before it reaches an agent. The current functions emit generic "please analyze / read / use gemini-api-dev" instructions assuming a full-featured assistant downstream:

- `buildPhotoMessage` -> `"Photo received. File saved at: X. Please analyze this image."`
- `buildDocumentMessage` -> `"Document received. File saved at: X. Please read and process this file."`
- `buildVideoMessage` -> `"Video received. File saved at: X. Use the gemini-api-dev skill ... to analyze this video."`

Memobot's CLAUDE.md already contains a prominent override section telling it to IGNORE those default instructions and route the file path to `library-cli save --media-temp-path`. In practice the Haiku-class model treats the bot-prepended command as load-bearing and runs the analysis anyway. Prompt wrestling does not win this one.

The CLAUDE.md override stays in place so the fix below activates memobot's intended behavior the moment the platform catches up.

## The fix (when ready)

Make `src/media.ts` agent-aware. When the invoking agent is a collector (memobot for now), emit a capture-focused prompt instead of the default. Every other agent keeps the current behavior.

### Sketch

```typescript
// src/media.ts

function isCollectorAgent(): boolean {
  return process.env.CLAUDECLAW_AGENT_ID === 'memobot';
  // Long-term: read a `media_handling: collector` flag from agent.yaml
  // so the list isn't hardcoded.
}

function buildCollectorMediaMessage(
  kind: 'Photo' | 'Document' | 'Video' | 'Voice',
  localPath: string,
  mediaType: 'image' | 'pdf' | 'video' | 'audio' | 'other',
  mime: string,
  filename: string | undefined,
  caption: string | undefined,
): string {
  const lines = [
    `${kind} received. File saved at: ${localPath}`,
    filename ? `Filename: ${filename}` : '',
    caption ? `Caption: "${caption}"` : '',
    '',
    'You are memobot. Save this file to the research library.',
    `Run: library-cli save --source-type ${kind === 'Photo' ? 'screenshot' : kind === 'Voice' ? 'voice' : 'file'} \\`,
    `  --media-temp-path "${localPath}" \\`,
    `  --media-type ${mediaType} --media-mime "${mime}" \\`,
    `  --project <inferred from caption or "general"> \\`,
    `  --user-note "${caption ?? ''}" \\`,
    `  --queue-processor "${kind.toLowerCase()} needs ${mediaType === 'image' ? 'OCR' : mediaType === 'video' || mediaType === 'audio' ? 'transcription' : 'text extraction'}"`,
    'Reply with the summary template in your CLAUDE.md section B or F. Do not run analysis, gemini-api-dev, or transcription yourself.',
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  if (isCollectorAgent()) {
    return buildCollectorMediaMessage('Photo', localPath, 'image', 'image/png', undefined, caption);
  }
  let msg = `Photo received. File saved at: ${localPath}`;
  if (caption) msg += `\nCaption: "${caption}"`;
  msg += '\nPlease analyze this image.';
  return msg;
}

// Same pattern for buildDocumentMessage and buildVideoMessage.
// Also wire a buildVoiceMessage if one doesn't exist for voice notes.
```

### Test plan when the fix lands

1. Unit tests in `src/media.test.ts` (already exists) for the new collector branch: assert each builder returns a `library-cli save ...` instruction when `CLAUDECLAW_AGENT_ID=memobot` and the default analyze prompt otherwise.
2. Restart memobot. Send a PDF, a video, and an audio file via Telegram. Each should save to `/Volumes/ClaudeClaw/claudeclaw-library/<project>/<bucket>/` and produce a `library_items` row with `source_type=file`, `enriched_at=NULL`, and a queued `mission_tasks` row for the Processor.
3. Send a screenshot (image). Should save as `source_type=screenshot`.
4. Send a Telegram voice note. Should save as `source_type=voice` (Wave 3 section G in memobot's CLAUDE.md). Requires a `buildVoiceMessage` in `media.ts`.
5. Forward a Telegram message containing a URL from another chat. Memobot should treat it per section H (Wave 3).

Wave 2 smoke test steps are already spelled out in `docs/superpowers/plans/2026-04-23-memobot-collector-phase-2.md` Task 15. Wave 3 steps are Task 17.

## Why this is small

- One file (`src/media.ts`), three or four functions, maybe 40 lines of additions plus tests.
- Does not change any behavior for main, research, comms, content, ops, or any other agent. Only the memobot path branches.
- Reversible: delete the `isCollectorAgent()` check and the collector-branch returns and the platform behaves exactly as before.

## Why not now

Out of session scope. The user chose to close Phase 2 with Wave 1 (URLs + notes) shipped and defer the file/voice work. The memobot CLAUDE.md already contains the handling for Waves 2 and 3, including the override section that will activate once `media.ts` emits collector-friendly prompts.

When you are ready to unlock:
1. Implement the `media.ts` change above with tests.
2. Rebuild (`npm run build`) and restart memobot (`launchctl kickstart -k gui/$(id -u)/com.claudeclaw.memobot`).
3. Run the smoke tests in Plan Tasks 15 and 17.
4. Close out Phase 2 formally.
