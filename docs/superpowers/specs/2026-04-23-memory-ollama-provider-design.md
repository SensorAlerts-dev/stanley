# Memory Provider Abstraction — Ollama Backend

**Status:** Approved (2026-04-23)
**Motivation:** Gemini free-tier quota exhausted. 118 `RESOURCE_EXHAUSTED` errors in the bot log, and every inbound Telegram message was triggering a failed memory extraction. Swap to a local Ollama backend to eliminate the 429 storm, drop the vendor dependency, and keep conversation data local.

## Scope

Swap the two Gemini-powered helpers behind a provider interface:

- `src/gemini.ts::generateContent(prompt, model?)` → JSON generation
- `src/embeddings.ts::embedText(text)` → vector embedding

Callers of these helpers:

- `src/memory-ingest.ts` — per-message fact extraction
- `src/memory-consolidate.ts` — scheduled consolidation
- `src/memory.ts` — per-turn semantic recall (inline)

The abstraction routes calls to Ollama (default) or Gemini based on a new env var. Out of scope: War Room (`dashboard.ts`) and video analysis (`media.ts`) — those keep their Gemini paths untouched.

## Design

### Provider interface

New module `src/memory-provider.ts`:

```ts
export interface MemoryProvider {
  generateContent(prompt: string): Promise<string>;
  embedText(text: string): Promise<number[]>;
}

export function getMemoryProvider(): MemoryProvider;
```

`getMemoryProvider()` is memoized. It reads `MEMORY_PROVIDER` from env:

- `MEMORY_PROVIDER=ollama` (default) → returns the Ollama impl
- `MEMORY_PROVIDER=gemini` → returns the Gemini impl (existing code, wrapped)

### Ollama implementation

New module `src/ollama-memory.ts` (kept separate from `src/enrichers/ollama.ts` so the processor's summarize/headline helpers stay untouched):

- `generateContent(prompt)` — POST `http://localhost:11434/api/generate` with `model: 'qwen2.5:3b-instruct'`, `format: 'json'`, `stream: false`, `options.temperature: 0.1`. Returns `response.response`.
- `embedText(text)` — POST `http://localhost:11434/api/embeddings` with `model: 'nomic-embed-text'`. Returns `response.embedding`.

Both handle:
- Connection refused (Ollama not running) → throws clear error with remediation hint
- HTTP non-2xx → throws with status + body

### Gemini implementation

Wrap existing `src/gemini.ts::generateContent` and `src/embeddings.ts::embedText` as a `MemoryProvider` impl. No behavior change — exists only so the feature flag can flip back if needed.

### Caller migration

Three files change their imports:

- `src/memory-ingest.ts`: `import { generateContent, parseJsonResponse } from './gemini.js'` → `import { getMemoryProvider, parseJsonResponse } from './memory-provider.js'` (`parseJsonResponse` moves to the provider module), and `await generateContent(prompt)` → `await getMemoryProvider().generateContent(prompt)`.
- `src/memory-consolidate.ts`: same swap.
- `src/memory.ts`: same swap, plus `embedText` import moves from `./embeddings.js` to `./memory-provider.js`.

`parseJsonResponse` is a pure function (no API call) — move it to `memory-provider.ts` so all provider concerns live in one place. Callers import both `getMemoryProvider` and `parseJsonResponse` from the same module.

`src/gemini.ts` and `src/embeddings.ts` are NOT deleted — they become the Gemini provider's backing impl. Other callers (War Room, etc.) keep working.

### Embedding dimension change

- Gemini `gemini-embedding-001` → 3072 dims (configurable)
- Ollama `nomic-embed-text` → 768 dims

Current DB state: **0 of 9 memory rows have embeddings.** No migration needed. New embeddings written under the Ollama provider will be 768-dim; `cosineSimilarity` in `embeddings.ts` already no-ops when lengths differ, so mixed rows degrade gracefully (miss rather than crash).

### Setup / operator requirements

- Ollama must be running (`http://localhost:11434` reachable) — same requirement the processor already has.
- `ollama pull nomic-embed-text` must be run once before first memory ingest. Setup wizard + README get a one-liner noting this.
- `qwen2.5:3b-instruct` is already installed locally (confirmed via `ollama list`).

### Error handling

- Ollama unreachable: caller gets the thrown error and logs it. Memory ingestion currently already wraps its call in try/catch and is non-fatal per message. No new error surface area.
- Circuit-breaker / retries: out of scope. If Ollama is down, memory features silently no-op until it's back.

## Testing

- Unit tests for `getMemoryProvider()` dispatch logic (env-var driven).
- Unit tests for `ollama-memory.ts` with `fetch` mocked (happy path + connection refused + non-2xx).
- Existing `memory-ingest`, `memory-consolidate`, `memory.ts` tests keep working — they already mock `generateContent`/`embedText` at the module boundary. The mock target moves from `./gemini.js` to `./memory-provider.js`.

## File Changes Summary

**New:**
- `src/memory-provider.ts` — interface + dispatcher + re-export of `parseJsonResponse`
- `src/ollama-memory.ts` — Ollama impl
- `src/memory-provider.test.ts` — dispatch + provider unit tests

**Modified:**
- `src/memory-ingest.ts` — swap imports
- `src/memory-consolidate.ts` — swap imports
- `src/memory.ts` — swap imports
- `README.md` / `setup/` — add `ollama pull nomic-embed-text` note
- `.env.example` (or equivalent) — add `MEMORY_PROVIDER=ollama` as a comment

**Unchanged:**
- `src/gemini.ts`, `src/embeddings.ts` — survive as the Gemini provider's backing impl
- `src/enrichers/ollama.ts` — processor's summarize/headline untouched

## Tradeoffs

- **Quality:** qwen2.5:3b extracts messier facts than gemini-2.0-flash. Acceptable for the first pass; if noticed, swap the model string or move to qwen2.5:7b / llama3.1:8b.
- **Speed:** local inference adds seconds per call. Memory ingestion is background, so fine. Per-turn recall in `memory.ts` may introduce visible latency on user-facing turns — worth monitoring.
- **Privacy / cost / reliability:** all local, no quota, no network. Wins on all three.

## Success Criteria

- `MEMORY_PROVIDER=ollama` (default) routes all three callers through Ollama.
- No more `RESOURCE_EXHAUSTED` errors in `/tmp/claudeclaw.log` under normal operation.
- Memory rows written after the swap contain 768-dim embeddings.
- `/remember X` via the bot still saves a memory; `[Memory context]` in subsequent turns shows matching recall.
- Flipping `MEMORY_PROVIDER=gemini` restores the old Gemini behavior without code changes.
- Existing tests all pass; new provider + Ollama tests pass.
