# Memory Provider (Ollama Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the Gemini-backed memory helpers (`generateContent`, `embedText`) behind a provider module defaulting to Ollama, eliminating the free-tier 429 storm without losing the memory feature.

**Architecture:** New `src/memory-provider.ts` exports the same three function names today's callers use (`generateContent`, `embedText`, `parseJsonResponse`) and internally dispatches on `MEMORY_PROVIDER` env (default `ollama`). Ollama backend lives in new `src/ollama-memory.ts` and talks to `http://localhost:11434` directly (raw fetch, no new dep). Existing `src/gemini.ts` and `src/embeddings.ts` stay as the Gemini backend. Callers (`memory-ingest.ts`, `memory-consolidate.ts`, `memory.ts`) swap their imports from `./gemini.js` / `./embeddings.js` to `./memory-provider.js`. `cosineSimilarity` stays in `embeddings.ts` (pure math, provider-neutral).

**Tech Stack:** TypeScript, Node 20+, vitest, better-sqlite3, `@google/genai` (existing), Ollama HTTP API.

**Branch:** Create `feat/memory-ollama-provider` off `main` after the current `feat/processor-agent` branch merges. (If `feat/processor-agent` is still open when this plan runs, branch from `feat/processor-agent` instead.)

## File Structure

**New:**
- `src/ollama-memory.ts` — `generateJson(prompt)` + `embed(text)` talking to local Ollama
- `src/ollama-memory.test.ts` — unit tests with `fetch` mocked
- `src/memory-provider.ts` — dispatcher + re-exports `parseJsonResponse` from `./gemini.js`
- `src/memory-provider.test.ts` — dispatch routing tests

**Modified (imports swap only):**
- `src/memory-ingest.ts` — `import ... from './memory-provider.js'` replaces the `./gemini.js` import
- `src/memory-consolidate.ts` — same
- `src/memory.ts` — same (and move `embedText` import from `./embeddings.js` to `./memory-provider.js`)

**Modified (test mocks retarget):**
- `src/memory-ingest.test.ts` — mock `./memory-provider.js` instead of `./gemini.js`
- `src/memory-consolidate.test.ts` — same
- `src/memory.test.ts` — same

**Modified (docs / config):**
- `README.md` — add `ollama pull nomic-embed-text` note under setup
- `.env.example` — document `MEMORY_PROVIDER`

**Unchanged (intentionally):**
- `src/gemini.ts` — still home of `generateContent` (Gemini impl) and `parseJsonResponse` (pure, re-exported)
- `src/embeddings.ts` — still home of `embedText` (Gemini impl) and `cosineSimilarity` (pure math)
- `src/enrichers/ollama.ts` — processor's `summarize` / `headline` untouched
- `src/dashboard.ts` — keeps Gemini path (War Room + auto-assign out of scope)
- `src/media.ts` — video analysis path untouched

---

## Task 1: Ollama memory client — generation

**Files:**
- Create: `src/ollama-memory.ts`
- Create: `src/ollama-memory.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/ollama-memory.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ollama-memory generateJson', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('posts to /api/generate with format:json and returns response.response', async () => {
    const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://localhost:11434/api/generate');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('qwen2.5:3b-instruct');
      expect(body.format).toBe('json');
      expect(body.stream).toBe(false);
      expect(body.prompt).toBe('extract memory');
      return new Response(JSON.stringify({ response: '{"ok":true}' }), { status: 200 });
    });
    globalThis.fetch = mockFetch as typeof fetch;

    const { generateJson } = await import('./ollama-memory.js');
    const out = await generateJson('extract memory');
    expect(out).toBe('{"ok":true}');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws a helpful error when Ollama is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed'); }) as typeof fetch;
    const { generateJson } = await import('./ollama-memory.js');
    await expect(generateJson('hi')).rejects.toThrow(/Ollama unreachable at http:\/\/localhost:11434/);
  });

  it('throws with status + body on non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => new Response('model not found', { status: 404 })) as typeof fetch;
    const { generateJson } = await import('./ollama-memory.js');
    await expect(generateJson('hi')).rejects.toThrow(/Ollama generate failed: 404 model not found/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run src/ollama-memory.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/ollama-memory.ts`**

