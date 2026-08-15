/**
 * Bounded natural-intent parser for deterministic model routing.
 *
 *  - Detects only four trigger spans, matched case- and diacritic-insensitively
 *    over a separate NFKC + Spanish-folded view: `usando <ref>`,
 *    `con el modelo <ref>`, `using model <ref>`, `@model <ref>`.
 *  - Also detects an optional effort level: `esfuerzo <level>`, `con esfuerzo <level>`,
 *    `effort <level>`. The allowed vocabulary is the canonical three:
 *    `low | medium | high`. Anything else -> `EffortLevelUnknownError`.
 *  - The original prompt bytes are NEVER mutated; the raw extracted reference
 *    is taken from the original prompt at the post-trigger position mapped
 *    via a stable character-offset index.
 *  - Reference bounds: <= 256 UTF-8 bytes, no control characters.
 *  - Zero trigger spans => null (legacy pass-through).
 *  - More than one trigger span => NaturalIntentAmbiguousError (fail closed).
 *  - Empty / whitespace-only / control-bearing / > 256-byte reference
 *    => NaturalIntentMalformedError (fail closed).
 *  - Effort is OPTIONAL. No model trigger span => null, regardless of effort
 *    phrases present in the prompt (effort only pairs with a model intent).
 *  - No LLM classifier, no fuzzy match, no inspection of `args.model`.
 *    Authoritative design: 41aa141d-1bbf-4cd0-aba7-63f82f83fbd6.
 *    Rev 2 adds effort parsing per docs/plans/2026-08-14-model-routing-whitelist-only.md.
 */

import type { NormalizedEffortLevel } from "./effort-levels.js";

export const NATURAL_INTENT_REFERENCE_MAX_BYTES = 256;

export type NaturalIntentTrigger =
  | "usando"
  | "con el modelo"
  | "using model"
  | "@model";

export interface NaturalModelIntent {
  readonly trigger: NaturalIntentTrigger;
  readonly rawReference: string;
  /** Normalized effort level, always present when a model intent is detected. */
  readonly effort: NormalizedEffortLevel;
}

export type NaturalIntentMalformedCode =
  | "EMPTY_REFERENCE_AFTER_TRIM"
  | "BYTE_LIMIT_EXCEEDED"
  | "CONTROL_CHARACTER";

export class NaturalIntentMalformedError extends Error {
  readonly code: NaturalIntentMalformedCode;
  readonly input: string;
  constructor(
    code: NaturalIntentMalformedCode,
    message: string,
    input: string,
  ) {
    super(message);
    this.name = "NaturalIntentMalformedError";
    this.code = code;
    this.input = input;
  }
}

export class NaturalIntentAmbiguousError extends Error {
  readonly count: number;
  readonly input: string;
  constructor(count: number, input: string) {
    super(
      `natural-intent input contains ${count} trigger spans; expected exactly one (usando | con el modelo | using model | @model).`,
    );
    this.name = "NaturalIntentAmbiguousError";
    this.count = count;
    this.input = input;
  }
}

export class EffortLevelUnknownError extends Error {
  readonly level: string;
  readonly input: string;
  constructor(level: string, input: string) {
    super(
      `natural-intent effort level "${level}" is unknown; expected one of: low | medium | high.`,
    );
    this.name = "EffortLevelUnknownError";
    this.level = level;
    this.input = input;
  }
}

interface TriggerMatch {
  readonly trigger: NaturalIntentTrigger;
  readonly endInFolded: number;
}

interface EffortMatch {
  readonly endInFolded: number;
  readonly startInFolded: number;
  readonly raw: string;
}

const SPANISH_DIACRITIC_FOLDS: Readonly<Record<string, string>> = Object.freeze({
  "\u00E1": "a", "\u00E0": "a", "\u00E4": "a", "\u00E2": "a", "\u00E3": "a", "\u00AA": "a",
  "\u00E9": "e", "\u00E8": "e", "\u00EB": "e", "\u00EA": "e",
  "\u00ED": "i", "\u00EC": "i", "\u00EF": "i", "\u00EE": "i",
  "\u00F3": "o", "\u00F2": "o", "\u00F6": "o", "\u00F4": "o", "\u00F5": "o",
  "\u00FA": "u", "\u00F9": "u", "\u00FC": "u", "\u00FB": "u",
  "\u00F1": "n",
  // Precomposed n-with-acute (U+0144) produced by NFKC composition of `n + U+0301`
  // when the input was in decomposed (NFD) form. Without this entry, the folded
  // view would contain `ń` instead of `n` and trigger matches would fail.
  "\u0144": "n",
  "\u00E7": "c",
});

