/**
 * Task 3: real tool definitions over the durable SQLite-backed PMC adapter.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSddTools, type SddToolsDeps } from "../src/bootstrap/sdd-tools.js";
import { canonicalizeProjectRoot } from "../src/domain/sdd/project-identity.js";
import { initConfigKey } from "../src/domain/sdd/sdd-keys.js";
import type { WorktreeFingerprint } from "../src/domain/sdd/worktree-fingerprint.js";
import { PmcSddArtifactStoreAdapter } from "../src/infrastructure/pmc/pmc-sdd-artifact-store.adapter.js";
import { SqliteMcpToolClient } from "../src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.js";
import { createSkillRegistryResolver } from "../src/infrastructure/skills/skill-registry-resolver.adapter.js";
import type { McpToolClientPort } from "../src/ports/mcp-tool-client.port.js";
import type {
  CheckpointRecord,
  CheckpointWriteResult,
  SddArtifactStorePort,
  SddChangeState,
  SddChangeStateStorePort,
} from "../src/ports/sdd-artifact-store.port.js";

interface ToolDefinitionLike {
  execute(args: Record<string, unknown>): Promise<{ output: string }>;
}

async function invoke<T>(
  tools: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const definition = tools[name] as ToolDefinitionLike | undefined;
  if (definition === undefined) throw new Error(`Missing SDD tool '${name}'.`);
  return JSON.parse((await definition.execute(args)).output) as T;
}

const baseline: WorktreeFingerprint = { isGit: true, headSha: "baseline", porcelainStatus: "" };
const changed: WorktreeFingerprint = { isGit: true, headSha: "baseline", porcelainStatus: " M unexpected.ts" };
const probeFailed: WorktreeFingerprint = {
  isGit: true,
  headSha: "baseline",
  porcelainStatus: "",
  gitProbeFailed: true,
};

class ArtifactFaultStore implements SddArtifactStorePort {
  public dropNextArtifactWrite = false;
  public mismatchNextArtifactRead = false;
  public mismatchNextCheckpointRead = false;
  public throwNextCheckpointWrite = false;
  /** Final-review finding #3 — fault on the ATOMIC persist, not just the
   *  raw write/read. The atomic persist wraps write + readback + state
   *  update; dropping either one or mismatching the readback short-circuits
   *  the whole transaction so the lock stays held. */
  public dropNextAtomicPersist = false;
  public mismatchNextAtomicPersistReadback = false;

  constructor(private readonly delegate: SddArtifactStorePort) {}

  async writeArtifact(key: string, content: string): Promise<void> {
    if (this.dropNextArtifactWrite) {
      this.dropNextArtifactWrite = false;
      return;
    }
    await this.delegate.writeArtifact(key, content);
  }

  async readArtifact(key: string): Promise<string | null> {
    const content = await this.delegate.readArtifact(key);
    if (this.mismatchNextArtifactRead && content !== null) {
      this.mismatchNextArtifactRead = false;
      return `${content} (mismatch)`;
    }
    return content;
  }

  async writeCheckpoint(key: string, content: unknown, expectedVersion?: number): Promise<CheckpointWriteResult> {
    if (this.throwNextCheckpointWrite) {
      this.throwNextCheckpointWrite = false;
      throw new Error("forced config checkpoint write failure");
    }
    return this.delegate.writeCheckpoint(key, content, expectedVersion);
  }

  async readCheckpoint(key: string): Promise<CheckpointRecord | null> {
    const checkpoint = await this.delegate.readCheckpoint(key);
    if (this.mismatchNextCheckpointRead && checkpoint !== null) {
      this.mismatchNextCheckpointRead = false;
      return { content: { readback: "mismatch" }, version: checkpoint.version };
    }
    return checkpoint;
  }

  async persistArtifactWithOwnership(
    projectRoot: string,
    changeName: string,
    ownerToken: string,
    artifactKey: string,
    artifactContent: string,
    artifactName: string,
  ): Promise<SddChangeState> {
    // Final-review finding #3 — atomic-fault seam. Both `write-failure`
    // and `readback-failure` map to the same atomic-persist failure
    // because under transactional atomicity, a write that doesn't read
    // back is indistinguishable from a read-back mismatch: the whole
    // transaction rolls back, no artifact is persisted, and the lock
    // stays held. The tool surfaces this as `{ ok: false }`.
    if (this.dropNextAtomicPersist || this.mismatchNextAtomicPersistReadback) {
      this.dropNextAtomicPersist = false;
      this.mismatchNextAtomicPersistReadback = false;
      throw new Error("forced atomic persist failure (write/readback did not land)");
    }
    return this.delegate.persistArtifactWithOwnership(
      projectRoot,
      changeName,
      ownerToken,
      artifactKey,
      artifactContent,
      artifactName,
    );
  }
}

class StateReadBarrier {
  private arrivals = 0;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async wait(): Promise<void> {
    this.arrivals += 1;
    if (this.arrivals === 2) this.release();
    await Promise.race([
      this.released,
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`StateReadBarrier timed out; arrivals=${this.arrivals}; expected=2`)), 1_000);
      }),
    ]);
  }
}

class BarrierMcpClient implements McpToolClientPort {
  private stateReads = 0;

  constructor(private readonly delegate: McpToolClientPort, private readonly barrier: StateReadBarrier) {}

  async callTool<TResult = unknown>(toolName: string, args: Readonly<Record<string, unknown>>): Promise<TResult> {
    if (toolName === "pmc-agent-memory_recall" && args.kind === "sdd-change-state") {
      this.stateReads += 1;
      if (this.stateReads === 2) await this.barrier.wait();
    }
    return this.delegate.callTool<TResult>(toolName, args);
  }
}

