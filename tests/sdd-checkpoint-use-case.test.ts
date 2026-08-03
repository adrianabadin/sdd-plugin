/**
 * WU9 — CP-1..CP-17: Checkpoint capability tests (RED-first).
 * See docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md capability `sdd-checkpoint`.
 */

import assert from "node:assert/strict";

import {
  InvalidCheckpointPhaseError,
  CheckpointConcurrencyError,
  CheckpointReadbackMismatchError,
  declareBatch,
  recordCompletion,
  blockMidBatch,
  resumeBatch,
  readCheckpoints,
  writeCheckpointsDurable,
} from "../src/application/sdd/checkpoint.js";
import { assembleStatus } from "../src/application/sdd/compute-status.js";
import type { Checkpoints, SddStatus } from "../src/domain/sdd/status.js";
import type { CheckpointRecord, CheckpointWriteResult, SddArtifactStorePort } from "../src/ports/sdd-artifact-store.port.js";
import type { SemanticGatewayPort } from "../src/application/sdd/semantic-gateway.js";

/**
 * In-memory store for testing. Models optimistic concurrency the way the real
 * store does: every write bumps a version; a write with `expectedVersion`
 * whose value no longer matches the current version rejects with
 * `CheckpointConcurrencyError`. `dropNextCheckpointWrite` simulates a write
 * that silently does not land (for SS-10 read-back coverage).
 *
 * C-1 support: `injectConcurrentWriteBetweenReadAndWrite` lets a test MUTATE
 * the record (bumping its version) between the durable loop's read and its
 * write — a genuine OCC conflict, not a thrown exception. This is how the
 * CP-16/CP-17 tests now exercise the retry path: a concurrent writer lands
 * first, the version the loop read is now stale, the write is rejected, the
 * loop re-reads and recomputes.
 */
class FakeStore implements SddArtifactStorePort {
  public checkpoints = new Map<string, { content: unknown; version: number }>();
  public writeAttempts = 0;
  public nextVersion = 1;
  public dropNextCheckpointWrite = false;
  /** If set, called at the start of each writeCheckpoint; can mutate state. */
  public onBeforeWrite?: () => void;

  async writeArtifact(_key: string, _content: string): Promise<void> {}
  async readArtifact(_key: string): Promise<string | null> {
    return null;
  }

  async writeCheckpoint(key: string, content: unknown, expectedVersion?: number): Promise<CheckpointWriteResult> {
    this.writeAttempts++;
    this.onBeforeWrite?.();
    if (this.dropNextCheckpointWrite) {
      this.dropNextCheckpointWrite = false;
      // Simulate a write that claims success but did not persist — the
      // durable loop's read-back will catch the mismatch.
      const current = this.checkpoints.get(key);
      return { version: current?.version ?? this.nextVersion };
    }
    const current = this.checkpoints.get(key);
    if (expectedVersion !== undefined && current && current.version !== expectedVersion) {
      throw new CheckpointConcurrencyError(
        `Checkpoint '${key}' version mismatch (expected ${expectedVersion}, found ${current.version}).`,
      );
    }
    const version = this.nextVersion++;
    this.checkpoints.set(key, { content: JSON.parse(JSON.stringify(content)), version });
    return { version };
  }

  async readCheckpoint(key: string): Promise<CheckpointRecord | null> {
    const val = this.checkpoints.get(key);
    return val ? { content: JSON.parse(JSON.stringify(val.content)), version: val.version } : null;
  }

  /** Test helper: simulate a concurrent writer landing a new version of the record. */
  injectConcurrentWrite(key: string, content: unknown): void {
    const version = this.nextVersion++;
    this.checkpoints.set(key, { content: JSON.parse(JSON.stringify(content)), version });
  }
}

/** Mock semantic gateway for distilling notes */
class FakeSemanticGateway implements SemanticGatewayPort {
  public distillCalls: string[] = [];

