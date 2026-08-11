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
  isQuarantineActive,
  ttlHoursToUntil,
  validateQuarantineDraft,
  type QuarantineDraft,
  type QuarantineEntry,
  type QuarantineLevel,
  type QuarantineTarget,
} from "../domain/model/quarantine.js";
import { buildProviderSummaries, filterModels } from "./catalog-view.js";
import type { ConnectedModelInfo } from "../domain/model/connected-model.js";

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

export interface QuarantineProviderCandidate {
  readonly kind: "provider";
  readonly providerId: string;
  readonly modelCount: number;
}

export interface QuarantineModelCandidate {
  readonly kind: "modelProvider";
  readonly providerId: string;
  readonly modelId: string;
  readonly modelName: string;
}

export type QuarantineCandidate =
  | QuarantineProviderCandidate
  | QuarantineModelCandidate;

export const CREATE_LEVELS: readonly QuarantineLevel[] = ["provider", "modelProvider"];
export const MODIFY_LEVELS: readonly QuarantineLevel[] = ["provider", "model", "modelProvider"];
export const CANDIDATE_WINDOW_SIZE = 8;
export const NO_CANDIDATE_SELECTED_ERROR =
  "Select a connected target before committing";

export interface QuarantineOverlayState {
  readonly mode: QuarantineOverlayMode;
  readonly level: QuarantineLevel;
  readonly providerIdBuffer: string;
  readonly modelIdBuffer: string;
  readonly reasonBuffer: string;
  readonly durationKind: QuarantineOverlayDuration;
  readonly ttlHoursBuffer: string;
  readonly focus: QuarantineOverlayFocus;
  readonly filterQueryBuffer: string;
  readonly candidateIndex: number;
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
    level: mode === "create" ? "provider" : (seed?.level ?? "provider"),
    providerIdBuffer: trimOrEmpty(seed?.providerId),
    modelIdBuffer: trimOrEmpty(seed?.modelId),
    reasonBuffer: trimOrEmpty(seed?.reason),
    durationKind: seed?.type === "ttl" ? "ttl" : "permanent",
    ttlHoursBuffer: seed?.until
      ? formatRemainingHours(seed.until)
      : "",
    focus: mode === "release" ? null : DEFAULT_OVERLAY_FOCUS,
    filterQueryBuffer: "",
    candidateIndex: 0,
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

export function updateQuarantineOverlayFilter(
  overlay: QuarantineOverlayState,
  rawInput: string,
): QuarantineOverlayState {
  if (overlay.mode !== "create" || overlay.level !== "modelProvider") {
    return overlay;
  }
  let nextText = overlay.filterQueryBuffer;
  if (rawInput === "<backspace>") {
    nextText = nextText.slice(0, -1);
  } else if (rawInput.length > 0) {
    nextText += rawInput;
  }
  if (nextText === overlay.filterQueryBuffer) return overlay;
  const nextState: QuarantineOverlayState = {
    ...overlay,
    filterQueryBuffer: nextText,
    candidateIndex: 0,
  };
  return clearOverlayError(nextState);
}

export function setQuarantineOverlayLevel(
  overlay: QuarantineOverlayState,
  level: QuarantineLevel,
): QuarantineOverlayState {
  if (overlay.mode === "create" && level === "model") {
    return overlay;
  }
  if (overlay.level === level) return overlay;
  const next: QuarantineOverlayState = {
    ...overlay,
    level,
    filterQueryBuffer: overlay.mode === "create" ? "" : overlay.filterQueryBuffer,
    candidateIndex: overlay.mode === "create" ? 0 : overlay.candidateIndex,
  };
  return clearOverlayError(next);
}

export function cycleQuarantineOverlayLevel(
  overlay: QuarantineOverlayState,
  direction: "next" | "prev",
): QuarantineOverlayState {
  if (overlay.mode === "release") return overlay;
  const levels = overlay.mode === "create" ? CREATE_LEVELS : MODIFY_LEVELS;
  const currentIdx = levels.indexOf(overlay.level);
  const baseIdx = currentIdx === -1 ? 0 : currentIdx;
  const nextIdx =
    direction === "next"
      ? (baseIdx + 1) % levels.length
      : (baseIdx - 1 + levels.length) % levels.length;
  const targetLevel = levels[nextIdx] ?? "provider";
  return setQuarantineOverlayLevel(overlay, targetLevel);
}

export function resolveQuarantineCandidates(
  overlay: QuarantineOverlayState | null | undefined,
  models: ReadonlyArray<ConnectedModelInfo>,
): QuarantineCandidate[] {
  if (!overlay || overlay.mode !== "create") return [];
  if (overlay.level === "provider") {
    return buildProviderSummaries(models).map((p) => ({
      kind: "provider",
      providerId: p.providerId,
      modelCount: p.modelCount,
    }));
  }
  if (overlay.level === "modelProvider") {
    return filterModels(models, overlay.filterQueryBuffer).map((m) => ({
      kind: "modelProvider",
      providerId: m.providerId,
      modelId: m.modelId,
      modelName: m.modelName,
    }));
  }
  return [];
}

export function clampCandidateIndex(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), count - 1);
}

