/**
 * Localized fail-closed errors for the natural-intent routing path (WU2).
 *
 * Each error carries BOTH an English (`messageEn`) and a Spanish (`messageEs`)
 * actionable message. The hook throws the error BEFORE child creation; the
 * OpenCode task runtime surfaces the message in the caller's locale-aware
 * UI / log stream.
 *
 * Codes are stable identifiers the host can match on (e.g. for telemetry or
 * for surfacing "did the user write a malformed trigger or a typo?") —
 * human-readable text lives in the localized fields.
 *
 * Authoritative design: 41aa141d-1bbf-4cd0-aba7-63f82f83fbd6.
 */

import {
  NaturalIntentAmbiguousError,
  NaturalIntentMalformedError,
} from "./natural-model-intent.js";

export type NaturalIntentErrorCode =
  | "NATURAL_INTENT_AMBIGUOUS"
  | "NATURAL_INTENT_MALFORMED"
  | "NATURAL_ROUTE_UNKNOWN"
  | "NATURAL_ROUTE_AMBIGUOUS";

export interface NaturalIntentErrorExtras {
  readonly trigger?: string | undefined;
  readonly reference?: string | undefined;
  readonly candidates?: ReadonlyArray<{ providerId: string; modelId: string; modelName?: string }> | undefined;
}

export class NaturalIntentBlockedError extends Error {
  readonly code: NaturalIntentErrorCode;
  readonly messageEn: string;
  readonly messageEs: string;
  readonly trigger: string | undefined;
  readonly reference: string | undefined;
  readonly candidates: ReadonlyArray<{ providerId: string; modelId: string; modelName?: string }>;

  constructor(input: {
    code: NaturalIntentErrorCode;
    messageEn: string;
    messageEs: string;
    extras?: NaturalIntentErrorExtras;
  }) {
    // Default `message` is the English form; Spanish is exposed via `messageEs`.
    super(input.messageEn);
    this.name = "NaturalIntentBlockedError";
    this.code = input.code;
    this.messageEn = input.messageEn;
    this.messageEs = input.messageEs;
    this.trigger = input.extras?.trigger;
    this.reference = input.extras?.reference;
    this.candidates = input.extras?.candidates ?? [];
  }

  /**
   * Render the error in a single language. Used by the bootstrap to pick
   * the operator's preferred locale at the point of throwing, so the
   * surfaced string is always the requested one.
   */
  format(locale: "en" | "es"): string {
    return locale === "es" ? this.messageEs : this.messageEn;
  }
}

function buildUnknownReferenceMessage(reference: string): { en: string; es: string } {
  return {
    en:
      `Natural routing could not resolve "${reference}" against the catalog. ` +
      `Use the explicit "model-route:v1|base|reference" grammar or check that the model is connected and registered.`,
    es:
      `El enrutamiento natural no pudo resolver "${reference}" en el catálogo. ` +
      `Usa la gramática explícita "model-route:v1|base|referencia" o verifica que el modelo esté conectado y registrado.`,
  };
}

function buildAmbiguousCandidatesMessage(
  reference: string,
  candidates: ReadonlyArray<{ providerId: string; modelId: string; modelName?: string }>,
): { en: string; es: string } {
  const formatted = candidates
    .map((c) => `  - ${c.providerId}/${c.modelId}${c.modelName ? ` (${c.modelName})` : ""}`)
    .join("\n");
  return {
    en:
      `Natural routing for "${reference}" matched ${candidates.length} candidates; expected exactly one.\n` +
      `Candidates:\n${formatted}\n` +
      `Refine the reference to a single canonical identity, or use the explicit "model-route:v1|base|reference" grammar.`,
    es:
      `El enrutamiento natural para "${reference}" coincidió con ${candidates.length} candidatos; se esperaba exactamente uno.\n` +
      `Candidatos:\n${formatted}\n` +
      `Refina la referencia a una única identidad canónica o usa la gramática explícita "model-route:v1|base|referencia".`,
  };
}

function buildAmbiguousTriggerMessage(count: number): { en: string; es: string } {
  return {
    en:
      `The prompt contains ${count} natural-intent triggers; expected exactly one.\n` +
      `Only one of: "usando <ref>", "con el modelo <ref>", "using model <ref>", "@model <ref>" may appear.`,
    es:
      `El prompt contiene ${count} disparadores de intención natural; se esperaba exactamente uno.\n` +
      `Solo puede aparecer uno de: "usando <ref>", "con el modelo <ref>", "using model <ref>", "@model <ref>".`,
  };
}