```typescript
/**
 * Thin client for Ollama's /api/generate (JSON mode) and /api/embeddings.
 * Kept separate from src/enrichers/ollama.ts so the processor's
 * summarize/headline helpers stay untouched.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const GEN_MODEL = process.env.OLLAMA_MEMORY_MODEL ?? 'qwen2.5:3b-instruct';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';

interface GenerateResponse { response?: string; }
interface EmbeddingsResponse { embedding?: number[]; }

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Ollama unreachable at ${OLLAMA_URL} (${msg}). Is 'ollama serve' running?`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export async function generateJson(prompt: string): Promise<string> {
  const out = await postJson<GenerateResponse>('/api/generate', {
    model: GEN_MODEL,
    prompt,
    stream: false,
    format: 'json',
    options: { temperature: 0.1 },
  });
  return out.response ?? '';
}

export async function embed(text: string): Promise<number[]> {
  const out = await postJson<EmbeddingsResponse>('/api/embeddings', {
    model: EMBED_MODEL,
    prompt: text,
  });
  return out.embedding ?? [];
}
```

Note the test expectation `Ollama generate failed: 404` — update it to `Ollama /api/generate failed: 404` to match. Fix in the test file:

```typescript
await expect(generateJson('hi')).rejects.toThrow(/Ollama \/api\/generate failed: 404 model not found/);
```

- [ ] **Step 4: Run — expect PASS**

```bash
npx vitest run src/ollama-memory.test.ts -t generateJson
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ollama-memory.ts src/ollama-memory.test.ts
git commit -m "feat(memory): add ollama-memory client — generateJson