async function runTests(): Promise<void> {
  console.log("--- sdd-tools integration (Task 3, RED-first) ---");

  const tempDir = mkdtempSync(path.join(tmpdir(), "sdd-tools-integration-"));
  const dbPath = path.join(tempDir, "agent-memory.db");
  const client = new SqliteMcpToolClient({ dbPath });
  const store = new PmcSddArtifactStoreAdapter(client);
  const fingerprints = [baseline, changed, baseline, baseline, baseline, probeFailed, baseline, changed];
  const projectRoot = tempDir;
  const initValidationRoot = path.join(tempDir, "init-validation");
  const initReadbackRoot = path.join(tempDir, "init-readback");
  const initFingerprintRoot = path.join(tempDir, "init-fingerprint");
  const initProjectLockRoot = path.join(tempDir, "init-project-lock");
  const initWriteFailureRoot = path.join(tempDir, "init-write-failure");
  const sentinelSpoofRoot = path.join(tempDir, "sentinel-spoof");
  mkdirSync(initValidationRoot);
  mkdirSync(initReadbackRoot);
  mkdirSync(initFingerprintRoot);
  mkdirSync(initProjectLockRoot);
  mkdirSync(initWriteFailureRoot);
  mkdirSync(sentinelSpoofRoot);
  const changeName = "durable-tools";

  const deps: SddToolsDeps & {
    readonly changeStateStore: SddChangeStateStorePort;
    readonly captureFingerprint: (root: string) => Promise<WorktreeFingerprint>;
  } = {
    store,
    changeStateStore: store,
    captureFingerprint: async (_root) => fingerprints.shift() ?? baseline,
    createSkillResolver: () => (skill) => `/skills/${skill}`,
  };
  const tools = buildSddTools(deps) as unknown as Record<string, unknown>;

  try {
    const { projectRootHash } = canonicalizeProjectRoot(projectRoot);
    await store.writeCheckpoint(initConfigKey(projectRootHash), { initialized: true });

    const initialDiscovery = await invoke<{ initialized: boolean; changes: readonly unknown[]; nextRecommended: string }>(
      tools,
      "sdd_status",
      { projectRoot },
    );
    assert.equal(initialDiscovery.initialized, true, "discovery reads durable initialization");
    assert.deepEqual(initialDiscovery.changes, [], "discovery starts with no durable changes");
    assert.equal(initialDiscovery.nextRecommended, "sdd-new", "initialized empty projects recommend a new change");

    await assert.rejects(
      () => invoke(tools, "sdd_compose_phase_prompt", {
        projectRoot,
        changeName: "invalid-phase",
        phase: "sdd-not-real",
        modelReference: "test/model",
      }),
      /SDD_PHASE_INVALID/,
      "an unknown phase is rejected before durable state or lock acquisition",
    );
    const invalidPhaseStatus = await invoke<{ status: string; inFlightPhase: string | null; blockedReasons: readonly string[] }>(
      tools,
      "sdd_status",
      { projectRoot, changeName: "invalid-phase", allIds: [] },
    );
    assert.equal(invalidPhaseStatus.status, "ok", "an invalid compose leaves no blocked durable state");
    assert.equal(invalidPhaseStatus.inFlightPhase, null, "an invalid compose leaves no durable lock");
    assert.deepEqual(invalidPhaseStatus.blockedReasons, [], "an invalid compose adds no durable blocker");
    const discoveryAfterInvalidPhase = await invoke<{ changes: readonly { changeName: string }[] }>(tools, "sdd_status", { projectRoot });
    assert.equal(
      discoveryAfterInvalidPhase.changes.some((change) => change.changeName === "invalid-phase"),
      false,
      "an invalid compose creates no durable discovery entry",
    );

    const composed = await invoke<{ prompt: string; inFlightPhase: string; worktreeFingerprint: WorktreeFingerprint }>(
      tools,
      "sdd_compose_phase_prompt",
      {
        projectRoot,
        changeName,
        phase: "sdd-explore",
        modelReference: "test/model",
        upstreamArtifacts: { forged: "caller content must not be trusted" },
        currentInFlightPhase: "forged-lock",
      },
    );
    assert.equal(composed.inFlightPhase, "sdd-explore", "compose persists and reports its acquired phase lock");
    assert.deepEqual(composed.worktreeFingerprint, baseline, "compose returns its captured durable baseline");
    assert.doesNotMatch(composed.prompt, /caller content must not be trusted/, "compose loads persisted artifacts instead of caller input");
    assert.doesNotMatch(JSON.stringify(composed), /ownerToken/, "compose output never reveals lock credentials");

    const discovery = await invoke<{ changes: readonly { changeName: string; nextRecommended: string }[] }>(
      tools,
      "sdd_status",
      { projectRoot },
    );
    assert.deepEqual(
      discovery.changes,
      [{ changeName, nextRecommended: "resolve-blockers" }],
      "status without a selection discovers the durable change state",
    );

    const selectedStatus = await invoke<{ status: string; inFlightPhase: string | null; blockedReasons: readonly string[] }>(
      tools,
      "sdd_status",
      { projectRoot, changeName, allIds: [] },
    );
    assert.equal(selectedStatus.status, "blocked", "a durable in-flight lock blocks the selected change");
    assert.equal(selectedStatus.inFlightPhase, "sdd-explore", "selected status reads the durable lock phase");
    assert.ok(selectedStatus.blockedReasons.length > 0, "selected status explains its held durable lock");
    assert.doesNotMatch(JSON.stringify(selectedStatus), /ownerToken/, "status never reveals lock credentials");

    // SPEC DL-6 — passive same-phase reclaim. A second compose for the SAME
    // phase reclaims the lock with a fresh owner token instead of refusing.
    // The orchestrator trusts the reclaim because a single phase can always
    // resume itself, and post-crash recovery is the dominant real scenario.
    const samePhaseReclaim = await invoke<{ inFlightPhase: string | null; lockReclaimed?: boolean }>(
      tools,
      "sdd_compose_phase_prompt",
      {
        projectRoot,
        changeName,
        phase: "sdd-explore",
        modelReference: "test/model",
      },
    );
    assert.equal(samePhaseReclaim.inFlightPhase, "sdd-explore", "the second same-phase compose reclaims and succeeds");
    assert.equal(samePhaseReclaim.lockReclaimed, true, "the reclaim is observable in the response");

    // A DIFFERENT phase still conflicts — other phases remain blocked.
    await assert.rejects(
      () => invoke(tools, "sdd_compose_phase_prompt", {
        projectRoot,
        changeName,
        phase: "sdd-propose",
        modelReference: "test/model",
      }),
      /SDD_CHANGE_STATE_LOCK_CONFLICT/,
      "a different phase conflicts against the durable lock",
    );

    const mismatch = await invoke<{ ok: boolean; unexpectedWrites?: boolean }>(tools, "sdd_save_artifact", {
      projectRoot,
      changeName,
      phase: "sdd-explore",
      artifact: "explore",
      content: "must not persist after a fingerprint mismatch",
      currentInFlightPhase: "forged-lock",
      worktreeFingerprint: baseline,
    });
    assert.equal(mismatch.ok, false, "fingerprint mismatch fails closed before artifact persistence");
    assert.equal(mismatch.unexpectedWrites, true, "fingerprint mismatch is reported");

    const lockedAfterMismatch = await invoke<{ inFlightPhase: string | null }>(tools, "sdd_status", {
      projectRoot,
      changeName,
      allIds: [],
    });
    assert.equal(lockedAfterMismatch.inFlightPhase, "sdd-explore", "mismatch retains the durable lock");

    const saved = await invoke<{ ok: boolean; inFlightPhase: string | null; artifact: string }>(tools, "sdd_save_artifact", {
      projectRoot,
      changeName,
      phase: "sdd-explore",
      artifact: "explore",
      content: "durably saved explore artifact",
    });
    assert.equal(saved.ok, true, "matching fingerprint writes and reads back the artifact");
    assert.equal(saved.inFlightPhase, null, "the lock clears only after durable artifact readback");
    assert.equal(saved.artifact, "explore", "successful saves expose the persisted artifact name");
    assert.doesNotMatch(JSON.stringify(saved), /ownerToken/, "save output never reveals lock credentials");

    const savedStatus = await invoke<{ artifacts: { explore: string }; inFlightPhase: string | null }>(tools, "sdd_status", {
      projectRoot,
      changeName,
      allIds: [],
    });
    assert.equal(savedStatus.artifacts.explore, "done", "status reads the durable saved artifact");
    assert.equal(savedStatus.inFlightPhase, null, "status observes the released durable lock");

    const laterCompose = await invoke<{ prompt: string }>(tools, "sdd_compose_phase_prompt", {
      projectRoot,
      changeName,
      phase: "sdd-propose",
      modelReference: "test/model",
      upstreamArtifacts: { forged: "caller content must still be ignored" },
    });
    assert.match(laterCompose.prompt, /durably saved explore artifact/, "later compose loads the persisted upstream artifact");
    assert.doesNotMatch(laterCompose.prompt, /caller content must still be ignored/, "later compose still ignores caller-forged artifacts");

    await invoke(tools, "sdd_compose_phase_prompt", {
      projectRoot,
      changeName: "probe-failure",
      phase: "sdd-explore",
      modelReference: "test/model",
    });
    const failedProbe = await invoke<{ ok: boolean; unexpectedWrites?: boolean }>(tools, "sdd_save_artifact", {
      projectRoot,
      changeName: "probe-failure",
      phase: "sdd-explore",
      artifact: "explore",
      content: "must not persist after a failed probe",
    });
    assert.equal(failedProbe.ok, false, "a failed fingerprint probe fails closed");
    assert.equal(failedProbe.unexpectedWrites, true, "a failed fingerprint probe is reported");

    const lockedAfterProbeFailure = await invoke<{ inFlightPhase: string | null }>(tools, "sdd_status", {
      projectRoot,
      changeName: "probe-failure",
      allIds: [],
    });
    assert.equal(lockedAfterProbeFailure.inFlightPhase, "sdd-explore", "a failed probe retains the durable lock");

    // Save derives phase from the private durable lock. A caller-provided
    // mutating phase cannot bypass the non-mutating fingerprint guard.
    await invoke(tools, "sdd_compose_phase_prompt", {
      projectRoot,
      changeName: "caller-phase-bypass",
      phase: "sdd-explore",
      modelReference: "test/model",
    });
    const callerPhaseBypass = await invoke<{ ok: boolean; unexpectedWrites?: boolean }>(tools, "sdd_save_artifact", {
      projectRoot,
      changeName: "caller-phase-bypass",
      phase: "sdd-apply",
      artifact: "explore",
      content: "must not persist when a caller lies about phase",
    });
    assert.equal(callerPhaseBypass.ok, false, "a caller cannot claim a mutating phase to bypass a held explore lock");
    assert.equal(callerPhaseBypass.unexpectedWrites, true, "the durable explore lock drives fingerprint enforcement");

    await assert.rejects(
      () => invoke(tools, "sdd_save_artifact", {
        projectRoot,
        changeName: "caller-phase-bypass",
        artifact: "state",
        content: "must not overwrite durable state",
      }),
      /SDD_ARTIFACT_INVALID/,
      "reserved durable state keys cannot be written as artifacts",
    );
    const lockedAfterInvalidArtifact = await invoke<{ inFlightPhase: string | null }>(tools, "sdd_status", {
      projectRoot,
      changeName: "caller-phase-bypass",
      allIds: [],
    });
    assert.equal(lockedAfterInvalidArtifact.inFlightPhase, "sdd-explore", "invalid artifact rejection retains the durable lock");

    await assert.rejects(
      () => invoke(tools, "sdd_save_artifact", {
        projectRoot,
        changeName: "caller-phase-bypass",
        artifact: "verifyReport",
        content: "must not save an artifact from another phase",
      }),
      /SDD_ARTIFACT_PHASE_MISMATCH/,
      "an artifact must match the phase held by the durable lock",
    );

    await store.writeArtifact(
      `sdd/${projectRootHash}/durable-critical/verifyReport`,
      "CRITICAL: authorization bypass remains unresolved and is not fixed.",
    );
    const criticalStatus = await invoke<{ status: string; blockedReasons: readonly string[] }>(tools, "sdd_status", {
      projectRoot,
      changeName: "durable-critical",
      allIds: [],
      verifyReportHasUnresolvedCritical: false,
    });
    assert.equal(criticalStatus.status, "blocked", "durable verify report CRITICAL blocks status despite caller false");
    assert.ok(criticalStatus.blockedReasons.some((reason) => /CRITICAL/.test(reason)), "status names the durable CRITICAL blocker");

    await store.writeArtifact(
      `sdd/${projectRootHash}/durable-critical-clean/verifyReport`,
      "No unresolved CRITICAL findings.",
    );
    const cleanCriticalStatus = await invoke<{ status: string; blockedReasons: readonly string[] }>(tools, "sdd_status", {
      projectRoot,
      changeName: "durable-critical-clean",
      allIds: [],
    });
    assert.equal(cleanCriticalStatus.status, "ok", "a persisted clean CRITICAL summary does not block status");
    assert.equal(
      cleanCriticalStatus.blockedReasons.some((reason) => /CRITICAL/.test(reason)),
      false,
      "a clean verify report adds no CRITICAL blocker",
    );

    await store.writeArtifact(
      `sdd/${projectRootHash}/durable-critical-none/verifyReport`,
      "No CRITICAL findings.",
    );
    const noCriticalStatus = await invoke<{ status: string; blockedReasons: readonly string[] }>(tools, "sdd_status", {
      projectRoot,
      changeName: "durable-critical-none",
      allIds: [],
    });
    assert.equal(noCriticalStatus.status, "ok", "an explicit no-CRITICAL report is clean");
    assert.equal(noCriticalStatus.blockedReasons.some((reason) => /CRITICAL/.test(reason)), false, "no-CRITICAL reports add no blocker");

    const faultStore = new ArtifactFaultStore(store);
    const faultTools = buildSddTools({
      store: faultStore,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    for (const [change, fault] of [["write-failure", "write"], ["readback-failure", "readback"]] as const) {
      await invoke(faultTools, "sdd_compose_phase_prompt", {
        projectRoot,
        changeName: change,
        phase: "sdd-explore",
        modelReference: "test/model",
      });
      if (fault === "write") faultStore.dropNextAtomicPersist = true;
      else faultStore.mismatchNextAtomicPersistReadback = true;
      const failedSave = await invoke<{ ok: boolean }>(faultTools, "sdd_save_artifact", {
        projectRoot,
        changeName: change,
        artifact: "explore",
        content: `must remain locked after ${fault} failure`,
      });
      assert.equal(failedSave.ok, false, `${fault} failure rejects the save`);
      const statusAfterFailedSave = await invoke<{ inFlightPhase: string | null }>(faultTools, "sdd_status", {
        projectRoot,
        changeName: change,
        allIds: [],
      });
      assert.equal(statusAfterFailedSave.inFlightPhase, "sdd-explore", `${fault} failure retains the durable lock`);
    }

    const raceState = await store.writeChangeState({
      projectRoot,
      changeName: "compose-race",
      artifactIndex: [],
      baselineFingerprint: JSON.stringify(baseline),
    }, 0);
    assert.equal(raceState.lock, undefined, "race fixture begins unlocked");
    const barrier = new StateReadBarrier();
    const raceClientA = new SqliteMcpToolClient({ dbPath });
    const raceClientB = new SqliteMcpToolClient({ dbPath });
    const raceStoreA = new PmcSddArtifactStoreAdapter(new BarrierMcpClient(raceClientA, barrier));
    const raceStoreB = new PmcSddArtifactStoreAdapter(new BarrierMcpClient(raceClientB, barrier));
    try {
      const raceToolsA = buildSddTools({ store: raceStoreA, changeStateStore: raceStoreA, captureFingerprint: async () => baseline, createSkillResolver: () => (skill) => `/skills/${skill}` }) as unknown as Record<string, unknown>;
      const raceToolsB = buildSddTools({ store: raceStoreB, changeStateStore: raceStoreB, captureFingerprint: async () => baseline, createSkillResolver: () => (skill) => `/skills/${skill}` }) as unknown as Record<string, unknown>;
      const raceResults = await Promise.allSettled([
        invoke<{ inFlightPhase: string | null; lockReclaimed?: boolean }>(raceToolsA, "sdd_compose_phase_prompt", { projectRoot, changeName: "compose-race", phase: "sdd-explore", modelReference: "test/model" }),
        invoke<{ inFlightPhase: string | null; lockReclaimed?: boolean }>(raceToolsB, "sdd_compose_phase_prompt", { projectRoot, changeName: "compose-race", phase: "sdd-explore", modelReference: "test/model" }),
      ]);
      // SPEC DL-6 — passive same-phase reclaim permits a concurrent runner
      // requesting the SAME phase to succeed (it transparently replaces the
      // owner token) rather than refuse with a lock conflict. Both fulfill;
      // the second to land is the one whose token is authoritative. The
      // observable signal is `lockReclaimed: true` on the runner that came
      // in second; the other reports `lockReclaimed` absent or undefined.
      assert.equal(
        raceResults.filter((result) => result.status === "fulfilled").length,
        2,
        "both interleaved same-phase composes succeed — the second transparently reclaims the lock",
      );
      const reclaims = raceResults.filter(
        (result) => result.status === "fulfilled" && result.value.lockReclaimed === true,
      );
      assert.equal(
        reclaims.length,
        1,
        "exactly one of the interleaved composes observes the passive reclaim",
      );
    } finally {
      raceClientA.close();
      raceClientB.close();
    }

    await invoke(tools, "sdd_compose_phase_prompt", {
      projectRoot,
      changeName: "apply-lifecycle",
      phase: "sdd-apply",
      modelReference: "test/model",
    });
    const applySave = await invoke<{ ok: boolean; inFlightPhase: string | null; artifact: string }>(tools, "sdd_save_artifact", {
      projectRoot,
      changeName: "apply-lifecycle",
      artifact: "apply",
      content: "durably saved apply outcome",
    });
    assert.equal(applySave.ok, true, "a valid apply phase saves its own artifact");
    assert.equal(applySave.inFlightPhase, null, "a successful apply save releases its own lock");
    assert.equal(
      await store.readArtifact(`sdd/${projectRootHash}/apply-lifecycle/apply`),
      "durably saved apply outcome",
      "apply artifact is durably readable after save",
    );

    const initQuestions = await invoke<{ detection: unknown }>(tools, "sdd_init_questions", {
      files: { "package.json": JSON.stringify({ scripts: { test: "npm test" } }) },
    });
    await invoke(tools, "sdd_compose_phase_prompt", {
      projectRoot,
      changeName: "init-success",
      phase: "sdd-init",
      modelReference: "test/model",
    });
    await invoke(tools, "sdd_save_config", {
      projectRoot,
      changeName: "init-success",
      detection: initQuestions.detection,
    });
    const initSuccessStatus = await invoke<{ inFlightPhase: string | null }>(tools, "sdd_status", {
      projectRoot,
      changeName: "init-success",
      allIds: [],
    });
    assert.equal(initSuccessStatus.inFlightPhase, null, "durably persisted init config releases its own lock");

    await invoke(tools, "sdd_compose_phase_prompt", {
      projectRoot: initValidationRoot,
      changeName: "init-validation-failure",
      phase: "sdd-init",
      modelReference: "test/model",
    });
    await assert.rejects(
      () => invoke(tools, "sdd_save_config", {
        projectRoot: initValidationRoot,
        changeName: "init-validation-failure",
        detection: null,
      }),
      /detection must run before saving config/,
      "config validation failure rejects while the init lock remains held",
    );
    const initValidationFailureStatus = await invoke<{ inFlightPhase: string | null }>(tools, "sdd_status", {
      projectRoot: initValidationRoot,
      changeName: "init-validation-failure",
      allIds: [],
    });
    assert.equal(initValidationFailureStatus.inFlightPhase, "sdd-init", "config validation failure retains the init lock");

    const configFaultStore = new ArtifactFaultStore(store);
    const configFaultTools = buildSddTools({
      store: configFaultStore,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    await invoke(configFaultTools, "sdd_compose_phase_prompt", {
      projectRoot: initReadbackRoot,
      changeName: "init-readback-failure",
      phase: "sdd-init",
      modelReference: "test/model",
    });
    configFaultStore.mismatchNextCheckpointRead = true;
    await assert.rejects(
      () => invoke(configFaultTools, "sdd_save_config", {
        projectRoot: initReadbackRoot,
        changeName: "init-readback-failure",
        detection: initQuestions.detection,
      }),
      /SDD_INIT_CONFIG_READBACK_MISMATCH/,
      "config readback mismatch rejects while the init lock remains held",
    );
    const initReadbackFailureStatus = await invoke<{ inFlightPhase: string | null }>(configFaultTools, "sdd_status", {
      projectRoot: initReadbackRoot,
      changeName: "init-readback-failure",
      allIds: [],
    });
    assert.equal(initReadbackFailureStatus.inFlightPhase, "sdd-init", "config readback failure retains the init lock");

    const initFingerprints = [baseline, changed];
    const initFingerprintTools = buildSddTools({
      store,
      changeStateStore: store,
      captureFingerprint: async () => initFingerprints.shift() ?? changed,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    await invoke(initFingerprintTools, "sdd_compose_phase_prompt", {
      projectRoot: initFingerprintRoot,
      changeName: "init-fingerprint-mismatch",
      phase: "sdd-init",
      modelReference: "test/model",
    });
    const initFingerprintMismatch = await invoke<{ ok: boolean; unexpectedWrites?: boolean }>(initFingerprintTools, "sdd_save_config", {
      projectRoot: initFingerprintRoot,
      changeName: "init-fingerprint-mismatch",
      detection: initQuestions.detection,
    });
    assert.equal(initFingerprintMismatch.ok, false, "changed init worktree fails before config persistence");
    assert.equal(initFingerprintMismatch.unexpectedWrites, true, "changed init worktree reports unexpected writes");
    const initFingerprintStatus = await invoke<{ inFlightPhase: string | null }>(initFingerprintTools, "sdd_status", {
      projectRoot: initFingerprintRoot,
      changeName: "init-fingerprint-mismatch",
      allIds: [],
    });
    assert.equal(initFingerprintStatus.inFlightPhase, "sdd-init", "changed init worktree retains the init lock");

    // The reserved sentinel name is a security boundary, so it is asserted at
    // EVERY public entry point that accepts a changeName — not just compose.
    // Each tool is asserted separately so a boundary that loses its guard fails
    // here by name instead of being masked by a sibling that still rejects.
    const reservedName = "__sdd_project_init_lock__";
    const reservedRejections: readonly (readonly [string, Record<string, unknown>])[] = [
      ["sdd_status", { projectRoot: sentinelSpoofRoot, changeName: reservedName, allIds: [] }],
      ["sdd_compose_phase_prompt", {
        projectRoot: sentinelSpoofRoot,
        changeName: reservedName,
        phase: "sdd-explore",
        modelReference: "test/model",
      }],
      ["sdd_save_artifact", {
        projectRoot: sentinelSpoofRoot,
        changeName: reservedName,
        artifact: "explore",
        content: "spoofed sentinel artifact",
      }],
      ["sdd_save_config", {
        projectRoot: sentinelSpoofRoot,
        changeName: reservedName,
        detection: initQuestions.detection,
      }],
      ["sdd_checkpoint", {
        projectRoot: sentinelSpoofRoot,
        changeName: reservedName,
        phase: "apply",
        action: "declare",
        totalIds: ["spoof-1"],
      }],
    ];
    for (const [toolName, reservedArgs] of reservedRejections) {
      // Matching SDD_CHANGE_NAME_RESERVED specifically (rather than accepting
      // any rejection) is what proves the guard fires BEFORE state access: a
      // tool that reached its store would fail with a lock-conflict or an
      // artifact-validation error instead.
      await assert.rejects(
        () => invoke(tools, toolName, reservedArgs),
        /SDD_CHANGE_NAME_RESERVED/,
        `${toolName} rejects the private project-init sentinel name before any state access`,
      );
    }

    // Durable-state absence, probed directly. Discovery filters the sentinel
    // unconditionally, so a discovery-only assertion stays green even if a
    // rejected spoof had persisted an unlocked sentinel record. This reads the
    // durable store itself, which is the externally visible invariant.
    const spoofedSentinelState = await store.readChangeState(sentinelSpoofRoot, reservedName);
    assert.equal(
      spoofedSentinelState,
      null,
      "no sentinel change state is persisted in durable storage by a rejected spoof",
    );
    const sentinelSpoofDiscovery = await invoke<{ changes: readonly { changeName: string }[] }>(tools, "sdd_status", {
      projectRoot: sentinelSpoofRoot,
    });
    assert.equal(
      sentinelSpoofDiscovery.changes.some((change) => change.changeName === reservedName),
      false,
      "rejected sentinel spoof is not discoverable",
    );
    await invoke(tools, "sdd_compose_phase_prompt", {
      projectRoot: sentinelSpoofRoot,
      changeName: "real-init-after-spoof",
      phase: "sdd-init",
      modelReference: "test/model",
    });
    await invoke(tools, "sdd_save_config", {
      projectRoot: sentinelSpoofRoot,
      changeName: "real-init-after-spoof",
      detection: initQuestions.detection,
    });
    const realInitAfterSpoof = await invoke<{ inFlightPhase: string | null }>(tools, "sdd_status", {
      projectRoot: sentinelSpoofRoot,
      changeName: "real-init-after-spoof",
      allIds: [],
    });
    assert.equal(realInitAfterSpoof.inFlightPhase, null, "a real init can acquire and release after a rejected sentinel spoof");

    const projectInitToolsA = buildSddTools({
      store,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    const projectInitToolsB = buildSddTools({
      store,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    await invoke(projectInitToolsA, "sdd_compose_phase_prompt", {
      projectRoot: initProjectLockRoot,
      changeName: "init-project-a",
      phase: "sdd-init",
      modelReference: "test/model",
    });
    // Final-review finding #1 — the project-global init sentinel is
    // BOUND to the change that acquired it. A second sdd-init dispatch
    // for a DIFFERENT change receives a typed binding conflict; the
    // sentinel-bound live init remains untouched. (The same-phase
    // resume path for the bound change is asserted at the port layer
    // in sdd-change-state.test.ts scenarios (o) and Pass 3 scenarios.)
    await assert.rejects(
      () =>
        invoke(projectInitToolsB, "sdd_compose_phase_prompt", {
          projectRoot: initProjectLockRoot,
          changeName: "init-project-b",
          phase: "sdd-init",
          modelReference: "test/model",
        }),
      /SDD_CHANGE_STATE_SENTINEL_BINDING_CONFLICT/,
      "a second sdd-init dispatch for a different change cannot acquire the sentinel bound to the first",
    );
    const competingInitStatus = await invoke<{ inFlightPhase: string | null }>(projectInitToolsB, "sdd_status", {
      projectRoot: initProjectLockRoot,
      changeName: "init-project-b",
      allIds: [],
    });
    assert.equal(competingInitStatus.inFlightPhase, null, "rejected competing init change receives no lock");
    // The bound init remains held by the first change.
    const boundInitStatus = await invoke<{ inFlightPhase: string | null }>(projectInitToolsA, "sdd_status", {
      projectRoot: initProjectLockRoot,
      changeName: "init-project-a",
      allIds: [],
    });
    assert.equal(boundInitStatus.inFlightPhase, "sdd-init", "the bound init keeps its lock through the rejected competing compose");

    // SPEC DL-6 — explicit deliberate clear through the public surface.
    // The recovered audit is exposed to the caller; other changes can then
    // acquire normally; no automatic timeout is involved.
    const recoveryRoot = path.join(tempDir, "explicit-recovery");
    mkdirSync(recoveryRoot);
    await invoke(tools, "sdd_compose_phase_prompt", {
      projectRoot: recoveryRoot,
      changeName: "recovery-target",
      phase: "sdd-apply",
      modelReference: "test/model",
    });
    const stuckStatus = await invoke<{ inFlightPhase: string | null }>(tools, "sdd_status", {
      projectRoot: recoveryRoot,
      changeName: "recovery-target",
      allIds: [],
    });
    assert.equal(stuckStatus.inFlightPhase, "sdd-apply", "the locked change reports its held phase publicly");
    const recovery = await invoke<{
      ok: boolean;
      audit: { changeName: string; projectRoot: string; reason: string; priorLock: { phase: string } | null };
    }>(tools, "sdd_recover_phase_lock", {
      projectRoot: recoveryRoot,
      changeName: "recovery-target",
      reason: "operator confirmed the runner process is dead; replay authorized",
    });
    assert.equal(recovery.ok, true, "the explicit recovery tool succeeds when a lock is held");
    assert.equal(recovery.audit.changeName, "recovery-target", "the audit names the cleared change");
    assert.equal(recovery.audit.projectRoot, recoveryRoot, "the audit names the canonical project root");
    assert.match(recovery.audit.reason, /operator confirmed/, "the audit preserves the caller reason verbatim");
    assert.deepEqual(recovery.audit.priorLock, { phase: "sdd-apply" }, "the audit surfaces the cleared phase");
    const recoveredStatus = await invoke<{ inFlightPhase: string | null }>(tools, "sdd_status", {
      projectRoot: recoveryRoot,
      changeName: "recovery-target",
      allIds: [],
    });
    assert.equal(recoveredStatus.inFlightPhase, null, "the recovery clears the durable lock");
    const reacquired = await invoke<{ inFlightPhase: string | null }>(tools, "sdd_compose_phase_prompt", {
      projectRoot: recoveryRoot,
      changeName: "recovery-target",
      phase: "sdd-verify",
      modelReference: "test/model",
    });
    assert.equal(reacquired.inFlightPhase, "sdd-verify", "the next phase acquires normally after explicit recovery");

    // SPEC DL-6 — passive same-phase reclaim. A freshly constructed tool
    // surface composing the SAME phase reclaims the durable lock with a fresh
    // owner token; other phases still conflict.
    const reclaimRoot = path.join(tempDir, "passive-reclaim");
    mkdirSync(reclaimRoot);
    const firstSurfaceTools = buildSddTools({
      store,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    const firstCompose = await invoke<{ inFlightPhase: string | null }>(firstSurfaceTools, "sdd_compose_phase_prompt", {
      projectRoot: reclaimRoot,
      changeName: "reclaim-target",
      phase: "sdd-apply",
      modelReference: "test/model",
    });
    assert.equal(firstCompose.inFlightPhase, "sdd-apply", "the first surface acquires the apply lock");

    // A second, freshly constructed tool surface composes the SAME phase.
    // Without DL-6 recovery this would refuse with SDD_CHANGE_STATE_LOCK_CONFLICT;
    // with reclaim it succeeds, reporting the held phase publicly but never
    // the prior owner token, and the next phase still conflicts.
    const secondSurfaceTools = buildSddTools({
      store,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    const secondCompose = await invoke<{ inFlightPhase: string | null }>(secondSurfaceTools, "sdd_compose_phase_prompt", {
      projectRoot: reclaimRoot,
      changeName: "reclaim-target",
      phase: "sdd-apply",
      modelReference: "test/model",
    });
    assert.equal(secondCompose.inFlightPhase, "sdd-apply", "the restarted surface reclaims the same phase lock");
    const crossPhase = firstSurfaceTools["sdd_compose_phase_prompt"] as ToolDefinitionLike;
    await assert.rejects(
      () => crossPhase.execute({
        projectRoot: reclaimRoot,
        changeName: "reclaim-target",
        phase: "sdd-verify",
        modelReference: "test/model",
      }),
      /SDD_CHANGE_STATE_LOCK_CONFLICT/,
      "a different phase from any surface still conflicts after passive same-phase reclaim",
    );

    const initWriteFaultStore = new ArtifactFaultStore(store);
    const initWriteFaultTools = buildSddTools({
      store: initWriteFaultStore,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    await invoke(initWriteFaultTools, "sdd_compose_phase_prompt", {
      projectRoot: initWriteFailureRoot,
      changeName: "init-write-failure",
      phase: "sdd-init",
      modelReference: "test/model",
    });
    initWriteFaultStore.throwNextCheckpointWrite = true;
    await assert.rejects(
      () => invoke(initWriteFaultTools, "sdd_save_config", {
        projectRoot: initWriteFailureRoot,
        changeName: "init-write-failure",
        detection: initQuestions.detection,
      }),
      /forced config checkpoint write failure/,
      "thrown config checkpoint write retains the init lock",
    );
    const initWriteFailureStatus = await invoke<{ inFlightPhase: string | null }>(initWriteFaultTools, "sdd_status", {
      projectRoot: initWriteFailureRoot,
      changeName: "init-write-failure",
      allIds: [],
    });
    assert.equal(initWriteFailureStatus.inFlightPhase, "sdd-init", "thrown config write retains the init lock");

    // Reviewer finding #1 — public-surface end-to-end. A crashed sdd-init
    // dispatch leaves the project-global init sentinel held by sdd-init
    // AND the user change held by sdd-init. A fresh sdd-init compose must
    // transparently reclaim BOTH (without exposing or accepting any reserved
    // change name); subsequent status shows the same in-flight phase with
    // the new owner. Unrelated phases still cannot compose against the
    // sentinel or the user change.
    const sentinelRoot = path.join(tempDir, "sentinel-recovery");
    mkdirSync(sentinelRoot);
    const staleInitTools = buildSddTools({
      store,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    await invoke(staleInitTools, "sdd_compose_phase_prompt", {
      projectRoot: sentinelRoot,
      changeName: "stale-init-change",
      phase: "sdd-init",
      modelReference: "test/model",
    });
    const staleInitStatus = await invoke<{ inFlightPhase: string | null }>(staleInitTools, "sdd_status", {
      projectRoot: sentinelRoot,
      changeName: "stale-init-change",
      allIds: [],
    });
    assert.equal(staleInitStatus.inFlightPhase, "sdd-init", "stale sdd-init dispatch holds the user change");

    const freshInitTools = buildSddTools({
      store,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    const freshInitCompose = await invoke<{ inFlightPhase: string | null; lockReclaimed?: boolean }>(
      freshInitTools,
      "sdd_compose_phase_prompt",
      {
        projectRoot: sentinelRoot,
        changeName: "stale-init-change",
        phase: "sdd-init",
        modelReference: "test/model",
      },
    );
    assert.equal(freshInitCompose.inFlightPhase, "sdd-init", "fresh sdd-init compose reclaims and succeeds");
    assert.equal(freshInitCompose.lockReclaimed, true, "the user-change reclaim is observable");
    const sentinelStatus = await invoke<{ inFlightPhase: string | null }>(
      freshInitTools,
      "sdd_status",
      { projectRoot: sentinelRoot, changeName: "stale-init-change", allIds: [] },
    );
    assert.equal(
      sentinelStatus.inFlightPhase ?? null,
      "sdd-init",
      "the user change still reports the held phase after sentinel reclaim",
    );
    // Cross-phase attempts still conflict (the sentinel's typed refusal is
    // asserted at the port layer in sdd-change-state.test.ts (o); here we
    // verify the user-change level too).
    await assert.rejects(
      () =>
        invoke(freshInitTools, "sdd_compose_phase_prompt", {
          projectRoot: sentinelRoot,
          changeName: "stale-init-change",
          phase: "sdd-apply",
          modelReference: "test/model",
        }),
      /SDD_CHANGE_STATE_LOCK_CONFLICT/,
      "an sdd-apply dispatch cannot acquire while sdd-init still holds the user change",
    );

    // Reviewer finding #1 — recovery of an init change ALSO clears the
    // sentinel. The public surface accepts the user's ordinary changeName;
    // the sentinel name is resolved internally and never appears in args.
    const recoveryResult = await invoke<{
      ok: boolean;
      audit: { changeName: string; reason: string; priorLock: { phase: string } | null };
      sentinelAudit: { changeName: string; reason: string; priorLock: { phase: string } | null } | null;
    }>(freshInitTools, "sdd_recover_phase_lock", {
      projectRoot: sentinelRoot,
      changeName: "stale-init-change",
      reason: "init runner crashed mid-detection; replay required",
    });
    assert.equal(recoveryResult.ok, true, "explicit recovery succeeds");
    assert.equal(recoveryResult.audit.changeName, "stale-init-change", "audit names the user change");
    assert.deepEqual(recoveryResult.audit.priorLock, { phase: "sdd-init" }, "audit surfaces the cleared user-change phase");
    assert.notEqual(recoveryResult.sentinelAudit, null, "the sentinel was also cleared because the user change was held by sdd-init");
    assert.equal(recoveryResult.sentinelAudit!.changeName, "__sdd_project_init_lock__", "the sentinel audit names the sentinel");
    assert.deepEqual(recoveryResult.sentinelAudit!.priorLock, { phase: "sdd-init" }, "the sentinel audit surfaces the cleared sentinel phase");
    assert.match(
      recoveryResult.sentinelAudit!.reason,
      /\[sentinel-recovery from stale-init-change\]/,
      "the sentinel audit carries the cross-reference so a downstream review can attribute the clear",
    );

    // Reserved names are still rejected at the public surface — recovery
    // never accepts them.
    await assert.rejects(
      () =>
        invoke(freshInitTools, "sdd_recover_phase_lock", {
          projectRoot: sentinelRoot,
          changeName: "__sdd_project_init_lock__",
          reason: "must be refused",
        }),
      /SDD_CHANGE_NAME_RESERVED/,
      "the recovery tool refuses to accept a reserved change name even though it could resolve the sentinel internally",
    );

    // Reviewer finding #2 — a displaced/revoked old tool surface MUST be
    // unable to persist artifacts even if it retains a local token. We
    // simulate this by reclaiming the user change under a fresh surface
    // (which replaces the durable owner token) and then attempting to save
    // through the original surface, whose in-memory token map still says
    // it owns the lock.
    const staleRoot = path.join(tempDir, "stale-owner-save");
    mkdirSync(staleRoot);
    const originalSurfaceTools = buildSddTools({
      store,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    await invoke(originalSurfaceTools, "sdd_compose_phase_prompt", {
      projectRoot: staleRoot,
      changeName: "stale-save-target",
      phase: "sdd-explore",
      modelReference: "test/model",
    });

    // A second surface reclaims the same-phase lock. The original surface
    // still has a local ownerToken pointing to the revoked durable owner.
    const replacementSurfaceTools = buildSddTools({
      store,
      changeStateStore: store,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    const replacementCompose = await invoke<{ lockReclaimed?: boolean }>(
      replacementSurfaceTools,
      "sdd_compose_phase_prompt",
      {
        projectRoot: staleRoot,
        changeName: "stale-save-target",
        phase: "sdd-explore",
        modelReference: "test/model",
      },
    );
    assert.equal(replacementCompose.lockReclaimed, true, "the replacement surface reclaims the lock");

    // The original surface now tries to save — it still has the OLD token
    // in its in-memory map. verifyOwnedLock must refuse BEFORE any
    // artifact write.
    const staleProjectRootHash = canonicalizeProjectRoot(staleRoot).projectRootHash;
    const artifactKey = `sdd/${staleProjectRootHash}/stale-save-target/explore`;
    assert.equal(
      await store.readArtifact(artifactKey),
      null,
      "no artifact has been persisted yet — the displaced surface cannot have written one",
    );
    await assert.rejects(
      () =>
        invoke(originalSurfaceTools, "sdd_save_artifact", {
          projectRoot: staleRoot,
          changeName: "stale-save-target",
          artifact: "explore",
          content: "must not be persisted by a displaced surface",
        }),
      /SDD_CHANGE_STATE_LOCK_CONFLICT/,
      "the displaced surface is refused before any write",
    );
    assert.equal(
      await store.readArtifact(artifactKey),
      null,
      "the artifact remains unpersisted after the displaced save attempt",
    );

    // The replacement surface (which holds the fresh token) saves cleanly.
    const replacementSave = await invoke<{ ok: boolean }>(replacementSurfaceTools, "sdd_save_artifact", {
      projectRoot: staleRoot,
      changeName: "stale-save-target",
      artifact: "explore",
      content: "durably saved by the fresh owner",
    });
    assert.equal(replacementSave.ok, true, "the fresh owner saves the artifact normally");
    assert.equal(
      await store.readArtifact(artifactKey),
      "durably saved by the fresh owner",
      "the fresh owner's content is the one that landed in the store",
    );

    // Final-review finding #3 — deterministic injected-reclaim-after-
    // verification test for the atomic artifact persist. We construct
    // a scenario in which a concurrent reclaim lands between the
    // atomic persist's verification and its commit by using two
    // SQLite handles: the "replacement" handle performs the reclaim
    // (advancing the durable version) and then we attempt the
    // persisted write from the original handle (whose in-memory
    // owner token is now stale). The atomic persist MUST refuse and
    // the artifact MUST NOT be persisted.
    const injectionRoot = path.join(tempDir, "injected-reclaim");
    mkdirSync(injectionRoot);
    const injectionProjectRootHash = canonicalizeProjectRoot(injectionRoot).projectRootHash;
    const injectionArtifactKey = `sdd/${injectionProjectRootHash}/injected-reclaim-target/explore`;

    const injectionOriginalClient = new SqliteMcpToolClient({ dbPath });
    const injectionOriginalStore = new PmcSddArtifactStoreAdapter(injectionOriginalClient);
    const injectionOriginalTools = buildSddTools({
      store: injectionOriginalStore,
      changeStateStore: injectionOriginalStore,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    await invoke(injectionOriginalTools, "sdd_compose_phase_prompt", {
      projectRoot: injectionRoot,
      changeName: "injected-reclaim-target",
      phase: "sdd-explore",
      modelReference: "test/model",
    });
    // A second, separate handle reclaims the same-phase lock. The
    // original handle still has the OLD token in its in-memory map.
    const injectionReplacementClient = new SqliteMcpToolClient({ dbPath });
    const injectionReplacementStore = new PmcSddArtifactStoreAdapter(injectionReplacementClient);
    const injectionReplacementTools = buildSddTools({
      store: injectionReplacementStore,
      changeStateStore: injectionReplacementStore,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    await invoke(injectionReplacementTools, "sdd_compose_phase_prompt", {
      projectRoot: injectionRoot,
      changeName: "injected-reclaim-target",
      phase: "sdd-explore",
      modelReference: "test/model",
    });
    // Sanity: the artifact is NOT yet on disk.
    assert.equal(
      await store.readArtifact(injectionArtifactKey),
      null,
      "no artifact persisted before the displaced save attempt",
    );
    // The original (stale-token) handle tries to save. The atomic
    // persist MUST refuse and the artifact MUST NOT land.
    await assert.rejects(
      () =>
        invoke(injectionOriginalTools, "sdd_save_artifact", {
          projectRoot: injectionRoot,
          changeName: "injected-reclaim-target",
          artifact: "explore",
          content: "must not be persisted by a displaced runner",
        }),
      /SDD_CHANGE_STATE_LOCK_CONFLICT/,
      "the displaced runner is refused by the atomic persist",
    );
    assert.equal(
      await store.readArtifact(injectionArtifactKey),
      null,
      "the atomic persist did not write the artifact under the displaced owner",
    );
    injectionOriginalClient.close();
    injectionReplacementClient.close();

    // C-N1 remediation — sdd_compose_phase_prompt for a phase with
    // mandatory skills (sdd-tasks), with NO skillResolver injected. This
    // is exactly the real `src/bootstrap/index.ts` wiring gap the prior
    // verification found: the durable lock is acquired and the baseline
    // fingerprint is persisted BEFORE composePhasePrompt runs, so a throw
    // from composition must not leave that lock durably held. The tool
    // MUST throw UnresolvableSkillError, and the lock it just acquired
    // MUST NOT survive the throw.
    const noResolverRoot = path.join(tempDir, "no-skill-resolver");
    mkdirSync(noResolverRoot);
    const noResolverClient = new SqliteMcpToolClient({ dbPath });
    const noResolverStore = new PmcSddArtifactStoreAdapter(noResolverClient);
    const noResolverTools = buildSddTools({
      store: noResolverStore,
      changeStateStore: noResolverStore,
      captureFingerprint: async () => baseline,
      // Deliberately omitted: this reproduces the real bootstrap wiring
      // gap (C-N1), not a contrived test-only condition.
    }) as unknown as Record<string, unknown>;
    await assert.rejects(
      () =>
        invoke(noResolverTools, "sdd_compose_phase_prompt", {
          projectRoot: noResolverRoot,
          changeName: "no-resolver-target",
          phase: "sdd-tasks",
          modelReference: "test/model",
        }),
      /UNRESOLVABLE_SKILL/,
      "compose throws when no skillResolver is injected for a phase with mandatory skills",
    );
    const stateAfterFailedCompose = await noResolverStore.readChangeState(noResolverRoot, "no-resolver-target");
    assert.equal(
      stateAfterFailedCompose?.lock,
      undefined,
      "the durable lock acquired by the failed compose does not survive the throw",
    );
    // A subsequent compose for a DIFFERENT phase on the same change must
    // succeed WITHOUT needing sdd_recover_phase_lock — this is what
    // distinguishes "released" from the passive same-phase reclaim that
    // would merely keep re-acquiring the same stuck phase forever.
    const recoveryTools = buildSddTools({
      store: noResolverStore,
      changeStateStore: noResolverStore,
      captureFingerprint: async () => baseline,
      createSkillResolver: () => (skill) => `/skills/${skill}`,
    }) as unknown as Record<string, unknown>;
    const recoveredCompose = await invoke<{ subagentType: string }>(recoveryTools, "sdd_compose_phase_prompt", {
      projectRoot: noResolverRoot,
      changeName: "no-resolver-target",
      phase: "sdd-explore",
      modelReference: "test/model",
    });
    assert.ok(
      recoveredCompose.subagentType.includes("sdd-mr-base"),
      "a different phase composes successfully after the leaked lock was released, with no recovery tool needed",
    );
    noResolverClient.close();

    // C-R1 (Option B) + W-N6 — happy path through the REAL filesystem-backed
    // resolver at the registered tool boundary: sdd-tasks has two mandatory
    // skills (work-unit-commits, chained-pr); a project with a readable
    // .atl/skill-registry.md must compose successfully and bake the resolved
    // absolute paths into the prompt.
    const happyRoot = path.join(tempDir, "happy-path-registry");
    mkdirSync(path.join(happyRoot, ".atl"), { recursive: true });
    writeFileSync(
      path.join(happyRoot, ".atl", "skill-registry.md"),
      [
        "# Skill Registry — happy path fixture",
        "",
        "| Skill | Trigger / description | Scope | Path |",
        "| --- | --- | --- | --- |",
        "| `work-unit-commits` | x | user | `C:\\fixture\\work-unit-commits\\SKILL.md` |",
        "| `chained-pr` | x | user | `C:\\fixture\\chained-pr\\SKILL.md` |",
        "",
      ].join("\n"),
      "utf8",
    );
    const happyClient = new SqliteMcpToolClient({ dbPath });
    const happyStore = new PmcSddArtifactStoreAdapter(happyClient);
    const happyTools = buildSddTools({
      store: happyStore,
      changeStateStore: happyStore,
      captureFingerprint: async () => baseline,
      createSkillResolver: (root) =>
        createSkillRegistryResolver(root, { defaultRegistryPath: path.join(tempDir, "no-default.md") }),
    }) as unknown as Record<string, unknown>;
    const happyCompose = await invoke<{ prompt: string; inFlightPhase: string }>(happyTools, "sdd_compose_phase_prompt", {
      projectRoot: happyRoot,
      changeName: "happy-path-target",
      phase: "sdd-tasks",
      modelReference: "test/model",
    });
    assert.ok(
      happyCompose.prompt.includes("C:\\fixture\\work-unit-commits\\SKILL.md"),
      "the composed prompt bakes in the resolved work-unit-commits path",
    );
    assert.ok(
      happyCompose.prompt.includes("C:\\fixture\\chained-pr\\SKILL.md"),
      "the composed prompt bakes in the resolved chained-pr path",
    );
    console.log("  pass: W-N6 happy path — mandatory skills resolve through the real resolver at the tool boundary");

    // W-N1 — the resolver is bound to the PER-CALL projectRoot, never a
    // startup capture: one tool surface, two project roots with distinct
    // registries, each compose must resolve against its own root.
    const perCallRootB = path.join(tempDir, "per-call-root-b");
    mkdirSync(path.join(perCallRootB, ".atl"), { recursive: true });
    writeFileSync(
      path.join(perCallRootB, ".atl", "skill-registry.md"),
      [
        "# Skill Registry — root B fixture",
        "",
        "| Skill | Trigger / description | Scope | Path |",
        "| --- | --- | --- | --- |",
        "| `work-unit-commits` | x | user | `C:\\fixture-b\\work-unit-commits\\SKILL.md` |",
        "",
      ].join("\n"),
      "utf8",
    );
    const perCallCompose = await invoke<{ prompt: string }>(happyTools, "sdd_compose_phase_prompt", {
      projectRoot: perCallRootB,
      changeName: "per-call-target",
      phase: "sdd-apply",
      modelReference: "test/model",
    });
    assert.ok(
      perCallCompose.prompt.includes("C:\\fixture-b\\work-unit-commits\\SKILL.md"),
      "the same tool surface resolves against the per-call projectRoot, not the first root used",
    );
    assert.ok(
      !perCallCompose.prompt.includes("C:\\fixture\\chained-pr\\SKILL.md"),
      "no state from the earlier root leaks into a later call",
    );
    console.log("  pass: W-N1 — resolver binding follows the per-call projectRoot");
    happyClient.close();

    // C-R1 diagnosability — no readable registry anywhere: the tool fails
    // with SKILL_REGISTRY_UNAVAILABLE naming the searched paths, and the
    // durable lock it acquired does not survive the throw.
    const noRegistryRoot = path.join(tempDir, "no-registry-anywhere");
    mkdirSync(noRegistryRoot);
    const noRegistryClient = new SqliteMcpToolClient({ dbPath });
    const noRegistryStore = new PmcSddArtifactStoreAdapter(noRegistryClient);
    const noRegistryDefault = path.join(tempDir, "absent-default.md");
    const noRegistryTools = buildSddTools({
      store: noRegistryStore,
      changeStateStore: noRegistryStore,
      captureFingerprint: async () => baseline,
      createSkillResolver: (root) => createSkillRegistryResolver(root, { defaultRegistryPath: noRegistryDefault }),
    }) as unknown as Record<string, unknown>;
    await assert.rejects(
      () =>
        invoke(noRegistryTools, "sdd_compose_phase_prompt", {
          projectRoot: noRegistryRoot,
          changeName: "no-registry-target",
          phase: "sdd-tasks",
          modelReference: "test/model",
        }),
      (err: unknown) => {
        assert.match((err as Error).message, /SKILL_REGISTRY_UNAVAILABLE/, "names the failure code");
        assert.match((err as Error).message, /no-registry-anywhere/, "names the searched .atl path");
        assert.match((err as Error).message, /absent-default\.md/, "names the searched default path");
        return true;
      },
      "compose with no readable registry fails diagnosably",
    );
    const stateAfterNoRegistry = await noRegistryStore.readChangeState(noRegistryRoot, "no-registry-target");
    assert.equal(
      stateAfterNoRegistry?.lock,
      undefined,
      "the durable lock acquired by the registry-failing compose does not survive the throw",
    );
    console.log("  pass: no readable registry fails diagnosably and releases the lock");
    noRegistryClient.close();

    console.log("All sdd-tools integration tests passed.");
  } finally {
    client.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
