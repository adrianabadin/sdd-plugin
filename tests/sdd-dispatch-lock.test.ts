/**
 * WU4 — DL-1..DL-6: the dispatch lock mechanism (RED-first).
 * See docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md capability
 * `sdd-dispatch-lock`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  acquireDispatchLock,
  clearDispatchLock,
  inspectInFlightPhase,
  PhaseAlreadyInFlightError,
} from "../src/application/sdd/dispatch-lock.js";
import { saveArtifact } from "../src/application/sdd/save-artifact.js";
import { SddFakeStore } from "./helpers/sdd-fake-store.js";

const FakeStore = SddFakeStore;

async function runTests(): Promise<void> {
  console.log("--- sdd-dispatch-lock (RED-first) ---");

  // DL-1: acquiring sets inFlightPhase when it was null.
  {
    const next = acquireDispatchLock(null, "apply");
    assert.equal(next, "apply", "DL-1 acquiring from null sets inFlightPhase to the requested phase");
  }
  console.log("  pass: DL-1 acquiring sets inFlightPhase when it was null");

  // DL-2: a compose for a DIFFERENT phase raises PhaseAlreadyInFlightError
  // and the caller's lock value is left untouched (this function is pure —
  // "untouched" means it never returns a replacement value, it throws instead).
  {
    assert.throws(
      () => acquireDispatchLock("apply", "verify"),
      PhaseAlreadyInFlightError,
      "DL-2 acquiring for a different phase while one is in flight throws PhaseAlreadyInFlightError",
    );
    try {
      acquireDispatchLock("apply", "verify");
      assert.fail("DL-2 expected acquireDispatchLock to throw");
    } catch (err) {
      assert.ok(err instanceof PhaseAlreadyInFlightError, "DL-2 error is the named error type");
      assert.equal((err as PhaseAlreadyInFlightError).inFlightPhase, "apply", "DL-2 error names the held phase");
      assert.equal((err as PhaseAlreadyInFlightError).requestedPhase, "verify", "DL-2 error names the requested phase");
    }
  }
  console.log("  pass: DL-2 a compose for a different phase raises PhaseAlreadyInFlightError and leaves the lock intact");

  // DL-3: a compose for the SAME phase re-acquires successfully — a phase can
  // always resume itself (e.g. after its own crashed dispatch).
  {
    const next = acquireDispatchLock("apply", "apply");
    assert.equal(next, "apply", "DL-3 re-acquiring the same phase succeeds");
  }
  console.log("  pass: DL-3 a compose for the same phase re-acquires successfully");

  // DL-4: sdd_save_artifact clears inFlightPhase.
  {
    const store = new FakeStore();
    const result = await saveArtifact(store, "sdd/abc/change-x/explore", "explore content", "apply");
    assert.equal(result.ok, true, "DL-4 precondition: the write itself succeeds");
    assert.equal(result.inFlightPhase, null, "DL-4 sdd_save_artifact clears inFlightPhase to null on completion");
  }
  console.log("  pass: DL-4 sdd_save_artifact clears inFlightPhase");

  // DL-5: a lock stuck by a crashed dispatch remains visible in sdd_status —
  // never silently hidden.
  {
    const stuck = acquireDispatchLock(null, "apply");
    // Simulate "sdd_status is called sometime later" — no intervening call to
    // release or clear happened (the crash never reached sdd_save_artifact).
    const observed = inspectInFlightPhase(stuck);
    assert.equal(observed, "apply", "DL-5 a stuck lock is still reported by inspection, not hidden");
  }
  console.log("  pass: DL-5 a lock stuck by a crashed dispatch remains visible");

  // DL-6: an explicit clear releases a stuck lock, and there is no automatic
  // timeout-based release anywhere in the module.
  {
    const cleared = clearDispatchLock();
    assert.equal(cleared, null, "DL-6 an explicit clear releases a stuck lock");

    const source = readFileSync(
      new URL("../src/application/sdd/dispatch-lock.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /setTimeout|setInterval|Date\.now|expiresAt|expiry|ttl/i,
      "DL-6 the module contains no time-based/automatic release mechanism whatsoever");
  }
  console.log("  pass: DL-6 an explicit clear releases a stuck lock; no automatic timeout-based release exists");

  console.log("All sdd-dispatch-lock tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
