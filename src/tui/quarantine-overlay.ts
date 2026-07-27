/**
 * Pure overlay state machine for the `QuarantinesScreen` create / modify
 * / release flows.
 *
 * The overlay is a small, screen-local state container: the
 * `ModelControlCenter` owns the active instance as a Solid signal, the
 * `QuarantinesScreen` renders it, and a `priority-300` capture layer
 * routes characters to the focused buffer while the overlay is open.
 *
 * Validation here reuses the PR1 `validateQuarantineDraft` so the
 * readback gate in `SetQuarantineUseCase.submitDraft` is the only
 * failure path that can reach the database — invalid overlays never
 * write, never publish, and never reach the verifier.
 */
import {
  ttlHoursToUntil,
  validateQuarantineDraft,
  type QuarantineDraft,
  type QuarantineEntry,
  type QuarantineLevel,
  type QuarantineTarget,
} from "../domain/model/quarantine.js";

export type QuarantineOverlayMode = "create" | "modify" | "release";

/**
 * The focus cursor identifies which buffer receives the next character.
 * `null` is the release-overlay sentinel: there are no editable buffers,
 * only an Enter / Esc choice.
 */
export type QuarantineOverlayFocus =
  | "scope"
  | "id"
  | "reason"
  | "duration"
  | "ttl"
  | null;

export type QuarantineOverlayDuration = "permanent" | "ttl";

export interface QuarantineOverlayState {
  readonly mode: QuarantineOverlayMode;
  readonly level: Extract<QuarantineLevel, "provider" | "model">;
  readonly providerIdBuffer: string;
  readonly modelIdBuffer: string;
  readonly reasonBuffer: string;
  readonly durationKind: QuarantineOverlayDuration;
  readonly ttlHoursBuffer: string;
  readonly focus: QuarantineOverlayFocus;
  readonly targetIndex?: number;
  readonly error?: string;
}

const DEFAULT_OVERLAY_FOCUS: QuarantineOverlayFocus = "id";