  async distill(rawNote: string): Promise<string> {
    this.distillCalls.push(rawNote);
    return `Distilled note: ${rawNote.trim()}`;
  }
}

function baseStatusInput(checkpoints: Checkpoints, overrides: Partial<Parameters<typeof assembleStatus>[0]> = {}) {
  return {
    changeName: "test-change",
    projectRoot: "/repo/test",
    artifactContents: {
      explore: "done",
      proposal: "done",
      spec: "done",
      design: "done",
      tasks: "done",
      verifyReport: null,
      archiveReport: null,
    },
    allIds: ["s1", "s2", "s3", "s4", "s5"],
    checkpoints,
    inFlightPhase: null,
    blockedReasons: [],
    ...overrides,
  };
}

async function runTests(): Promise<void> {
  console.log("--- sdd-checkpoint (RED-first) ---");

  // CP-1: a verify batch leaves checkpoints.apply.completedIds untouched
  {
    const store = new FakeStore();
    const projHash = "proj123";
    const change = "change-a";

    // Setup apply progress
    await declareBatch({ store, projectRootHash: projHash, changeName: change, phase: "apply", totalIds: ["s1", "s2"] });
    await recordCompletion({ store, projectRootHash: projHash, changeName: change, phase: "apply", completedId: "s1" });
    await recordCompletion({ store, projectRootHash: projHash, changeName: change, phase: "apply", completedId: "s2" });

    const before = await readCheckpoints(store, projHash, change);
    assert.deepEqual(before.apply.completedIds, ["s1", "s2"]);

    // Declare and complete verify batch
    await declareBatch({ store, projectRootHash: projHash, changeName: change, phase: "verify", totalIds: ["v1"] });
    await recordCompletion({ store, projectRootHash: projHash, changeName: change, phase: "verify", completedId: "v1" });

    const after = await readCheckpoints(store, projHash, change);
    assert.deepEqual(after.apply.completedIds, ["s1", "s2"], "CP-1 apply.completedIds is untouched by verify batch");
    assert.deepEqual(after.verify.completedIds, ["v1"]);
  }
  console.log("  pass: CP-1 a verify batch leaves checkpoints.apply.completedIds untouched");

  // CP-2: declaring a batch records totalIds and sets batchId
  {
    const store = new FakeStore();
    const result = await declareBatch({
      store,
      projectRootHash: "p1",
      changeName: "c1",
      phase: "apply",
      totalIds: ["s1", "s2", "s3"],
      batchId: "b-100",
    });

    assert.equal(result.apply.currentBatch?.batchId, "b-100", "CP-2 records batchId");
    assert.deepEqual(result.apply.currentBatch?.totalIds, ["s1", "s2", "s3"], "CP-2 records totalIds");
    assert.deepEqual(result.apply.currentBatch?.remainingIds, ["s1", "s2", "s3"], "CP-2 initializes remainingIds");
  }
  console.log("  pass: CP-2 declaring a batch records totalIds and sets batchId");

  // CP-3: an interrupted batch retains its full plan with zero completions
  {
    const store = new FakeStore();
    await declareBatch({
      store,
      projectRootHash: "p1",
      changeName: "c1",
      phase: "apply",
      totalIds: ["s1", "s2", "s3"],
      batchId: "b-101",
    });

    // Simulate reading status after interruption (zero completions recorded)
    const stored = await readCheckpoints(store, "p1", "c1");
    assert.deepEqual(stored.apply.completedIds, [], "CP-3 zero completions recorded");
    assert.deepEqual(stored.apply.currentBatch?.totalIds, ["s1", "s2", "s3"], "CP-3 retains full plan");
    assert.deepEqual(stored.apply.currentBatch?.remainingIds, ["s1", "s2", "s3"]);
  }
  console.log("  pass: CP-3 an interrupted batch retains its full plan with zero completions");

  // CP-4: a second batch preserves earlier completedIds and replaces only currentBatch
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1", "s2"] });
    await recordCompletion({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", completedId: "s1" });
    await recordCompletion({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", completedId: "s2" });

    // Declare second batch
    const second = await declareBatch({
      store,
      projectRootHash: "p1",
      changeName: "c1",
      phase: "apply",
      totalIds: ["s3", "s4"],
      batchId: "b-200",
    });

    assert.deepEqual(second.apply.completedIds, ["s1", "s2"], "CP-4 preserves earlier completedIds");
    assert.equal(second.apply.currentBatch?.batchId, "b-200", "CP-4 replaces currentBatch");
    assert.deepEqual(second.apply.currentBatch?.totalIds, ["s3", "s4"]);
    assert.deepEqual(second.apply.currentBatch?.remainingIds, ["s3", "s4"]);
  }
  console.log("  pass: CP-4 a second batch preserves earlier completedIds and replaces only currentBatch");

  // CP-5: a completion adds to completedIds and drops from remainingIds
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1", "s2"] });
    const after = await recordCompletion({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", completedId: "s1" });

    assert.deepEqual(after.apply.completedIds, ["s1"], "CP-5 adds to completedIds");
    assert.deepEqual(after.apply.currentBatch?.remainingIds, ["s2"], "CP-5 drops completedId from remainingIds");
  }
  console.log("  pass: CP-5 a completion adds to completedIds and drops from remainingIds");

  // CP-6: resending the same completedId is idempotent
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1", "s2"] });
    await recordCompletion({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", completedId: "s1" });
    const retry = await recordCompletion({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", completedId: "s1" });

    assert.deepEqual(retry.apply.completedIds, ["s1"], "CP-6 completedIds has s1 exactly once");
    assert.deepEqual(retry.apply.currentBatch?.remainingIds, ["s2"]);
  }
  console.log("  pass: CP-6 resending the same completedId is idempotent");

  // CP-7: an id without a checkpoint stays in remainingIds even with partial code on disk
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1", "s2", "s3"] });
    await recordCompletion({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", completedId: "s1" });

    // s2 and s3 have no completion checkpoint
    const current = await readCheckpoints(store, "p1", "c1");
    assert.deepEqual(current.apply.currentBatch?.remainingIds, ["s2", "s3"], "CP-7 s2 and s3 stay in remainingIds");
  }
  console.log("  pass: CP-7 an id without a checkpoint stays in remainingIds even with partial code on disk");

  // CP-8: re-declaring an incomplete id increments attemptCounts
  {
    const store = new FakeStore();
    // Batch 1 includes s1 and s2
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1", "s2"] });
    // s1 completes, s2 does not
    await recordCompletion({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", completedId: "s1" });

    // Batch 2 re-declares s2
    const b2 = await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s2", "s3"] });
    assert.equal(b2.apply.attemptCounts["s2"], 2, "CP-8 s2 attempt count incremented to 2");
  }
  console.log("  pass: CP-8 re-declaring an incomplete id increments attemptCounts");

  // CP-9: re-declaring a completed id does not increment attemptCounts
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1"] });
    await recordCompletion({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", completedId: "s1" });

    const initialAttempts = (await readCheckpoints(store, "p1", "c1")).apply.attemptCounts["s1"] ?? 1;

    // Batch 2 re-declares s1 (already completed)
    const b2 = await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1", "s2"] });
    assert.equal(b2.apply.attemptCounts["s1"], initialAttempts, "CP-9 attemptCount for completed s1 did not increment");
  }
  console.log("  pass: CP-9 re-declaring a completed id does not increment attemptCounts");

  // CP-10: reaching the cap (default 3) sets status: blocked with blockedReasons naming the id
  {
    const store = new FakeStore();
    // Declare s5 three times without completing
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s5"] });
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s5"] });
    const finalCheckpoints = await declareBatch({
      store,
      projectRootHash: "p1",
      changeName: "c1",
      phase: "apply",
      totalIds: ["s5"],
    });

    assert.equal(finalCheckpoints.apply.attemptCounts["s5"], 3);

    const status: SddStatus = assembleStatus(baseStatusInput(finalCheckpoints));
    assert.equal(status.status, "blocked", "CP-10 status is blocked when attempt cap reached");
    assert.ok(
      status.blockedReasons.some((r) => r.includes("s5") && r.includes("3 attempts")),
      "CP-10 blockedReasons names s5 and attempt count",
    );
  }
  console.log("  pass: CP-10 reaching the cap sets status: blocked with blockedReasons naming the id");

  // CP-11: sdd_checkpoint is refused from any phase other than apply or verify
  {
    const store = new FakeStore();
    const invalidPhases = ["explore", "propose", "spec", "design", "tasks", "archive"];
    for (const phase of invalidPhases) {
      await assert.rejects(
        () => declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: phase as any, totalIds: ["s1"] }),
        InvalidCheckpointPhaseError,
        `CP-11 phase '${phase}' is refused`,
      );
    }
  }
  console.log("  pass: CP-11 sdd_checkpoint is refused from any phase other than apply or verify");

  // CP-12: batchNotes is generated via the semantic gateway, not authored by the executor
  {
    const store = new FakeStore();
    const gateway = new FakeSemanticGateway();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1"] });

    const res = await recordCompletion({
      store,
      projectRootHash: "p1",
      changeName: "c1",
      phase: "apply",
      completedId: "s1",
      note: "Deviated to add helper function X",
      semanticGateway: gateway,
    });

    assert.equal(gateway.distillCalls.length, 1, "CP-12 semantic gateway was called");
    assert.ok(res.apply.currentBatch?.batchNotes.includes("Distilled note:"), "CP-12 batchNotes comes from gateway");
  }
  console.log("  pass: CP-12 batchNotes is generated via the semantic gateway");

  // CP-13: a scenario implemented exactly as designed records no note
  {
    const store = new FakeStore();
    const gateway = new FakeSemanticGateway();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1"] });

    const res = await recordCompletion({
      store,
      projectRootHash: "p1",
      changeName: "c1",
      phase: "apply",
      completedId: "s1",
      note: "",
      semanticGateway: gateway,
    });

    assert.equal(gateway.distillCalls.length, 0, "CP-13 gateway not called for empty note");
    assert.equal(res.apply.currentBatch?.batchNotes, "", "CP-13 batchNotes stays empty");
  }
  console.log("  pass: CP-13 a scenario implemented exactly as designed records no note");

  // CP-14: blocking mid-batch leaves completedIds unchanged and populates blockedOn
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1", "s2"] });
    await recordCompletion({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", completedId: "s1" });

    const blockedResult = await blockMidBatch({
      store,
      projectRootHash: "p1",
      changeName: "c1",
      phase: "apply",
      question: "Which DB driver to use?",
      progressSummary: "Completed s1, blocked on s2 driver choice",
    });

    assert.deepEqual(blockedResult.checkpoints.apply.completedIds, ["s1"], "CP-14 completedIds unchanged");
    assert.deepEqual(blockedResult.blockedOn, {
      phase: "apply",
      question: "Which DB driver to use?",
      progressSummary: "Completed s1, blocked on s2 driver choice",
    });
  }
  console.log("  pass: CP-14 blocking mid-batch leaves completedIds unchanged and populates blockedOn");

  // CP-15: resuming inlines the answer and continues from remainingIds starting at the blocked item
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1", "s2"] });
    await recordCompletion({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", completedId: "s1" });
    await blockMidBatch({
      store,
      projectRootHash: "p1",
      changeName: "c1",
      phase: "apply",
      question: "Which DB driver?",
      progressSummary: "Blocked on s2 driver choice",
    });

    const resumed = await resumeBatch({
      store,
      projectRootHash: "p1",
      changeName: "c1",
      phase: "apply",
      answer: "Use SQLite driver",
    });

    assert.equal(resumed.blockedOn, undefined, "CP-15 clears blockedOn");
    assert.deepEqual(resumed.checkpoints.apply.currentBatch?.remainingIds, ["s2"], "CP-15 continues from remainingIds");
    assert.ok(
      resumed.checkpoints.apply.currentBatch?.batchNotes.includes("Use SQLite driver"),
      "CP-15 inlines answer into batch notes",
    );
  }
  console.log("  pass: CP-15 resuming inlines the answer and continues from remainingIds");

  // CP-16: a conflicting concurrent write (a version mismatch on the first
  // write attempt) is detected via optimistic concurrency, re-read with the
  // now-current version, and retried once. This is NOT a transient-storage-
  // throw retry: a concurrent writer must have MUTATED the record (bumping its
  // version) between our read and our write. The earlier test threw an
  // exception from writeCheckpoint, which proves "retry on storage failure",
  // not "detect and recover from a concurrent writer" — the real CP-16
  // scenario. Here the concurrent mutation lands via onBeforeWrite.
  {
    const store = new FakeStore();
    let concurrentInjected = false;
    // On the FIRST write attempt, a concurrent writer lands a new version
    // BEFORE our write reaches the version check — so our expectedVersion is
    // stale and the write is rejected as a conflict.
    store.onBeforeWrite = () => {
      if (!concurrentInjected) {
        concurrentInjected = true;
        const key = "sdd/p1/c1/checkpoints";
        store.injectConcurrentWrite(key, { checkpoints: { apply: { completedIds: ["s-other"], attemptCounts: {}, currentBatch: null }, verify: { completedIds: [], attemptCounts: {}, currentBatch: null } } });
      }
    };

    const result = await writeCheckpointsDurable(store, "p1", "c1", (cur) => {
      cur.apply.completedIds = ["s10"];
      return cur;
    });

    assert.ok(store.writeAttempts >= 2, "CP-16 retried after the concurrent-write conflict");
    assert.deepEqual(result.apply.completedIds, ["s10"], "CP-16 the retry's update landed on top of the concurrent writer's version");
  }
  console.log("  pass: CP-16 a conflicting concurrent write is detected via OCC and retried once");

  // CP-17: a SECOND consecutive conflict (the concurrent writer keeps landing)
  // raises CheckpointConcurrencyError rather than overwriting silently. Again
  // this is a genuine version conflict, not a thrown exception.
  {
    const store = new FakeStore();
    let conflictCount = 0;
    store.onBeforeWrite = () => {
      // Keep injecting concurrent writes so every one of our attempts sees a stale version.
      if (conflictCount < 3) {
        conflictCount++;
        const key = "sdd/p1/c1/checkpoints";
        store.injectConcurrentWrite(key, { checkpoints: { apply: { completedIds: [`s-rival-${conflictCount}`], attemptCounts: {}, currentBatch: null }, verify: { completedIds: [], attemptCounts: {}, currentBatch: null } } });
      }
    };

    await assert.rejects(
      () =>
        writeCheckpointsDurable(store, "p1", "c1", (cur) => {
          cur.apply.completedIds = ["s10"];
          return cur;
        }),
      CheckpointConcurrencyError,
      "CP-17 a persistent concurrent-write conflict raises CheckpointConcurrencyError",
    );
  }
  console.log("  pass: CP-17 a second consecutive conflict raises rather than overwriting");

  // C-3 (SS-10 read-back on the REAL writers): declareBatch, recordCompletion,
  // blockMidBatch, and resumeBatch must all verify their write landed by
  // reading back. If the store silently drops a write (claims success but
  // persists nothing), the durable path must surface a read-back mismatch
  // rather than returning success. The earlier implementation only verified
  // read-back from a single test-only helper (saveCheckpoint); the four real
  // writers wrote without re-reading, so a dropped write was invisible.
  {
    const store = new FakeStore();
    store.dropNextCheckpointWrite = true;
    await assert.rejects(
      () => declareBatch({ store, projectRootHash: "p1", changeName: "c1", phase: "apply", totalIds: ["s1"] }),
      CheckpointReadbackMismatchError,
      "C-3 declareBatch surfaces a read-back mismatch when the write did not land",
    );
  }
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c2", phase: "apply", totalIds: ["s1"] });
    store.dropNextCheckpointWrite = true;
    await assert.rejects(
      () => recordCompletion({ store, projectRootHash: "p1", changeName: "c2", phase: "apply", completedId: "s1" }),
      CheckpointReadbackMismatchError,
      "C-3 recordCompletion surfaces a read-back mismatch when the write did not land",
    );
  }
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c3", phase: "apply", totalIds: ["s1", "s2"] });
    store.dropNextCheckpointWrite = true;
    await assert.rejects(
      () => blockMidBatch({ store, projectRootHash: "p1", changeName: "c3", phase: "apply", question: "q?", progressSummary: "ps" }),
      CheckpointReadbackMismatchError,
      "C-3 blockMidBatch surfaces a read-back mismatch when the write did not land",
    );
  }
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c4", phase: "apply", totalIds: ["s1", "s2"] });
    await blockMidBatch({ store, projectRootHash: "p1", changeName: "c4", phase: "apply", question: "q?", progressSummary: "ps" });
    store.dropNextCheckpointWrite = true;
    await assert.rejects(
      () => resumeBatch({ store, projectRootHash: "p1", changeName: "c4", phase: "apply", answer: "a" }),
      CheckpointReadbackMismatchError,
      "C-3 resumeBatch surfaces a read-back mismatch when the write did not land",
    );
  }
  console.log("  pass: C-3 all four real checkpoint writers verify read-back (SS-10)");

  // CP-15b: resuming a blocked batch with a blockedItemId puts that item first
  // in remainingIds ("starting with the item that was blocked"). The earlier
  // BlockedOn carried no item id, so resume could not know which item to
  // prioritize.
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c5", phase: "apply", totalIds: ["s1", "s2", "s3"] });
    await blockMidBatch({
      store,
      projectRootHash: "p1",
      changeName: "c5",
      phase: "apply",
      question: "Stuck on s2?",
      progressSummary: "Blocked mid s2",
      blockedItemId: "s2",
    });

    const resumed = await resumeBatch({
      store,
      projectRootHash: "p1",
      changeName: "c5",
      phase: "apply",
      answer: "Use plan B",
    });

    assert.equal(resumed.blockedOn, undefined, "CP-15b clears blockedOn");
    assert.equal(
      resumed.checkpoints.apply.currentBatch?.remainingIds[0],
      "s2",
      "CP-15b resumes starting with the item that was blocked",
    );
  }
  console.log("  pass: CP-15b resuming prioritizes the blocked item id");

  // CP-12b: a note recorded WITHOUT a semantic gateway is NOT accumulated
  // raw into batchNotes — CP-12 says batchNotes is the distilled form, and a
  // raw executor note would leak prose into a field meant for short distilled
  // deltas. (The earlier code stored the raw note when no gateway was injected.)
  {
    const store = new FakeStore();
    await declareBatch({ store, projectRootHash: "p1", changeName: "c6", phase: "apply", totalIds: ["s1", "s2"] });
    // No semanticGateway injected.
    const result = await recordCompletion({
      store,
      projectRootHash: "p1",
      changeName: "c6",
      phase: "apply",
      completedId: "s1",
      note: "This is a long raw executor note that should NOT appear verbatim in batchNotes without distillation.",
    });
    assert.equal(
      result.apply.currentBatch?.batchNotes,
      "",
      "CP-12b a note without a semantic gateway is not accumulated raw into batchNotes",
    );
  }
  console.log("  pass: CP-12b a note without a gateway is not stored raw in batchNotes");

  console.log("All sdd-checkpoint tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