POSTs to /api/generate with format:'json', returns response.response.
Reads OLLAMA_URL and OLLAMA_MEMORY_MODEL from env (defaults
http://localhost:11434 and qwen2.5:3b-instruct). Helpful error
when Ollama is unreachable."
```

---

## Task 2: Ollama memory client — embeddings

**Files:**
- Modify: `src/ollama-memory.test.ts` (append)

The `embed()` function was already implemented in Task 1 alongside `generateJson()` — this task just adds the test coverage.

- [ ] **Step 1: Append failing test**

```typescript
describe('ollama-memory embed', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('posts to /api/embeddings and returns the embedding array', async () => {
    const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://localhost:11434/api/embeddings');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('nomic-embed-text');
      expect(body.prompt).toBe('hello world');
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
    });
    globalThis.fetch = mockFetch as typeof fetch;

    const { embed } = await import('./ollama-memory.js');
    const out = await embed('hello world');
    expect(out).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns [] when response has no embedding field', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    const { embed } = await import('./ollama-memory.js');
    const out = await embed('hi');
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect PASS**

```bash
npx vitest run src/ollama-memory.test.ts
```

Expected: 5 tests pass (3 from Task 1, 2 new).

- [ ] **Step 3: Commit**

```bash
git add src/ollama-memory.test.ts
git commit -m "test(memory): cover ollama-memory embed

POSTs to /api/embeddings with nomic-embed-text, returns embedding
array. Graceful [] when response lacks the field."
```

---

## Task 3: Memory provider dispatcher

**Files:**
- Create: `src/memory-provider.ts`
- Create: `src/memory-provider.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/memory-provider.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./gemini.js', () => ({
  generateContent: vi.fn(async () => 'gemini-out'),
  parseJsonResponse: vi.fn(() => ({ parsed: true })),
}));
vi.mock('./embeddings.js', () => ({
  embedText: vi.fn(async () => [1, 2, 3]),
}));
vi.mock('./ollama-memory.js', () => ({
  generateJson: vi.fn(async () => 'ollama-out'),
  embed: vi.fn(async () => [9, 9, 9]),
}));

describe('memory-provider dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('routes generateContent to Ollama by default', async () => {
    delete process.env.MEMORY_PROVIDER;
    const { generateContent } = await import('./memory-provider.js');
    const out = await generateContent('hi');
    expect(out).toBe('ollama-out');
  });

  it('routes embedText to Ollama by default', async () => {
    delete process.env.MEMORY_PROVIDER;
    const { embedText } = await import('./memory-provider.js');
    const out = await embedText('hi');
    expect(out).toEqual([9, 9, 9]);
  });

  it('routes generateContent to Gemini when MEMORY_PROVIDER=gemini', async () => {
    process.env.MEMORY_PROVIDER = 'gemini';
    const { generateContent } = await import('./memory-provider.js');
    const out = await generateContent('hi');
    expect(out).toBe('gemini-out');
    delete process.env.MEMORY_PROVIDER;
  });

  it('routes embedText to Gemini when MEMORY_PROVIDER=gemini', async () => {
    process.env.MEMORY_PROVIDER = 'gemini';
    const { embedText } = await import('./memory-provider.js');
    const out = await embedText('hi');
    expect(out).toEqual([1, 2, 3]);
    delete process.env.MEMORY_PROVIDER;
  });

  it('re-exports parseJsonResponse from gemini.js', async () => {
    const { parseJsonResponse } = await import('./memory-provider.js');
    expect(parseJsonResponse('{"a":1}')).toEqual({ parsed: true });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run src/memory-provider.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/memory-provider.ts`**

```typescript
/**
 * Unified provider for memory-related LLM helpers (generation + embedding).
 * Dispatches to local Ollama by default, or Gemini when
 * MEMORY_PROVIDER=gemini. Pure JSON parsing is re-exported
 * from ./gemini.js (provider-neutral).
 *
 * Callers (memory-ingest, memory-consolidate, memory) should import
 * generateContent / embedText / parseJsonResponse from here rather than
 * the underlying provider modules so the swap is transparent.
 */

import { generateContent as geminiGenerate } from './gemini.js';
import { embedText as geminiEmbed } from './embeddings.js';
import { generateJson as ollamaGenerate, embed as ollamaEmbed } from './ollama-memory.js';

export { parseJsonResponse } from './gemini.js';

function useGemini(): boolean {
  return (process.env.MEMORY_PROVIDER ?? 'ollama').toLowerCase() === 'gemini';
}

export async function generateContent(prompt: string): Promise<string> {
  return useGemini() ? geminiGenerate(prompt) : ollamaGenerate(prompt);
}

export async function embedText(text: string): Promise<number[]> {
  return useGemini() ? geminiEmbed(text) : ollamaEmbed(text);
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npx vitest run src/memory-provider.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/memory-provider.ts src/memory-provider.test.ts
git commit -m "feat(memory): add memory-provider dispatcher

Unified entry point for generateContent / embedText / parseJsonResponse.
Dispatches to local Ollama by default, Gemini when MEMORY_PROVIDER=gemini.
Callers swap their imports from ./gemini.js and ./embeddings.js to
./memory-provider.js in the next tasks."
```

---

## Task 4: Migrate `memory-ingest.ts`

**Files:**
- Modify: `src/memory-ingest.ts`
- Modify: `src/memory-ingest.test.ts`

- [ ] **Step 1: Update test mocks** (retarget to `./memory-provider.js`)

Replace the top of `src/memory-ingest.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./memory-provider.js', () => ({
  generateContent: vi.fn(),
  parseJsonResponse: vi.fn(),
  embedText: vi.fn(() => Promise.resolve([0.1, 0.2, 0.3])),
}));

vi.mock('./db.js', () => ({
  saveStructuredMemoryAtomic: vi.fn(() => 1),
  getMemoriesWithEmbeddings: vi.fn(() => []),
}));

vi.mock('./embeddings.js', () => ({
  cosineSimilarity: vi.fn(() => 0),
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ingestConversationTurn } from './memory-ingest.js';
import { generateContent, parseJsonResponse } from './memory-provider.js';
import { saveStructuredMemoryAtomic } from './db.js';

const mockGenerateContent = vi.mocked(generateContent);
const mockParseJson = vi.mocked(parseJsonResponse);
const mockSave = vi.mocked(saveStructuredMemoryAtomic);
```

(Only the mock block + the final `import ... from './memory-provider.js'` line change. The test cases below are untouched.)

- [ ] **Step 2: Update imports in `src/memory-ingest.ts`**

Replace lines 1–2:

```typescript
import { generateContent, parseJsonResponse, embedText } from './memory-provider.js';
import { cosineSimilarity } from './embeddings.js';
```

- [ ] **Step 3: Run tests — expect PASS**

```bash
npx vitest run src/memory-ingest.test.ts
```

Expected: all existing tests pass against the new import path.

- [ ] **Step 4: Commit**

```bash
git add src/memory-ingest.ts src/memory-ingest.test.ts
git commit -m "refactor(memory-ingest): route LLM calls through memory-provider

Swaps imports from ./gemini.js and ./embeddings.js to ./memory-provider.js
for generateContent / parseJsonResponse / embedText. cosineSimilarity
stays in ./embeddings.js (pure math). No behavior change under the
default MEMORY_PROVIDER=ollama — feature sized by Task 3 dispatcher."
```

---

## Task 5: Migrate `memory-consolidate.ts`

**Files:**
- Modify: `src/memory-consolidate.ts`
- Modify: `src/memory-consolidate.test.ts`

- [ ] **Step 1: Update test mocks**

Open `src/memory-consolidate.test.ts`. Replace the two top-level `vi.mock` blocks for `./gemini.js` and `./embeddings.js` with:

```typescript
vi.mock('./memory-provider.js', () => ({
  generateContent: vi.fn(),
  parseJsonResponse: vi.fn(),
  embedText: vi.fn(() => Promise.resolve([0.1, 0.2, 0.3])),
}));
```

If the test imports `generateContent` / `parseJsonResponse` / `embedText` from `./gemini.js` or `./embeddings.js` at the top of the file, update those to import from `./memory-provider.js`.

- [ ] **Step 2: Update imports in `src/memory-consolidate.ts`**

Replace lines 1 and 7 (and any other `from './gemini.js'` or `from './embeddings.js'` imports):

```typescript
import { generateContent, parseJsonResponse, embedText } from './memory-provider.js';
```

Remove the now-unused separate `embedText` import line.

- [ ] **Step 3: Run tests — expect PASS**

```bash
npx vitest run src/memory-consolidate.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/memory-consolidate.ts src/memory-consolidate.test.ts
git commit -m "refactor(memory-consolidate): route LLM calls through memory-provider

Swaps imports from ./gemini.js and ./embeddings.js to ./memory-provider.js.
No behavior change under default provider."
```

---

## Task 6: Migrate `memory.ts`

**Files:**
- Modify: `src/memory.ts`
- Modify: `src/memory.test.ts`

- [ ] **Step 1: Update test mocks**

Open `src/memory.test.ts`. Replace the two top-level `vi.mock` blocks for `./gemini.js` and `./embeddings.js` with:

```typescript
vi.mock('./memory-provider.js', () => ({
  generateContent: vi.fn(),
  parseJsonResponse: vi.fn(() => null),
  embedText: vi.fn(() => Promise.resolve([0.1, 0.2, 0.3])),
}));

vi.mock('./embeddings.js', () => ({
  cosineSimilarity: vi.fn(() => 0),
}));
```

Update any top-level imports in the test that referenced `./gemini.js` or `./embeddings.js` for `generateContent` / `parseJsonResponse` / `embedText` to point at `./memory-provider.js` instead. Keep `cosineSimilarity` imports pointed at `./embeddings.js`.

- [ ] **Step 2: Update imports in `src/memory.ts`**

Replace lines 19–20:

```typescript
import { cosineSimilarity } from './embeddings.js';
import { generateContent, parseJsonResponse, embedText } from './memory-provider.js';
```

- [ ] **Step 3: Run tests — expect PASS**

```bash
npx vitest run src/memory.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/memory.ts src/memory.test.ts
git commit -m "refactor(memory): route LLM calls through memory-provider

Swaps imports from ./gemini.js and ./embeddings.js to ./memory-provider.js
for generateContent / parseJsonResponse / embedText. cosineSimilarity
stays in ./embeddings.js (pure math)."
```

---

## Task 7: Full-suite regression + build sanity

**Files:** None (operational).

- [ ] **Step 1: Run all tests**

```bash
npx vitest run
```

Expected: every previously-passing test still passes, plus the new Task 1–3 tests. The 7 pre-existing `src/skill-registry.test.ts` failures (unrelated) remain.

If anything else fails, inspect; usually a missed mock or stale import.

- [ ] **Step 2: Type-check + build**

```bash
npm run build
```

Expected: clean `tsc` output with zero errors.

- [ ] **Step 3: Commit if anything was fixed in Step 1 or 2**

```bash
git add -A
git commit -m "fix(memory): regressions surfaced by full suite"
```

Otherwise skip.

---

## Task 8: Ops + docs

**Files:**
- Modify: `README.md`
- Modify: `.env.example` (or equivalent — skip if file does not exist)

- [ ] **Step 1: Pull the embedding model** (operator step, one-time)

Run on the host where ClaudeClaw runs:

```bash
ollama pull nomic-embed-text
```

Verify with:

```bash
ollama list | grep nomic-embed-text
```

- [ ] **Step 2: Add setup note to `README.md`**

Find the "Installation" / "Setup" / "Prerequisites" section. Append under the Ollama bullet (or add one if none exists):

```markdown
- **Ollama** — required for the processor (summarize/headline) and for the memory system.
  - Install: https://ollama.com
  - Pull the models:
    ```bash
    ollama pull qwen2.5:3b-instruct
    ollama pull nomic-embed-text
    ```
  - The memory system defaults to Ollama. To use Gemini instead, set `MEMORY_PROVIDER=gemini` in `.env` (requires `GOOGLE_API_KEY`).
```

- [ ] **Step 3: Add env var note to `.env.example`**

Check whether `.env.example` exists:

```bash
test -f .env.example && echo exists || echo missing
```

If it exists, append:

```bash
# Memory system provider: ollama (default, local) or gemini (requires GOOGLE_API_KEY)
MEMORY_PROVIDER=ollama
# Optional overrides (defaults shown)
# OLLAMA_URL=http://localhost:11434
# OLLAMA_MEMORY_MODEL=qwen2.5:3b-instruct
# OLLAMA_EMBED_MODEL=nomic-embed-text
```

If it does not exist, skip.

- [ ] **Step 4: Commit**

```bash
git add README.md .env.example 2>/dev/null
git commit -m "docs(memory): document ollama-backed memory provider

README: setup step for 'ollama pull nomic-embed-text' and
MEMORY_PROVIDER=gemini escape hatch. .env.example: document
MEMORY_PROVIDER + OLLAMA_* overrides."
```

(If `.env.example` doesn't exist, omit it from the `git add`.)

---

## Task 9: Real-world smoke test

**Files:** None (manual).

- [ ] **Step 1: Restart the main bot process**

```bash
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.app
```

If started manually: Ctrl+C and `npm start` again.

- [ ] **Step 2: Confirm the embedding model is loaded**

```bash
curl -s http://localhost:11434/api/embeddings -d '{"model":"nomic-embed-text","prompt":"smoke"}' | head -c 200
```

Expected: JSON with an `"embedding":[...]` field (not an error).

- [ ] **Step 3: Baseline — count memories and log lines**

```bash
sqlite3 store/claudeclaw.db "SELECT COUNT(*) FROM memories"
grep -c RESOURCE_EXHAUSTED /tmp/claudeclaw.log || true
```

Note both numbers.

- [ ] **Step 4: Seed a memory-worthy message via Telegram**

Send something to `@MemoVizBot` that contains a lasting preference or fact, e.g.:

> "Going forward, always use British English when writing emails for me."

Wait ~10 seconds for the fire-and-forget ingest to finish.

- [ ] **Step 5: Verify memory was extracted + embedded**

```bash
sqlite3 -column -header store/claudeclaw.db "
SELECT id, agent_id, importance, length(embedding) AS emb_bytes,
       substr(summary, 1, 80) AS summary
FROM memories
ORDER BY id DESC LIMIT 3"
```

Expected:
- A new row with `importance >= 0.5`
- `emb_bytes > 0` (the Ollama embedding was written — blob length = `768 * 4 = 3072` bytes for `nomic-embed-text`, or near that)
- Summary contains the British English preference

- [ ] **Step 6: Verify no 429 storm**

```bash
grep -c RESOURCE_EXHAUSTED /tmp/claudeclaw.log
```

Expected: same count as baseline (Step 3). No new 429s in this session.

- [ ] **Step 7: Verify recall on a follow-up turn**

Send a second Telegram message like "draft a reply to John's email about the quote". The assistant's reply should reflect the British-English preference (colour, organised, etc.).

If the preference is observed: recall is working.

If not: check `[Memory context]` by temporarily enabling debug logging, or inspect `sqlite3 store/claudeclaw.db "SELECT * FROM conversation_log ORDER BY id DESC LIMIT 1"` and grep the full prompt that went to Claude.

- [ ] **Step 8: Flip-back sanity** (optional)

Set `MEMORY_PROVIDER=gemini` in `.env`, restart the bot, send another memory-worthy message. Expect a Gemini path call (will either work if quota resets, or throw 429 — either outcome confirms the switch is live). Reset `MEMORY_PROVIDER=ollama` afterwards.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `src/memory-provider.ts` with dispatch | Task 3 |
| `src/ollama-memory.ts` raw client | Tasks 1–2 |
| `src/gemini.ts` + `src/embeddings.ts` unchanged (used as Gemini backend) | Preserved — Tasks 3 imports from them |
| Three callers swap imports | Tasks 4, 5, 6 |
| Tests mock `./memory-provider.js` instead of `./gemini.js` | Tasks 4, 5, 6 Step 1 |
| Embedding dim change handled (no migration needed — 0 rows) | Noted in spec; no task required |
| Setup doc updates | Task 8 |
| Ollama unreachable → non-fatal to bot | Inherited from existing try/catch in callers; verified in Task 1 error test |
| `MEMORY_PROVIDER=gemini` restores old path without code changes | Task 3 impl + Task 9 Step 8 verification |

**Placeholder scan:** No "TBD", "add error handling", or "similar to task N" references.

**Type consistency:** `generateContent(prompt: string): Promise<string>` and `embedText(text: string): Promise<number[]>` signatures are identical in `gemini.ts`, `embeddings.ts`, and the new `memory-provider.ts`. Callers don't need type changes.

**Scope check:** One feature, ~4 new/modified source files + 3 test migrations + 1 docs pass. Fits a single plan.

**Risk notes:**
- **Task 4–6 mock retargeting** is the highest-friction step; if any test indirectly imports `generateContent` from `./gemini.js` elsewhere, it'll pick up the real Gemini impl. Full-suite run in Task 7 catches this.
- **Ollama latency on Mac Mini**: `qwen2.5:3b-instruct` typically returns JSON in 1–3 s on Apple Silicon. Memory ingestion is fire-and-forget so no user-visible impact. Per-turn recall in `memory.ts` uses `Promise.race` with a timeout — confirm the timeout is ≥ 3 s (check `src/memory.ts:254` region if you see timeouts logged).
- **`nomic-embed-text` not pulled before Task 9** will make memory embeddings fail silently (wrapped in try/catch). Memory rows still save; duplicate detection degrades to "always miss". Task 9 Step 2 catches this.