export function moveQuarantineCandidateCursor(
  overlay: QuarantineOverlayState,
  direction: "up" | "down",
  candidateCount: number,
): QuarantineOverlayState {
  if (candidateCount <= 0 || overlay.mode !== "create") return overlay;
  const base = clampCandidateIndex(overlay.candidateIndex, candidateCount);
  const nextIndex =
    direction === "down"
      ? (base + 1) % candidateCount
      : (base - 1 + candidateCount) % candidateCount;
  const nextState: QuarantineOverlayState = {
    ...overlay,
    candidateIndex: nextIndex,
  };
  return clearOverlayError(nextState);
}

export function resolveSelectedCandidate(
  overlay: QuarantineOverlayState,
  candidates: readonly QuarantineCandidate[],
): QuarantineCandidate | null {
  if (candidates.length === 0) return null;
  const idx = clampCandidateIndex(overlay.candidateIndex, candidates.length);
  return candidates[idx] ?? null;
}

export function isCandidateShadowed(
  candidate: QuarantineCandidate,
  entries: ReadonlyArray<QuarantineEntry>,
  now = new Date(),
): boolean {
  if (candidate.kind !== "modelProvider") return false;
  return entries.some((e) => {
    if (!isQuarantineActive(e, now)) return false;
    if (e.level === "provider" && e.providerId === candidate.providerId) return true;
    if (e.level === "model" && e.modelId === candidate.modelId) return true;
    return false;
  });
}

export function formatCandidateLabel(candidate: QuarantineCandidate): string {
  if (candidate.kind === "provider") {
    return `${candidate.providerId} (${candidate.modelCount} ${candidate.modelCount === 1 ? "model" : "models"})`;
  }
  return `${candidate.providerId} / ${candidate.modelName} [${candidate.modelId}]`;
}

export function computeCandidateWindow(
  index: number,
  total: number,
  size = CANDIDATE_WINDOW_SIZE,
): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  const i = clampCandidateIndex(index, total);
  const s = Math.max(0, Math.min(i - Math.floor(size / 2), total - size));
  const start = Math.max(0, s);
  const end = Math.min(total, start + size);
  return { start, end };
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

export function buildQuarantineDraftFromCandidate(
  overlay: QuarantineOverlayState,
  candidate: QuarantineCandidate,
): QuarantineDraft {
  if (overlay.mode !== "create") {
    throw new Error("buildQuarantineDraftFromCandidate called on a non-create overlay");
  }
  if (candidate.kind !== overlay.level) {
    throw new Error("Candidate kind does not match the overlay level");
  }
  const reason = overlay.reasonBuffer.trim();
  const duration =
    overlay.durationKind === "ttl"
      ? { kind: "ttl" as const, hours: Number(overlay.ttlHoursBuffer) }
      : { kind: "permanent" as const };

  if (candidate.kind === "provider") {
    return {
      level: "provider",
      providerId: candidate.providerId,
      reason,
      duration,
    };
  }

  return {
    level: "modelProvider",
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    reason,
    duration,
  };
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
  const duration =
    overlay.durationKind === "ttl"
      ? { kind: "ttl" as const, hours: Number(overlay.ttlHoursBuffer) }
      : { kind: "permanent" as const };

  if (overlay.level === "provider") {
    return {
      level: "provider",
      providerId: overlay.providerIdBuffer.trim(),
      reason,
      duration,
    };
  }
  if (overlay.level === "modelProvider") {
    return {
      level: "modelProvider",
      providerId: overlay.providerIdBuffer.trim(),
      modelId: overlay.modelIdBuffer.trim(),
      reason,
      duration,
    };
  }
  return {
    level: "model",
    modelId: overlay.modelIdBuffer.trim(),
    reason,
    duration,
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
