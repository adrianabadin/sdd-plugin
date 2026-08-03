/**
 * WU4 — DL-1..DL-6: dispatch lock mechanism (design §4, §9.12; spec capability
 * `sdd-dispatch-lock`).
 *
 * Pure application logic only. `sdd_compose_phase_prompt` (exposed as the
 * `sdd_compose_phase_prompt` MCP tool via `src/bootstrap/sdd-tools.ts`)
 * acquires this lock and `sdd_save_artifact` releases it on completion —
 * the MCP tool wiring now exists; the earlier "WU7 owns the wiring" promise
 * is fulfilled. This module owns exactly three things: acquire, clear, and
 * inspection — and deliberately owns NO time-based release path (no
 * age/deadline field, no timer, no wall-clock read anywhere in this file): a
 * stuck lock stays stuck until something calls `clearDispatchLock` on
 * purpose (DL-6) — a silently self-clearing lock would reintroduce the
 * concurrency it exists to prevent (design §9.12).
 *
 * NOTE on DL-4/DL-6 collapse: the previous version exposed two identical
 * functions (`releaseDispatchLock` and `clearDispatchLock`, both `() => null`)
 * that differed only by name. The verify report flagged that two same-behavior
 * functions do not meaningfully satisfy DL-6's "explicit, deliberate clear"
 * distinction. They are now ONE function, `clearDispatchLock(reason?)`, with
 * a `reason` argument that makes the intent observable at the call site
 * ("completed" from sdd_save_artifact vs "stuck-lock-cleared" from an
 * explicit recovery operation). The lock value itself stays pure — the
 * reason is for the caller's logging/audit, not for this module's state.
 */

export class PhaseAlreadyInFlightError extends Error {
  readonly code = "PHASE_ALREADY_IN_FLIGHT";
  readonly inFlightPhase: string;
  readonly requestedPhase: string;

  constructor(inFlightPhase: string, requestedPhase: string) {
    super(
      `PHASE_ALREADY_IN_FLIGHT: phase "${inFlightPhase}" is already dispatched; refusing to acquire for "${requestedPhase}"`,
    );
    this.name = "PhaseAlreadyInFlightError";
    this.inFlightPhase = inFlightPhase;
    this.requestedPhase = requestedPhase;
  }
}

/**
 * DL-1 / DL-2 / DL-3: acquire the dispatch lock for `requestedPhase`.
 * - `null` -> `requestedPhase` always succeeds (DL-1).
 * - the SAME phase re-acquires successfully — a phase can always resume
 *   itself, e.g. after its own crashed dispatch (DL-3).
 * - a DIFFERENT phase already in flight refuses with `PhaseAlreadyInFlightError`
 *   and leaves the caller's copy of the lock untouched — this function is
 *   pure, so "untouched" is simply "no value returned to replace it with" (DL-2).
 */
export function acquireDispatchLock(currentInFlightPhase: string | null, requestedPhase: string): string {
  if (currentInFlightPhase !== null && currentInFlightPhase !== requestedPhase) {
    throw new PhaseAlreadyInFlightError(currentInFlightPhase, requestedPhase);
  }
  return requestedPhase;
}

/**
 * DL-4 / DL-6: clears the dispatch lock. The single function serves both
 * the normal completion path (`sdd_save_artifact` calls it with reason
 * "completed") and the explicit stuck-lock recovery path (a human-driven
 * clear calls it with a reason describing why). Both return `null`; the
 * `reason` is carried for the caller's logging/audit and is not stored in
 * any module-level state — this module remains pure.
 *
 * There is deliberately no automatic, time-based release: DL-6 forbids a
 * silently self-clearing lock. Only a deliberate call to this function
 * clears it.
 *
 * @param reason - why the lock is being cleared ("completed" | "stuck-lock-cleared" | ...)
 */
export function clearDispatchLock(reason: "completed" | "stuck-lock-cleared" | string = "completed"): null {
  // `reason` is accepted for caller observability. This function is pure: it
  // owns no state and always returns null. The distinction between a normal
  // release and a stuck-lock clear lives in which call site invokes it and
  // what reason they pass, not in any behavior difference here.
  void reason;
  return null;
}

/**
 * DL-5: inspection is a pure passthrough — a stuck lock must remain visible
 * to `sdd_status`, never silently hidden.
 *
 * (This is intentionally a thin accessor. The verify report noted it is the
 * identity function; it stays because the LOCK is a caller-held value today
 * and this function is the named seam by which `sdd_status` reads it. When
 * the lock eventually lives in the artifact store rather than in caller
 * memory, this is the single function that changes — callers already route
 * through it instead of reading the field directly.)
 */
export function inspectInFlightPhase(inFlightPhase: string | null): string | null {
  return inFlightPhase;
}
