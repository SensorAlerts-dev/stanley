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
