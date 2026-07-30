/**
 * Reserved subagent_type grammar: `model-route:v1|<base>|<reference>`.
 *
 *  - Non-prefixed inputs return null (legacy pass-through).
 *  - Malformed reserved prefixes throw ModelRouteGrammarError.
 *  - Total input is bounded to 256 UTF-8 bytes; reference to 160 bytes;
 *    base matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
 *  - The reference is NFKC-normalized and trimmed; no `|`, no controls.
 *  - Pure parser: no persistence, no transport, no identity metadata.
 *  Authoritative design: c96148ae-04f9-468f-9ca7-e14456dc1513.
 */

export const MODEL_ROUTE_MAX_BYTES = 256;
export const MODEL_ROUTE_REFERENCE_MAX_BYTES = 160;
export const MODEL_ROUTE_BASE_MAX_LENGTH = 64;

const RESERVED_PREFIX = "model-route:";
const VERSION_V1 = "v1";
const BASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ModelRouteGrammarErrorCode =
  | "MISSING_VERSION"
  | "UNSUPPORTED_VERSION"
  | "INVALID_SEPARATOR_COUNT"
  | "MALFORMED_BASE"
  | "MALFORMED_REFERENCE"
  | "BYTE_LIMIT_EXCEEDED";

export class ModelRouteGrammarError extends Error {
  readonly code: ModelRouteGrammarErrorCode;
  readonly input: string;
  constructor(code: ModelRouteGrammarErrorCode, message: string, input: string) {
    super(message);
    this.name = "ModelRouteGrammarError";
    this.code = code;
    this.input = input;
  }
}

export interface ParsedModelRouteV1 {
  readonly version: "v1";
  readonly base: string;
  readonly reference: string;
}

export function parseModelRouteGrammar(input: string): ParsedModelRouteV1 | null {
  if (typeof input !== "string" || !input.startsWith(RESERVED_PREFIX)) return null;

  const totalBytes = Buffer.byteLength(input, "utf8");
  if (totalBytes > MODEL_ROUTE_MAX_BYTES) {
    throw new ModelRouteGrammarError(
      "BYTE_LIMIT_EXCEEDED",
      `model-route input exceeds ${MODEL_ROUTE_MAX_BYTES} UTF-8 bytes (got ${totalBytes})`,
      input,
    );
  }

  const afterPrefix = input.slice(RESERVED_PREFIX.length);
  if (afterPrefix.length === 0) {
    throw new ModelRouteGrammarError("MISSING_VERSION", "model-route prefix without version segment", input);
  }

  const firstPipe = afterPrefix.indexOf("|");
  if (firstPipe === -1) {
    throw new ModelRouteGrammarError(
      "INVALID_SEPARATOR_COUNT",
      "model-route input has no '|' separators after version",
      input,
    );
  }
  const versionSegment = afterPrefix.slice(0, firstPipe);
  if (versionSegment.length === 0) {
    throw new ModelRouteGrammarError("MISSING_VERSION", "model-route version segment is empty", input);
  }
  if (versionSegment !== VERSION_V1) {
    throw new ModelRouteGrammarError(
      "UNSUPPORTED_VERSION",
      `unsupported model-route version "${versionSegment}" (only "${VERSION_V1}" is defined)`,
      input,
    );
  }

  const segments = afterPrefix.slice(firstPipe + 1).split("|");
  if (segments.length !== 2) {
    throw new ModelRouteGrammarError(
      "INVALID_SEPARATOR_COUNT",
      `model-route v1 input must have exactly two '|' separators after the version (got ${segments.length - 1})`,
      input,
    );
  }
  const [baseRaw, referenceRaw] = segments;
  if (typeof baseRaw !== "string" || baseRaw.length === 0 || !BASE_PATTERN.test(baseRaw)) {
    throw new ModelRouteGrammarError(
      "MALFORMED_BASE",
      typeof baseRaw !== "string" || baseRaw.length === 0
        ? "model-route v1 base segment is empty"
        : `model-route v1 base "${baseRaw}" does not match ${BASE_PATTERN}`,
      input,
    );
  }

  if (typeof referenceRaw !== "string" || referenceRaw.length === 0) {
    throw new ModelRouteGrammarError("MALFORMED_REFERENCE", "model-route v1 reference segment is empty", input);
  }
  const normalizedReference = referenceRaw.normalize("NFKC").trim();
  if (normalizedReference.length === 0) {
    throw new ModelRouteGrammarError(
      "MALFORMED_REFERENCE",
      "model-route v1 reference is empty after NFKC + trim",
      input,
    );
  }
  if (normalizedReference.includes("|")) {
    throw new ModelRouteGrammarError("MALFORMED_REFERENCE", "model-route v1 reference must not contain '|'", input);
  }
  const referenceBytes = Buffer.byteLength(normalizedReference, "utf8");
  if (referenceBytes > MODEL_ROUTE_REFERENCE_MAX_BYTES) {
    throw new ModelRouteGrammarError(
      "MALFORMED_REFERENCE",
      `model-route v1 reference exceeds ${MODEL_ROUTE_REFERENCE_MAX_BYTES} UTF-8 bytes (got ${referenceBytes})`,
      input,
    );
  }
  for (let i = 0; i < normalizedReference.length; i++) {
    const code = normalizedReference.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new ModelRouteGrammarError(
        "MALFORMED_REFERENCE",
        `model-route v1 reference contains a control character (U+${code.toString(16)})`,
        input,
      );
    }
  }

  return { version: VERSION_V1, base: baseRaw, reference: normalizedReference };
}