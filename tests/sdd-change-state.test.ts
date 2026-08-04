/**
 * Task 2: durable change state behind the SDD artifact-store/MCP boundary.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SddChangeStateIndexPersistenceError,
  SddChangeStateLockConflictError,
  SddChangeStateSentinelBindingConflictError,
  SddChangeStateVersionConflictError,
  type SddChangeStateInput,
} from "../src/ports/sdd-artifact-store.port.js";
import type { McpToolClientPort } from "../src/ports/mcp-tool-client.port.js";
import { PmcSddArtifactStoreAdapter } from "../src/infrastructure/pmc/pmc-sdd-artifact-store.adapter.js";
import { SqliteMcpToolClient } from "../src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.js";

function changeState(projectRoot: string, changeName: string): SddChangeStateInput {
  return {
    projectRoot,
    changeName,
    artifactIndex: ["proposal.md", "spec.md"],
    baselineFingerprint: "baseline-123",
  };
}

// 30s accommodates Windows process spawn overhead + SQLite initialization on
// slower CI runners; the barrier is only used by the cross-process OCC race
// tests where two SqliteMcpToolClient instances rendezvous at the state
// read. Bounded so a forgotten participant still produces a fast, named
// diagnostic rather than hanging the suite.
const STATE_READ_BARRIER_TIMEOUT_MS = 30_000;

/** Forces every index write to conflict while leaving state writes durable. */
class ExhaustedIndexConflictClient implements McpToolClientPort {
  public rejectIndexWrites = true;

  constructor(private readonly delegate: McpToolClientPort) {}

  async callTool<TResult = unknown>(toolName: string, args: Readonly<Record<string, unknown>>): Promise<TResult> {
    if (this.rejectIndexWrites && toolName === "pmc-agent-memory_store" && args.kind === "sdd-change-state-index") {
      return { version: 0, conflict: true } as TResult;
    }
    return this.delegate.callTool<TResult>(toolName, args);
  }
}

/** Releases two adapters only after both have reached their state read. */
class StateReadBarrier {
  private readonly arrivals: string[] = [];
  private readonly released: Promise<void>;
  private release!: () => void;

  constructor(private readonly timeoutMs = STATE_READ_BARRIER_TIMEOUT_MS) {
    this.released = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async wait(participant: string): Promise<void> {
    this.arrivals.push(participant);
    if (this.arrivals.length === 2) this.release();

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.released,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`StateReadBarrier timed out after ${this.timeoutMs}ms; arrivals=${this.arrivals.join(",") || "<none>"}; expected=2`)),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

class BarrierMcpClient implements McpToolClientPort {
  private hasBlockedAStateRead = false;

  constructor(
    private readonly delegate: McpToolClientPort,
    private readonly barrier: StateReadBarrier,
    private readonly participant: string,
  ) {}

