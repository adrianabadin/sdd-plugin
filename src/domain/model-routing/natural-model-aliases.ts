/**
 * Curated natural-language alias table for deterministic model routing.
 *
 * Extends the in-memory `ModelRouteAliasTable` consumed by `ModelRouteResolver`
 * (design 41aa141d-1bbf-4cd0-aba7-63f82f83fbd6):
 *
 *   1. Keys are the EXACT folded/natural spellings users type, e.g.
 *      `"gemini flash 3.6 tiered"` -> `google/antigravity-gemini-3.6-flash-tiered`.
 *   2. Values are exact dotted canonical identities (`provider/model`); they
 *      pass Tier 1 of `ModelRouteResolver` (and never reach Tier 3 fuzzy search).
 *   3. The table is curated and frozen at module load — never extended at runtime.
 *   4. No alias may map to more than one canonical; collisions are a CI failure.
 *      (There is no runtime collision case here because the table is hardcoded.)
 *
 * WU1 includes only the single alias required by the proposal/spec. New aliases
 * are added by curating the table below — never via configuration files or
 * runtime learning.
 */

import type { ModelRouteAliasTable } from "./model-route-resolver.js";

export const NATURAL_MODEL_ALIASES: ModelRouteAliasTable = new Map<string, string>([
  ["gemini flash 3.6 tiered", "google/antigravity-gemini-3.6-flash-tiered"],
  ["laguna s 2.1", "opencode/laguna-s-2.1-free"],
  ["laguna", "opencode/laguna-s-2.1-free"],
  ["antigravity gemini 3.6 flash tiered", "google/antigravity-gemini-3.6-flash-tiered"],
  ["kimi 3", "kimi-for-coding/k3-256k"],
  ["minimax 3", "minimax/MiniMax-M3"],
  ["gpt 5.6 luna", "openai/gpt-5.6-luna"],
  ["luna", "openai/gpt-5.6-luna"],
  ["gpt 5.6 terra", "openai/gpt-5.6-terra"],
  ["terra", "openai/gpt-5.6-terra"],
  ["gpt 5.6 sol", "openai/gpt-5.6-sol"],
  ["sol", "openai/gpt-5.6-sol"],
  ["glm 5.2", "zai-coding-plan/glm-5.2"],
  ["gemini 3.1 pro", "google/antigravity-gemini-pro-agent"],
  ["opus 5", "anthropic/claude-opus-5"],
  ["sonnet 5", "anthropic/claude-sonnet-5"],
  ["deepseek 4 flash", "opencode-go/deepseek-v4-flash"],
  ["gemini 3 flash preview", "google/gemini-3-flash-preview"],
]);

Object.freeze(NATURAL_MODEL_ALIASES);