const TRIGGER_DEFINITIONS: ReadonlyArray<{
  readonly trigger: NaturalIntentTrigger;
  readonly pattern: string;
}> = [
  { trigger: "usando", pattern: "\\busando\\b" },
  { trigger: "con el modelo", pattern: "\\bcon el modelo\\b" },
  { trigger: "using model", pattern: "\\busing model\\b" },
  { trigger: "@model", pattern: "@model\\b" },
];

const EFFORT_TRIGGER_PATTERNS: ReadonlyArray<RegExp> = [
  /\bcon\s+esfuerzo\s+(\S+)/gi,
  /\besfuerzo\s+(\S+)/gi,
  /\beffort\s+(\S+)/gi,
];

const EFFORT_LEVEL_WORDS: Readonly<Record<string, NormalizedEffortLevel>> = {
  low: "low",
  medium: "medium",
  high: "high",
};

/**
 * Build a separate detection view: NFKC + Spanish diacritic fold, with a
 * stable character-offset index that maps every folded character back to the
 * original prompt's UTF-16 code-unit position.
 *
 * The original prompt bytes are never mutated.
 */
function buildFoldedView(input: string): {
  readonly folded: string;
  readonly foldedToOriginal: ReadonlyArray<number>;
} {
  const foldedChars: string[] = [];
  const foldedToOriginal: number[] = [];
  let i = 0;
  while (i < input.length) {
    let clusterEnd = i + 1;
    while (clusterEnd < input.length) {
      const cp = input.codePointAt(clusterEnd);
      if (cp === undefined) break;
      const isCombining =
        (cp >= 0x0300 && cp <= 0x036f) ||
        (cp >= 0x1ab0 && cp <= 0x1aff) ||
        (cp >= 0x1dc0 && cp <= 0x1dff) ||
        (cp >= 0x20d0 && cp <= 0x20ff) ||
        (cp >= 0xfe20 && cp <= 0xfe2f);
      if (!isCombining) break;
      clusterEnd += 1;
    }
    const cluster = input.slice(i, clusterEnd);
    const nfkcCluster = cluster.normalize("NFKC");
    for (let k = 0; k < nfkcCluster.length; k += 1) {
      const nfkcChar = nfkcCluster.charAt(k);
      const foldedChar = SPANISH_DIACRITIC_FOLDS[nfkcChar] ?? nfkcChar;
      foldedChars.push(foldedChar);
      foldedToOriginal.push(i);
    }
    i = clusterEnd;
  }
  return { folded: foldedChars.join(""), foldedToOriginal };
}

function isWhitespaceChar(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c ||
    code === 0x0d || code === 0x20 || code === 0x85 || code === 0xa0;
}

function findTriggerMatches(folded: string): ReadonlyArray<TriggerMatch> {
  const matches: TriggerMatch[] = [];
  for (const { trigger, pattern } of TRIGGER_DEFINITIONS) {
    const regex = new RegExp(pattern, "gi");
    let m: RegExpExecArray | null;
    while ((m = regex.exec(folded)) !== null) {
      matches.push({ trigger, endInFolded: m.index + m[0].length });
      if (m.index === regex.lastIndex) regex.lastIndex += 1;
    }
  }
  matches.sort((a, b) => a.endInFolded - b.endInFolded);
  return matches;
}

/**
 * Find the FIRST effort trigger in the folded view. We deliberately
 * accept the first match only — a prompt that mentions multiple effort
 * levels is a misuse of the contract and we don't try to disambiguate.
 * The captured word is the raw token (with trailing punctuation trimmed).
 */
function findEffortMatch(folded: string): EffortMatch | null {
  for (const pattern of EFFORT_TRIGGER_PATTERNS) {
    pattern.lastIndex = 0;
    const m = pattern.exec(folded);
    if (m !== null) {
      const raw = (m[1] ?? "").replace(/[.,;:!?()\[\]{}"']+$/g, "");
      return { startInFolded: m.index, endInFolded: m.index + m[0].length, raw };
    }
  }
  return null;
}

function containsControlCharacter(value: string): { code: number } | null {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return { code };
    }
  }
  return null;
}