  async callTool<TResult = unknown>(toolName: string, args: Readonly<Record<string, unknown>>): Promise<TResult> {
    if (!this.hasBlockedAStateRead && toolName === "pmc-agent-memory_recall" && args.kind === "sdd-change-state") {
      this.hasBlockedAStateRead = true;
      await this.barrier.wait(this.participant);
    }
    return this.delegate.callTool<TResult>(toolName, args);
  }
}

async function runTests(): Promise<void> {
  console.log("--- sdd-change-state (Task 2, RED-first) ---");

  const tempDir = mkdtempSync(path.join(tmpdir(), "sdd-change-state-"));
  const dbPath = path.join(tempDir, "agent-memory.db");
  const projectRoot = tempDir;
  const firstClient = new SqliteMcpToolClient({ dbPath });
  const firstAdapter = new PmcSddArtifactStoreAdapter(firstClient);

  try {
    // (a) A created state survives a read through the typed artifact-store port.
    {
      const created = await firstAdapter.writeChangeState(changeState(projectRoot, "durable-create"), 0);
      assert.equal(created.version, 1, "a fresh change state receives version 1");

      const readBack = await firstAdapter.readChangeState(projectRoot, "durable-create");
      assert.deepEqual(readBack, created, "a durable state round-trips with its versioned fields intact");
    }
    console.log("  pass: durable create/read");

    // (b) The deterministic project index makes change-state discovery possible.
    {
      await firstAdapter.writeChangeState(changeState(projectRoot, "discover-b"), 0);
      await firstAdapter.writeChangeState(changeState(projectRoot, "discover-a"), 0);

      const discovered = await firstAdapter.listChangeStates(projectRoot);
      assert.deepEqual(
        discovered.map((state) => state.changeName),
        ["discover-a", "discover-b", "durable-create"],
        "project discovery enumerates every persisted change in deterministic order",
      );
    }
    console.log("  pass: project discovery/enumeration");

    // (c) A different phase cannot acquire a state lock already held in flight.
    {
      const created = await firstAdapter.writeChangeState(changeState(projectRoot, "lock-conflict"), 0);
      const locked = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        "lock-conflict",
        "apply",
        "runner-a",
        created.version,
      );
      assert.deepEqual(locked.lock, { phase: "apply" }, "the owner receives phase status but not its authorization token");
      assert.doesNotMatch(JSON.stringify(locked), /runner-a/, "acquire never returns the caller's owner token");

      await assert.rejects(
        () => firstAdapter.acquireChangeStateLock(projectRoot, "lock-conflict", "apply", "runner-b", locked.version),
        (error: unknown) => {
          assert.ok(error instanceof SddChangeStateLockConflictError, "a second runner receives the typed conflict");
          assert.deepEqual(error.heldLock, { phase: "apply" }, "the conflict exposes lock phase but not owner identity");
          assert.doesNotMatch(JSON.stringify(error), /runner-a|runner-b/, "the conflict cannot reveal either owner token");
          return true;
        },
        "a second runner conflicts even when it requests the same phase without learning a release token",
      );

      await assert.rejects(
        () => firstAdapter.renewChangeStateLock(projectRoot, "lock-conflict", "runner-b", locked.version),
        SddChangeStateLockConflictError,
        "only the lock owner may renew",
      );
      const renewed = await firstAdapter.renewChangeStateLock(projectRoot, "lock-conflict", "runner-a", locked.version);
      await assert.rejects(
        () => firstAdapter.releaseChangeStateLock(projectRoot, "lock-conflict", "guessed-token", renewed.version),
        SddChangeStateLockConflictError,
        "a guessed or different token cannot release the held lock",
      );
    }
    console.log("  pass: lock acquisition conflict");

    // (d) A separately constructed adapter observes the lock from durable storage.
    {
      const secondClient = new SqliteMcpToolClient({ dbPath });
      const secondAdapter = new PmcSddArtifactStoreAdapter(secondClient);
      try {
        const readBack = await secondAdapter.readChangeState(projectRoot, "lock-conflict");
        assert.deepEqual(
          readBack?.lock,
          { phase: "apply" },
          "a newly constructed adapter reads phase status but not durable credentials",
        );
        assert.doesNotMatch(JSON.stringify(readBack), /runner-a/, "a competing reader cannot obtain the owner token");
        const discovered = await secondAdapter.listChangeStates(projectRoot);
        const discoveredLock = discovered.find((state) => state.changeName === "lock-conflict");
        assert.deepEqual(discoveredLock?.lock, { phase: "apply" }, "discovery exposes lock presence and phase only");
        assert.doesNotMatch(JSON.stringify(discoveredLock), /runner-a/, "discovery cannot disclose the owner token");
        const released = await secondAdapter.releaseChangeStateLock(
          projectRoot,
          "lock-conflict",
          "runner-a",
          readBack!.version,
        );
        assert.equal(released.lock, undefined, "the lock owner may release its durable lease");
      } finally {
        secondClient.close();
      }
    }
    console.log("  pass: lock readback through a new adapter");

    // (e) A stale state version cannot overwrite a newer durable state.
    {
      const created = await firstAdapter.writeChangeState(changeState(projectRoot, "stale-write"), 0);
      const updated = await firstAdapter.writeChangeState(
        { ...changeState(projectRoot, "stale-write"), artifactIndex: ["proposal.md", "design.md"] },
        created.version,
      );
      assert.equal(updated.version, 2, "the current version advances after a conditional write");

      await assert.rejects(
        () =>
          firstAdapter.writeChangeState(
            { ...changeState(projectRoot, "stale-write"), baselineFingerprint: "stale-baseline" },
            created.version,
          ),
        SddChangeStateVersionConflictError,
        "a stale state version reports a conditional-write conflict instead of overwriting",
      );
    }
    console.log("  pass: stale state-version conditional write conflict");

    // (f) An index failure reports the committed state and supports explicit/idempotent repair.
    {
      const conflictedClient = new ExhaustedIndexConflictClient(firstClient);
      const conflictedAdapter = new PmcSddArtifactStoreAdapter(conflictedClient);
      await assert.rejects(
        () => conflictedAdapter.writeChangeState(changeState(projectRoot, "index-repair"), 0),
        (error: unknown) => {
          assert.ok(error instanceof SddChangeStateIndexPersistenceError, "index failure is typed and recoverable");
          assert.equal(error.committedState.version, 1, "the typed failure exposes the committed state version");
          return true;
        },
        "exhausted index conflicts return the committed state instead of an opaque trap",
      );

      const partial = await conflictedAdapter.readChangeState(projectRoot, "index-repair");
      assert.equal(partial?.version, 1, "the partial failure leaves the new state durable for repair");

      conflictedClient.rejectIndexWrites = false;
      const retried = await conflictedAdapter.writeChangeState(changeState(projectRoot, "index-repair"), 0);
      assert.equal(retried.version, partial!.version, "an ordinary identical create retry repairs idempotently instead of trapping on version 0");
      const repaired = await conflictedAdapter.repairChangeStateIndex(projectRoot, "index-repair");
      assert.equal(repaired.version, partial!.version, "the explicit repair path is safely idempotent after an ordinary retry");
      const discovered = await firstAdapter.listChangeStates(projectRoot);
      assert.ok(
        discovered.some((state) => state.changeName === "index-repair"),
        "the explicit repair path restores project discovery",
      );
    }
    console.log("  pass: index failure is typed, repairable, and idempotent on create retry");

    // (g) Two adapters that request the SAME phase still contend on owner token.
    {
      const created = await firstAdapter.writeChangeState(changeState(projectRoot, "concurrent-lock"), 0);
      const barrier = new StateReadBarrier();
      const applyClient = new SqliteMcpToolClient({ dbPath });
      const verifyClient = new SqliteMcpToolClient({ dbPath });
      const applyAdapter = new PmcSddArtifactStoreAdapter(new BarrierMcpClient(applyClient, barrier, "runner-a"));
      const verifyAdapter = new PmcSddArtifactStoreAdapter(new BarrierMcpClient(verifyClient, barrier, "runner-b"));
      try {
        const results = await Promise.allSettled([
          applyAdapter.acquireChangeStateLock(projectRoot, "concurrent-lock", "apply", "runner-a", created.version),
          verifyAdapter.acquireChangeStateLock(projectRoot, "concurrent-lock", "apply", "runner-b", created.version),
        ]);
        const fulfilled = results.filter((result) => result.status === "fulfilled");
        const rejected = results.filter((result) => result.status === "rejected");
        assert.equal(fulfilled.length, 1, "exactly one interleaved lock acquisition succeeds");
        assert.equal(rejected.length, 1, "exactly one interleaved lock acquisition loses");
        assert.ok(
          rejected[0]?.reason instanceof SddChangeStateLockConflictError,
          "the losing same-phase runner reports a lock conflict, not a generic version conflict",
        );
      } finally {
        applyClient.close();
        verifyClient.close();
      }
    }
    console.log("  pass: true same-phase concurrent lock acquisition reports SddChangeStateLockConflictError");

    // (h) A one-sided rendezvous fails fast with participant diagnostics.
    {
      const barrier = new StateReadBarrier(5);
      await assert.rejects(
        () => barrier.wait("orphan-runner"),
        /StateReadBarrier timed out after 5ms; arrivals=orphan-runner; expected=2/,
        "the test barrier cannot hang indefinitely without naming the missing participant",
      );
    }
    console.log("  pass: StateReadBarrier timeout includes bounded diagnostics");

    // (i) SPEC DL-6 — same-phase recovery. A fresh adapter claiming the SAME
    // phase that is stuck in the durable lock replaces the owner token
    // atomically. The previous owner token can no longer authorize any
    // operation; the new owner token can renew and release.
    {
      const created = await firstAdapter.writeChangeState(changeState(projectRoot, "same-phase-recovery"), 0);
      const stuck = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        "same-phase-recovery",
        "apply",
        "runner-crashed",
        created.version,
      );
      assert.deepEqual(stuck.lock, { phase: "apply" }, "the crashed dispatch durably holds the apply lock");

      const secondClient = new SqliteMcpToolClient({ dbPath });
      const secondAdapter = new PmcSddArtifactStoreAdapter(secondClient);
      try {
        const beforeReclaim = await secondAdapter.readChangeState(projectRoot, "same-phase-recovery");
        assert.deepEqual(
          beforeReclaim?.lock,
          { phase: "apply" },
          "a freshly constructed adapter reads the stuck lock from durable storage",
        );

        // RED today: this throws SddChangeStateLockConflictError because
        // acquireChangeStateLock refuses any acquisition while a lock is held.
        // GREEN: reclaimChangeStateLock succeeds because the held phase matches.
        const reclaimed = await secondAdapter.reclaimChangeStateLock(
          projectRoot,
          "same-phase-recovery",
          "apply",
          "runner-restart",
          beforeReclaim!.version,
        );
        assert.deepEqual(
          reclaimed.lock,
          { phase: "apply" },
          "same-phase recovery preserves the phase identity",
        );
        assert.doesNotMatch(
          JSON.stringify(reclaimed),
          /runner-crashed|runner-restart/,
          "the durable record never exposes either owner token publicly",
        );

        await assert.rejects(
          () =>
            secondAdapter.renewChangeStateLock(
              projectRoot,
              "same-phase-recovery",
              "runner-crashed",
              reclaimed.version,
            ),
          SddChangeStateLockConflictError,
          "the prior (stale) owner token can no longer renew after same-phase recovery",
        );

        const renewed = await secondAdapter.renewChangeStateLock(
          projectRoot,
          "same-phase-recovery",
          "runner-restart",
          reclaimed.version,
        );
        const released = await secondAdapter.releaseChangeStateLock(
          projectRoot,
          "same-phase-recovery",
          "runner-restart",
          renewed.version,
        );
        assert.equal(released.lock, undefined, "the new owner can release its reclaimed lock normally");
      } finally {
        secondClient.close();
      }
    }
    console.log("  pass: SPEC DL-6 same-phase recovery replaces owner token without leaking the prior one");