function buildMalformedReferenceMessage(
  trigger: string,
  code: "EMPTY_REFERENCE_AFTER_TRIM" | "BYTE_LIMIT_EXCEEDED" | "CONTROL_CHARACTER",
  details: string,
): { en: string; es: string } {
  switch (code) {
    case "EMPTY_REFERENCE_AFTER_TRIM":
      return {
        en: `Natural trigger "${trigger}" was followed by an empty or whitespace-only reference. Add a model name after the trigger.`,
        es: `El disparador natural "${trigger}" fue seguido por una referencia vacía o solo espacios. Agrega un nombre de modelo después del disparador.`,
      };
    case "BYTE_LIMIT_EXCEEDED":
      return {
        en: `Natural trigger "${trigger}" reference exceeds the 256-byte limit (${details}). Shorten the reference or use the explicit grammar.`,
        es: `La referencia del disparador natural "${trigger}" supera el límite de 256 bytes (${details}). Acorta la referencia o usa la gramática explícita.`,
      };
    case "CONTROL_CHARACTER":
      return {
        en: `Natural trigger "${trigger}" reference contains a control character (${details}). Remove the control character and retry.`,
        es: `La referencia del disparador natural "${trigger}" contiene un carácter de control (${details}). Elimina el carácter de control y vuelve a intentarlo.`,
      };
  }
}

/**
 * Build a fail-closed error for an unknown natural reference. Used when the
 * resolver returns `RouteUnknownError` for a natural reference.
 */
export function naturalRouteUnknownError(reference: string): NaturalIntentBlockedError {
  const { en, es } = buildUnknownReferenceMessage(reference);
  return new NaturalIntentBlockedError({
    code: "NATURAL_ROUTE_UNKNOWN",
    messageEn: en,
    messageEs: es,
    extras: { reference },
  });
}

/**
 * Build a fail-closed error for an ambiguous natural resolution. Used when
 * the resolver returns `RouteAmbiguousError` for a natural reference.
 */
export function naturalRouteAmbiguousError(
  reference: string,
  candidates: ReadonlyArray<{ providerId: string; modelId: string; modelName?: string }>,
): NaturalIntentBlockedError {
  const { en, es } = buildAmbiguousCandidatesMessage(reference, candidates);
  return new NaturalIntentBlockedError({
    code: "NATURAL_ROUTE_AMBIGUOUS",
    messageEn: en,
    messageEs: es,
    extras: { reference, candidates },
  });
}

/**
 * Build a fail-closed error for an ambiguous natural-intent trigger span
 * (more than one trigger in the prompt). Mirrors the WU1 parser contract.
 */
export function naturalIntentAmbiguousError(count: number, triggerHint?: string): NaturalIntentBlockedError {
  const { en, es } = buildAmbiguousTriggerMessage(count);
  return new NaturalIntentBlockedError({
    code: "NATURAL_INTENT_AMBIGUOUS",
    messageEn: en,
    messageEs: es,
    extras: { trigger: triggerHint },
  });
}

/**
 * Build a fail-closed error for a malformed natural reference (empty, too
 * long, or contains a control character). Mirrors the WU1 parser contract.
 */
export function naturalIntentMalformedError(
  trigger: string,
  code: "EMPTY_REFERENCE_AFTER_TRIM" | "BYTE_LIMIT_EXCEEDED" | "CONTROL_CHARACTER",
  details: string,
): NaturalIntentBlockedError {
  const { en, es } = buildMalformedReferenceMessage(trigger, code, details);
  return new NaturalIntentBlockedError({
    code: "NATURAL_INTENT_MALFORMED",
    messageEn: en,
    messageEs: es,
    extras: { trigger, reference: details },
  });
}

/**
 * Convert a WU1 parser error directly into a localized fail-closed
 * error. Used at the bootstrap boundary to short-circuit the natural
 * path BEFORE invoking the hook, so the operator sees the localized
 * error even if the hook itself is misconfigured.
 */
export function naturalIntentBlockedFromParse(
  error: NaturalIntentAmbiguousError | NaturalIntentMalformedError,
  prompt: string,
): NaturalIntentBlockedError {
  if (error instanceof NaturalIntentAmbiguousError) {
    return naturalIntentAmbiguousError(error.count);
  }
  // NaturalIntentMalformedError
  const details = error.code === "BYTE_LIMIT_EXCEEDED"
    ? `input was ${Buffer.byteLength(prompt, "utf8")} bytes`
    : error.code === "CONTROL_CHARACTER"
      ? "see original input"
      : "reference was empty after trimming";
  return naturalIntentMalformedError("natural", error.code, details);
}