/**
 * Parse a prompt for bounded natural-intent model selection.
 *
 * @returns A `NaturalModelIntent` when exactly one model trigger span is
 *          present (effort defaults to `"low"` when no effort trigger is
 *          found), `null` when no model trigger is present
 *          (legacy pass-through, even if an effort-only phrase exists).
 * @throws {NaturalIntentAmbiguousError} when more than one model trigger
 *         span is present.
 * @throws {NaturalIntentMalformedError} when the extracted reference is
 *         empty, exceeds the UTF-8 byte limit, or contains a control
 *         character.
 * @throws {EffortLevelUnknownError} when the effort trigger captures a
 *         word that is not one of `low | medium | high`.
 */
export function parseNaturalModelIntent(input: string): NaturalModelIntent | null {
  if (typeof input !== "string") return null;

  const { folded, foldedToOriginal } = buildFoldedView(input);
  const matches = findTriggerMatches(folded);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new NaturalIntentAmbiguousError(matches.length, input);
  }

  const only = matches[0]!;
  const referenceStartInFolded = only.endInFolded;
  let referenceStartInOriginal =
    foldedToOriginal[referenceStartInFolded] ?? input.length;
  while (
    referenceStartInOriginal < input.length &&
    isWhitespaceChar(input.charCodeAt(referenceStartInOriginal))
  ) {
    referenceStartInOriginal += 1;
  }

  // The model reference ends at the end of the prompt, trimmed, unless
  // an effort trigger appears in the post-trigger region — in which case
  // the reference ends at the start of the effort phrase (so `usando
  // opus 5 con esfuerzo high` yields reference "opus 5", not "opus 5
  // con esfuerzo high"). This is the boundary contract: the reference is
  // the model identity; the effort phrase is metadata that pairs with it.
  let referenceEndInOriginal = input.length;
  for (const pattern of EFFORT_TRIGGER_PATTERNS) {
    pattern.lastIndex = referenceStartInFolded;
    const m = pattern.exec(folded);
    if (m !== null) {
      const endInFolded = m.index;
      const endInOriginal = foldedToOriginal[endInFolded] ?? input.length;
      if (endInOriginal < referenceEndInOriginal) referenceEndInOriginal = endInOriginal;
      break;
    }
  }
  while (
    referenceEndInOriginal > referenceStartInOriginal &&
    isWhitespaceChar(input.charCodeAt(referenceEndInOriginal - 1))
  ) {
    referenceEndInOriginal -= 1;
  }
  const rawReference = input.slice(referenceStartInOriginal, referenceEndInOriginal);

  if (rawReference.length === 0) {
    throw new NaturalIntentMalformedError(
      "EMPTY_REFERENCE_AFTER_TRIM",
      `natural-intent trigger "${only.trigger}" produced an empty reference after trimming`,
      input,
    );
  }

  const byteLength = Buffer.byteLength(rawReference, "utf8");
  if (byteLength > NATURAL_INTENT_REFERENCE_MAX_BYTES) {
    throw new NaturalIntentMalformedError(
      "BYTE_LIMIT_EXCEEDED",
      `natural-intent reference exceeds ${NATURAL_INTENT_REFERENCE_MAX_BYTES} UTF-8 bytes (got ${byteLength})`,
      input,
    );
  }

  const control = containsControlCharacter(rawReference);
  if (control !== null) {
    throw new NaturalIntentMalformedError(
      "CONTROL_CHARACTER",
      `natural-intent reference contains a control character (U+${control.code.toString(16)})`,
      input,
    );
  }

  // Effort extraction. The effort trigger may appear anywhere in the prompt;
  // we look for the first one. If found, the captured word must be one of
  // the three canonical levels; anything else -> EffortLevelUnknownError.
  const effortMatch = findEffortMatch(folded);
  let effort: NormalizedEffortLevel = "low";
  if (effortMatch !== null) {
    const word = effortMatch.raw.toLowerCase();
    const level = EFFORT_LEVEL_WORDS[word];
    if (level === undefined) {
      throw new EffortLevelUnknownError(effortMatch.raw, input);
    }
    effort = level;
  }

  return { trigger: only.trigger, rawReference, effort };
}