    // (j) SPEC DL-6 — cross-phase denial. A different phase request against
    // a durably-held lock is refused even after same-phase recovery semantics
    // exist on the port.
    {
      const created = await firstAdapter.writeChangeState(changeState(projectRoot, "cross-phase-deny"), 0);
      const held = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        "cross-phase-deny",
        "apply",
        "runner-x",
        created.version,
      );

      await assert.rejects(
        () =>
          firstAdapter.reclaimChangeStateLock(
            projectRoot,
            "cross-phase-deny",
            "verify",
            "runner-y",
            held.version,
          ),
        (error: unknown) => {
          assert.ok(
            error instanceof SddChangeStateLockConflictError,
            "a different phase on the reclaim path reports a lock conflict, not a generic error",
          );
          assert.deepEqual(
            error.heldLock,
            { phase: "apply" },
            "the conflict still surfaces the held phase publicly",
          );
          return true;
        },
        "a different phase is refused even via the reclaim path — other phases remain blocked",
      );

      const afterAttempt = await firstAdapter.readChangeState(projectRoot, "cross-phase-deny");
      assert.deepEqual(
        afterAttempt?.lock,
        { phase: "apply" },
        "a refused cross-phase reclaim does not mutate the held lock",
      );
    }
    console.log("  pass: SPEC DL-6 cross-phase denial keeps the held lock intact");

    // (k) SPEC DL-6 — explicit deliberate clear with audit. The recovery
    // method requires no ownerToken (the prior owner is presumed dead) and
    // returns an audit record naming the cleared phase and the reason.
    {
      const created = await firstAdapter.writeChangeState(changeState(projectRoot, "explicit-clear"), 0);
      await firstAdapter.acquireChangeStateLock(
        projectRoot,
        "explicit-clear",
        "apply",
        "stuck-runner",
        created.version,
      );

      const beforeAudit = await firstAdapter.readChangeState(projectRoot, "explicit-clear");
      const recovery = await firstAdapter.recoverChangeStateLock(
        projectRoot,
        "explicit-clear",
        beforeAudit!.version,
        "operator confirmed the runner process is dead and the dispatch must be replayed",
      );
      assert.ok(
        recovery.audit.recoveredAt.length > 0 && !Number.isNaN(Date.parse(recovery.audit.recoveredAt)),
        "the audit record carries a server-side timestamp",
      );
      assert.equal(recovery.audit.changeName, "explicit-clear", "the audit names the change that was cleared");
      assert.deepEqual(
        recovery.audit.priorLock,
        { phase: "apply" },
        "the audit surfaces the cleared phase publicly but never the owner token",
      );
      assert.match(
        recovery.audit.reason,
        /operator confirmed/,
        "the audit preserves the caller-supplied reason verbatim for downstream review",
      );
      assert.equal(recovery.state.lock, undefined, "the recovery clears the durable lock");
      assert.equal(recovery.state.version, beforeAudit!.version + 1, "the recovery is a versioned write");
    }
    console.log("  pass: SPEC DL-6 explicit clear returns audit and clears the durable lock");

    // (l) SPEC DL-6 — subsequent normal lifecycle. After an explicit clear
    // the durable change accepts a fresh acquisition, the new owner can renew
    // and update owned state, and a subsequent release returns the state to
    // the same unlocked shape the cycle started with.
    {
      const created = await firstAdapter.writeChangeState(changeState(projectRoot, "post-recovery-lifecycle"), 0);
      const stuck = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        "post-recovery-lifecycle",
        "apply",
        "stale-runner",
        created.version,
      );
      const recovered = await firstAdapter.recoverChangeStateLock(
        projectRoot,
        "post-recovery-lifecycle",
        stuck.version,
        "stale-runner crashed mid-phase; operator approved replay",
      );
      const reacquired = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        "post-recovery-lifecycle",
        "verify",
        "fresh-runner",
        recovered.state.version,
      );
      assert.deepEqual(reacquired.lock, { phase: "verify" }, "the post-recovery lifecycle starts a new phase");

      const updated = await firstAdapter.updateOwnedChangeState(
        { projectRoot, changeName: "post-recovery-lifecycle", artifactIndex: ["proposal.md", "verifyReport.md"] },
        "fresh-runner",
        reacquired.version,
      );
      assert.deepEqual(
        updated.artifactIndex,
        ["proposal.md", "verifyReport.md"],
        "the new owner can update durable state under its own token",
      );

      const released = await firstAdapter.releaseChangeStateLock(
        projectRoot,
        "post-recovery-lifecycle",
        "fresh-runner",
        updated.version,
      );
      assert.equal(released.lock, undefined, "the new owner can release its own lock normally");
      assert.deepEqual(
        released.artifactIndex,
        ["proposal.md", "verifyReport.md"],
        "the released state preserves the updated artifact index",
      );
    }
    console.log("  pass: SPEC DL-6 subsequent normal lifecycle resumes after explicit recovery");

    // (m) Reviewer finding #2 — stale-owner verify. A tool surface whose
    // in-memory token map still carries a now-revoked owner token MUST be
    // refused by verifyOwnedLock when it presents that stale token, even
    // though the local map says it owns the lock. The refusal happens
    // before any write path can run.
    {
      const created = await firstAdapter.writeChangeState(changeState(projectRoot, "stale-owner-verify"), 0);
      const initial = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        "stale-owner-verify",
        "apply",
        "stale-runner",
        created.version,
      );
      const reclaimed = await firstAdapter.reclaimChangeStateLock(
        projectRoot,
        "stale-owner-verify",
        "apply",
        "fresh-runner",
        initial.version,
      );
      // Sanity: the new owner holds the lock now.
      const freshVerify = await firstAdapter.verifyOwnedLock(
        projectRoot,
        "stale-owner-verify",
        "fresh-runner",
      );
      assert.deepEqual(freshVerify.lock, { phase: "apply" }, "the new owner passes verifyOwnedLock");

      // RED today: there is no port method to verify an owner token; the
      // stale-token path proceeds past the in-memory check and corrupts
      // durable state. GREEN: verifyOwnedLock raises the typed conflict for
      // the stale token without touching durable state.
      await assert.rejects(
        () =>
          firstAdapter.verifyOwnedLock(
            projectRoot,
            "stale-owner-verify",
            "stale-runner",
          ),
        (error: unknown) => {
          assert.ok(
            error instanceof SddChangeStateLockConflictError,
            "a stale owner token reports the typed conflict, not a generic error",
          );
          assert.deepEqual(
            error.heldLock,
            { phase: "apply" },
            "the conflict surfaces the held phase publicly",
          );
          return true;
        },
        "verifyOwnedLock refuses a stale owner token",
      );

      // The durable state is unchanged by the verify call.
      const afterRejects = await firstAdapter.readChangeState(projectRoot, "stale-owner-verify");
      assert.equal(afterRejects?.version, reclaimed.version, "a rejected verify does not advance the durable version");
      assert.deepEqual(afterRejects?.lock, { phase: "apply" }, "a rejected verify does not clear the lock");
    }
    console.log("  pass: reviewer #2 stale-owner verify refuses a displaced tool surface");

    // (n) Reviewer finding #3 — reclaim retry uses freshly read state. A
    // concurrent update to artifactIndex / baselineFingerprint between the
    // original read and the OCC retry MUST survive the reclaim: the retry
    // adopts the freshly read latest state as its source.
    {
      const created = await firstAdapter.writeChangeState(changeState(projectRoot, "interleaved-reclaim"), 0);
      const initial = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        "interleaved-reclaim",
        "apply",
        "stale-runner",
        created.version,
      );

      // Concurrent update from a separate adapter: advances the version and
      // lands an artifactIndex that the reclaim retry MUST preserve.
      const concurrentClient = new SqliteMcpToolClient({ dbPath });
      const concurrentAdapter = new PmcSddArtifactStoreAdapter(concurrentClient);
      try {
        const updated = await concurrentAdapter.updateOwnedChangeState(
          {
            projectRoot,
            changeName: "interleaved-reclaim",
            artifactIndex: ["proposal.md"],
            baselineFingerprint: "concurrent-fingerprint",
          },
          "stale-runner",
          initial.version,
        );

        // RED today: the retry uses the original snapshot's empty
        // artifactIndex, silently overwriting the concurrent mutation. GREEN:
        // the retry adopts the latest durable state as source, so the
        // concurrent artifactIndex survives.
        const reclaimed = await firstAdapter.reclaimChangeStateLock(
          projectRoot,
          "interleaved-reclaim",
          "apply",
          "fresh-runner",
          initial.version,
        );
        assert.equal(reclaimed.version, updated.version + 1, "the reclaim advanced past the concurrent update");
        assert.deepEqual(
          reclaimed.artifactIndex,
          ["proposal.md"],
          "the reclaim preserved the concurrent artifactIndex instead of overwriting it",
        );
        assert.equal(
          reclaimed.baselineFingerprint,
          "concurrent-fingerprint",
          "the reclaim preserved the concurrent baselineFingerprint",
        );
        assert.deepEqual(reclaimed.lock, { phase: "apply" }, "the reclaim carries the fresh owner token");
      } finally {
        concurrentClient.close();
      }
    }
    console.log("  pass: reviewer #3 reclaim retry adopts freshly read state and preserves concurrent mutations");

    // (o) Reviewer finding #1 — init sentinel reclaim/resilience. The
    // project-global `__sdd_project_init_lock__` sentinel participates in
    // the same passive same-phase reclaim semantics as user changes: when an
    // sdd-init dispatch crashes mid-flight, a fresh sdd-init compose must
    // reclaim the sentinel transparently (without exposing or accepting any
    // reserved change name from the caller). A different phase request from
    // any surface remains blocked by both the sentinel and the user change.
    {
      const sentinelName = "__sdd_project_init_lock__";
      const created = await firstAdapter.writeChangeState(
        { projectRoot, changeName: sentinelName, artifactIndex: [] },
        0,
      );
      const stuck = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        sentinelName,
        "sdd-init",
        "stale-init-runner",
        created.version,
        "init-change-A",
      );

      const latest = await firstAdapter.readChangeState(projectRoot, sentinelName);
      assert.deepEqual(
        latest?.lock,
        { phase: "sdd-init" },
        "the stuck init sentinel is durably held by sdd-init",
      );
      assert.equal(
        latest?.boundChangeName,
        "init-change-A",
        "the sentinel is bound to the change that acquired it (final-review finding #1)",
      );

      // RED today: reclaimChangeStateLock would accept "apply" as a fresh
      // acquisition, but for sdd-init the sentinel is shared project-global
      // state — a different phase request against the sentinel MUST be
      // refused even when no user change is involved.
      await assert.rejects(
        () =>
          firstAdapter.reclaimChangeStateLock(
            projectRoot,
            sentinelName,
            "apply",
            "interloper-runner",
            latest!.version,
          ),
        (error: unknown) => {
          assert.ok(
            error instanceof SddChangeStateLockConflictError,
            "a non-init phase against the init sentinel is a typed conflict",
          );
          assert.deepEqual(
            error.heldLock,
            { phase: "sdd-init" },
            "the conflict surfaces the held sentinel phase publicly",
          );
          return true;
        },
        "the init sentinel refuses any non-sdd-init phase on the reclaim path",
      );

      // Same-phase reclaim still works for the sentinel — a fresh
      // sdd-init dispatch transparently reclaims it without exposing the
      // reserved name.
      const reclaimed = await firstAdapter.reclaimChangeStateLock(
        projectRoot,
        sentinelName,
        "sdd-init",
        "fresh-init-runner",
        latest!.version,
        "init-change-A",
      );
      assert.deepEqual(reclaimed.lock, { phase: "sdd-init" }, "the sentinel reclaims to sdd-init");
      assert.equal(
        reclaimed.boundChangeName,
        "init-change-A",
        "the sentinel's binding survives a same-phase reclaim",
      );
      assert.doesNotMatch(
        JSON.stringify(reclaimed),
        /stale-init-runner|fresh-init-runner|interloper-runner/,
        "the sentinel never exposes any owner token publicly",
      );
    }
    console.log("  pass: reviewer #1 init sentinel participates in passive same-phase reclaim and refuses other phases");

    // (p) Final-review finding #1 — sentinel is bound to owning change.
    // After change A acquires the sentinel for `sdd-init`, change B (a
    // DIFFERENT change trying to acquire the sentinel for `sdd-init`)
    // MUST be refused with `SddChangeStateSentinelBindingConflictError`
    // naming the bound change publicly. Change A's live init remains
    // held; the tool surface never accepts a reserved name.
    {
      // Use a distinct sentinel fixture so this test is independent of
      // the prior (o) scenario's bound sentinel. Each scenario owns its
      // own sentinel acquisition lifecycle; both run against the same
      // shared SQLite DB so they exercise the durable layer.
      const sentinelName = "__sdd_project_init_lock_2__";
      const created = await firstAdapter.writeChangeState(
        { projectRoot, changeName: sentinelName, artifactIndex: [] },
        0,
      );
      await firstAdapter.acquireChangeStateLock(
        projectRoot,
        sentinelName,
        "sdd-init",
        "stale-runner-A",
        created.version,
        "change-A",
      );
      await assert.rejects(
        () =>
          firstAdapter.acquireChangeStateLock(
            projectRoot,
            sentinelName,
            "sdd-init",
            "fresh-runner-B",
            created.version + 1,
            "change-B",
          ),
        (error: unknown) => {
          assert.equal(
            error instanceof SddChangeStateSentinelBindingConflictError,
            true,
            "a different change acquiring the sentinel receives the typed binding conflict",
          );
          assert.equal(
            (error as SddChangeStateSentinelBindingConflictError).boundChangeName,
            "change-A",
            "the conflict names the bound change publicly",
          );
          assert.equal(
            (error as SddChangeStateSentinelBindingConflictError).requestedChangeName,
            "change-B",
            "the conflict names the requesting change publicly",
          );
          return true;
        },
        "a different change cannot acquire a sentinel bound to another change",
      );
      // Recovery for change B also refused — recovery is a deliberate
      // operation that MUST NOT clobber a sentinel held by a different
      // live init.
      await assert.rejects(
        () =>
          firstAdapter.recoverChangeStateLock(
            projectRoot,
            sentinelName,
            created.version + 1,
            "operator tried to clear via change-B recovery",
            "change-B",
          ),
        (error: unknown) => {
          assert.equal(
            error instanceof SddChangeStateSentinelBindingConflictError,
            true,
            "change-B's explicit recovery refuses the sentinel bound to change-A",
          );
          return true;
        },
        "an explicit recovery for change-B cannot clobber the sentinel bound to change-A",
      );
      // Sentinel lock still held by change-A.
      const latest = await firstAdapter.readChangeState(projectRoot, sentinelName);
      assert.deepEqual(latest?.lock, { phase: "sdd-init" }, "the bound sentinel lock is still held after both refused attempts");
      assert.equal(latest?.boundChangeName, "change-A", "the bound sentinel is still bound to change-A");
    }
    console.log("  pass: reviewer #1 final — sentinel binds to owning change; cross-change acquire/recover denied");

    // (q) Final-review finding #2 — atomic init-round ownership validation.
    // A stale init runner whose in-memory token map is out of date cannot
    // cause a persisted config mutation. `verifyInitRoundOwnership`
    // validates BOTH the user change lock AND the project-init sentinel
    // lock, AND the sentinel binding, BEFORE any caller can write the
    // init-config checkpoint. Stale tokens are refused with the typed
    // conflict; no checkpoint write occurs.
    {
      const sentinelName = "__sdd_project_init_lock_3__";
      const userChangeName = "stale-init-runner";
      // Set up: a fresh live init holds both the sentinel (bound to
      // userChangeName) and the user change.
      const sentinelCreated = await firstAdapter.writeChangeState(
        { projectRoot, changeName: sentinelName, artifactIndex: [] },
        0,
      );
      const sentinelLocked = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        sentinelName,
        "sdd-init",
        "live-init-runner",
        sentinelCreated.version,
        userChangeName,
      );
      const userChangeCreated = await firstAdapter.writeChangeState(
        {
          projectRoot,
          changeName: userChangeName,
          artifactIndex: [],
          baselineFingerprint: "fingerprint-A",
        },
        0,
      );
      const userChangeLocked = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        userChangeName,
        "sdd-init",
        "live-init-runner",
        userChangeCreated.version,
      );
      // Stale runner scenario: a different in-memory token pair — the
      // caller's local map says "stale-runner", but the durable state
      // says "live-init-runner". The atomic validation MUST refuse.
      const sentinelBefore = await firstAdapter.readChangeState(projectRoot, sentinelName);
      const userBefore = await firstAdapter.readChangeState(projectRoot, userChangeName);
      assert.equal(
        sentinelBefore?.boundChangeName,
        userChangeName,
        "the sentinel is bound to the live init's user change",
      );
      assert.equal(userBefore?.lock?.phase, "sdd-init", "the user change is durably held by sdd-init");
      await assert.rejects(
        () =>
          firstAdapter.verifyInitRoundOwnership(
            projectRoot,
            userChangeName,
            sentinelName,
            "stale-runner-token", // stale user token
            "stale-sentinel-token", // stale sentinel token
          ),
        SddChangeStateLockConflictError,
        "a stale init runner's user-change token is rejected",
      );
      // The sentinel must remain durable and bound to userChangeName.
      const sentinelAfter = await firstAdapter.readChangeState(projectRoot, sentinelName);
      assert.deepEqual(
        sentinelAfter?.lock,
        { phase: "sdd-init" },
        "the sentinel stays held by the live runner after the stale validation",
      );
      assert.equal(
        sentinelAfter?.boundChangeName,
        userChangeName,
        "the sentinel binding is intact after the stale validation",
      );
      // The user change version did not advance (no state mutation from
      // a refused validation).
      const userAfter = await firstAdapter.readChangeState(projectRoot, userChangeName);
      assert.equal(
        userAfter?.version,
        userChangeLocked.version,
        "a refused validation does not advance the durable version",
      );
    }
    console.log("  pass: reviewer #2 final — stale init runner cannot cause persisted config mutation");

    // (r) Final-review finding #4 — reclaim regression test. A concurrent
    // mutation lands AFTER reclaim's initial read and BEFORE its first
    // write attempt. The retry MUST adopt the latest state as its source
    // for `artifactIndex` and `baselineFingerprint` (this is what the
    // reviewer's hook parameter enables — pre-fix code used the original
    // snapshot, silently overwriting the concurrent mutation).
    {
      const changeName = "interleaved-reclaim-after-read";
      const created = await firstAdapter.writeChangeState(
        { projectRoot, changeName, artifactIndex: [] },
        0,
      );
      const initial = await firstAdapter.acquireChangeStateLock(
        projectRoot,
        changeName,
        "apply",
        "stale-runner",
        created.version,
      );

      // The hook fires after reclaim's initial read but before its first
      // write attempt. A concurrent update lands here via a SEPARATE
      // SQLite handle so the OCC version advances.
      const concurrentClient = new SqliteMcpToolClient({ dbPath });
      const concurrentAdapter = new PmcSddArtifactStoreAdapter(concurrentClient);
      let concurrentUpdateApplied = false;
      try {
        const reclaimed = await firstAdapter.reclaimChangeStateLock(
          projectRoot,
          changeName,
          "apply",
          "fresh-runner",
          initial.version,
          undefined,
          {
            afterInitialRead: async () => {
              await concurrentAdapter.updateOwnedChangeState(
                {
                  projectRoot,
                  changeName,
                  artifactIndex: ["proposal.md", "design.md"],
                  baselineFingerprint: "concurrent-fingerprint",
                },
                "stale-runner",
                initial.version,
              );
              concurrentUpdateApplied = true;
            },
          },
        );
        assert.equal(concurrentUpdateApplied, true, "the after-initial-read hook fired");
        assert.deepEqual(
          reclaimed.artifactIndex,
          ["proposal.md", "design.md"],
          "reclaim adopted the concurrent artifactIndex on retry (regression-target assertion)",
        );
        assert.equal(
          reclaimed.baselineFingerprint,
          "concurrent-fingerprint",
          "reclaim adopted the concurrent baselineFingerprint on retry",
        );
      } finally {
        concurrentClient.close();
      }
    }
    console.log("  pass: reviewer #4 final — reclaim retry adopts concurrent mutations landed after initial read");

    console.log("All sdd-change-state tests passed.");
  } finally {
    firstClient.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