function trimOrEmpty(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the initial overlay state for the given mode. `targetIndex`
 * identifies the list row the overlay is acting on (modify / release
 * only). The create overlay starts focused on the id field so the
 * operator can type the provider or model id without further navigation.
 */
export function createQuarantineOverlay(
  mode: QuarantineOverlayMode,
  targetIndex?: number,
  seed?: Partial<QuarantineEntry>,
): QuarantineOverlayState {
  const base: QuarantineOverlayState = {
    mode,
    level: seed?.level === "model" ? "model" : "provider",
    providerIdBuffer: trimOrEmpty(seed?.providerId),
    modelIdBuffer: trimOrEmpty(seed?.modelId),
    reasonBuffer: trimOrEmpty(seed?.reason),
    durationKind: seed?.type === "ttl" ? "ttl" : "permanent",
    ttlHoursBuffer: seed?.until
      ? formatRemainingHours(seed.until)
      : "",
    focus: mode === "release" ? null : DEFAULT_OVERLAY_FOCUS,
  };
  return targetIndex === undefined ? base : { ...base, targetIndex };
}

function formatRemainingHours(until: Date): string {
  const remainingMs = Math.max(0, until.getTime() - Date.now());
  const hours = remainingMs / (60 * 60 * 1000);
  if (hours < 1) {
    // Sub-hour TTL is rare; surface the value in minutes so the buffer
    // round-trips through the numeric accept contract.
    return (Math.round(remainingMs / 60000) / 60).toString();
  }
  return hours.toString();
}

/**
 * Identifier of the buffer slot on the overlay state. `providerId` and
 * `modelId` are routed by the current `level`; the overlay state keeps
 * both buffers so a level switch is non-destructive.
 */
export type QuarantineOverlayBuffer =
  | "providerId"
  | "modelId"
  | "reason"
  | "ttlHours";

/**
 * Append a character (or backspace sentinel) to the named buffer using
 * the shared typed accept contract. Returns a new overlay state with the
 * error cleared so the operator can recover from a prior validation
 * failure by typing.
 */
export function updateQuarantineOverlayBuffer(
  overlay: QuarantineOverlayState,
  buffer: QuarantineOverlayBuffer,
  rawInput: string,
): QuarantineOverlayState {
  const current =
    buffer === "providerId"
      ? overlay.providerIdBuffer
      : buffer === "modelId"
        ? overlay.modelIdBuffer
        : buffer === "reason"
          ? overlay.reasonBuffer
          : overlay.ttlHoursBuffer;

  let next: string;
  if (rawInput === "<backspace>") {
    next = current.slice(0, -1);
  } else if (buffer === "ttlHours") {
    const accepted = acceptNumericBuffer(current, rawInput);
    next = accepted ?? current;
  } else {
    // providerId / modelId / reason are text buffers; every printable
    // character appends, no per-character validation.
    next = rawInput.length > 0 ? current + rawInput : current;
  }

  const partial: QuarantineOverlayState =
    buffer === "providerId"
      ? { ...overlay, providerIdBuffer: next }
      : buffer === "modelId"
        ? { ...overlay, modelIdBuffer: next }
        : buffer === "reason"
          ? { ...overlay, reasonBuffer: next }
          : { ...overlay, ttlHoursBuffer: next };

  return clearOverlayError(partial);
}

const NUMERIC_DIGIT = /^[0-9]$/;

/**
 * Mirrors `acceptNumericBuffer` from `model-detail-field-edit.ts` so the
 * overlay buffer behaves identically to the existing numeric descriptor
 * (digits + a single decimal, second decimal rejected). Duplicated
 * here to keep the overlay module self-contained and free of any
 * import cycle with the field editor.
 */
function acceptNumericBuffer(buffer: string, input: string): string | null {
  if (NUMERIC_DIGIT.test(input)) return buffer + input;
  if (input === "." && !buffer.includes(".")) return buffer + input;
  return null;
}

const FOCUS_ORDER: readonly Exclude<QuarantineOverlayFocus, null>[] = [
  "scope",
  "id",
  "reason",
  "duration",
  "ttl",
];

export function setQuarantineOverlayFocus(
  overlay: QuarantineOverlayState,
  focus: QuarantineOverlayFocus,
): QuarantineOverlayState {
  if (overlay.mode === "release") {
    return { ...overlay, focus: null };
  }
  if (focus === "ttl" && overlay.durationKind !== "ttl") {
    // Ttl focus only makes sense when the duration is ttl.
    return { ...overlay, focus: "duration" };
  }
  return { ...overlay, focus };
}

export function cycleQuarantineOverlayFocus(
  overlay: QuarantineOverlayState,
  direction: "next" | "prev",
): QuarantineOverlayState {
  if (overlay.mode === "release") return overlay;
  const enabled = FOCUS_ORDER.filter(
    (slot) => slot !== "ttl" || overlay.durationKind === "ttl",
  );
  const currentIdx = enabled.indexOf(overlay.focus as Exclude<QuarantineOverlayFocus, null>);
  const nextIdx =
    direction === "next"
      ? (currentIdx + 1) % enabled.length
      : (currentIdx - 1 + enabled.length) % enabled.length;
  const nextFocus = enabled[nextIdx] ?? "id";
  return setQuarantineOverlayFocus(overlay, nextFocus);
}

export function setQuarantineOverlayDuration(
  overlay: QuarantineOverlayState,
  duration: QuarantineOverlayDuration,
): QuarantineOverlayState {
  const next: QuarantineOverlayState = {
    ...overlay,
    durationKind: duration,
  };
  // If the user switches back to permanent, the ttl focus has nowhere
  // to land; move to duration.
  if (duration === "permanent" && overlay.focus === "ttl") {
    return { ...next, focus: "duration" };
  }
  return next;
}

export function setQuarantineOverlayLevel(
  overlay: QuarantineOverlayState,
  level: Extract<QuarantineLevel, "provider" | "model">,
): QuarantineOverlayState {
  return { ...overlay, level };
}

export function setQuarantineOverlayError(
  overlay: QuarantineOverlayState,
  error: string,
): QuarantineOverlayState {
  return { ...overlay, error };
}

export function clearOverlayError(
  overlay: QuarantineOverlayState,
): QuarantineOverlayState {
  if (overlay.error === undefined) return overlay;
  const { error: _drop, ...rest } = overlay;
  return rest as QuarantineOverlayState;
}

/**
 * Build a `QuarantineDraft` from the overlay state. The builder trims
 * the reason and the relevant id, but does NOT validate: callers should
 * use `validateQuarantineOverlayBuffers` before reaching the use case.
 */
export function buildQuarantineDraft(
  overlay: QuarantineOverlayState,
): QuarantineDraft {
  if (overlay.mode === "release") {
    throw new Error("buildQuarantineDraft called on a release overlay");
  }
  const reason = overlay.reasonBuffer.trim();
  if (overlay.level === "provider") {
    return {
      level: "provider",
      providerId: overlay.providerIdBuffer.trim(),
      reason,
      duration:
        overlay.durationKind === "ttl"
          ? { kind: "ttl", hours: Number(overlay.ttlHoursBuffer) }
          : { kind: "permanent" },
    };
  }
  return {
    level: "model",
    modelId: overlay.modelIdBuffer.trim(),
    reason,
    duration:
      overlay.durationKind === "ttl"
        ? { kind: "ttl", hours: Number(overlay.ttlHoursBuffer) }
        : { kind: "permanent" },
  };
}

export interface QuarantineOverlayValidationOk {
  readonly ok: true;
  readonly draft: QuarantineDraft;
}

export interface QuarantineOverlayValidationErr {
  readonly ok: false;
  readonly error: string;
}

export type QuarantineOverlayValidationResult =
  | QuarantineOverlayValidationOk
  | QuarantineOverlayValidationErr;

/**
 * Validate the overlay buffers against the PR1
 * `validateQuarantineDraft` contract. The duration's TTL hours are
 * routed through `ttlHoursToUntil` so the same numeric invariants
 * apply to both the persisted draft and the live buffer.
 */
export function validateQuarantineOverlayBuffers(
  draft: QuarantineDraft,
): QuarantineOverlayValidationResult {
  if (draft.duration.kind === "ttl") {
    try {
      // Round-trip through the converter so the same RangeError policy
      // (positive finite number) catches a non-numeric buffer before
      // validateQuarantineDraft inspects it.
      ttlHoursToUntil(draft.duration.hours);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Invalid TTL hours",
      };
    }
  }
  const result = validateQuarantineDraft(draft);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, draft };
}

/**
 * Build the `QuarantineTarget` the release overlay would release. The
 * caller is responsible for routing the result through
 * `releaseQuarantineUseCase.releaseFromTarget` (which honors the PR2
 * readback gate).
 */
export function buildQuarantineTarget(
  overlay: QuarantineOverlayState,
  target: QuarantineEntry,
): QuarantineTarget {
  if (overlay.mode !== "release") {
    throw new Error("buildQuarantineTarget called on a non-release overlay");
  }
  const result: QuarantineTarget = { level: target.level };
  if (target.providerId !== undefined) result.providerId = target.providerId;
  if (target.modelId !== undefined) result.modelId = target.modelId;
  return result;
}
