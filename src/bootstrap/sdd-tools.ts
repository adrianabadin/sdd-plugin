/**
 * The SDD MCP tool surface: the EIGHT tools the SDD phase-agent system
 * exposes to the LLM.
 *
 *   1. `sdd_status`                         — read-only unified status
 *   2. `sdd_compose_phase_prompt`           — acquire dispatch lock + compose
 *   3. `sdd_save_artifact`                  — atomic persist (verify + write)
 *   4. `sdd_parse_request`                  — split free-text into SDD fields
 *   5. `sdd_init_questions`                  — detection + residual questions
 *   6. `sdd_save_config`                     — atomic validate + init checkpoint
 *   7. `sdd_checkpoint`                      — mid-phase resumability
 *   8. `sdd_recover_phase_lock`              — explicit deliberate clear
 *
 * The eighth tool, `sdd_recover_phase_lock`, is a versioned-contract
 * addition. See the `VERSIONED CONTRACT NOTE — 7 → 8 tool surface` below.
 *
 * Every port operation backing these tools is the versioned CONTRACT
 * surface documented in the apply log under "Pass 3" (reviewer-finding
 * pass). The previous seven-tool docs in
 * `docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md` (design
 * §2) and `docs/superpowers/specs/2026-08-02-sdd-phase-agents-VERIFY.md`
 * ("none of the seven tools") have been SUPERSEDED by this eight-tool
 * surface; the apply log records the diff.
 *
 * --------------------------------------------------------------------------
 * VERSIONED CONTRACT NOTE — 7 → 8 tool surface
 * --------------------------------------------------------------------------
 * The pre-recovery design documented seven tools. The DL-6 explicit-recovery
 * requirement (SPEC §sdd-dispatch-lock: "the clear is explicit, never
 * automatic on timeout") cannot be satisfied by the seven-tool surface
 * alone — there is no public seam through which an operator can clear a
 * stuck lock with audit metadata, and any silent fallback would violate
 * the "never automatic" rule. The eighth tool, `sdd_recover_phase_lock`,
 * is the versioned contract change.
 *
 * Consumer impact: orchestrator code that introspects the registered tool
 * map and expects exactly seven entries must update to expect eight. The
 * new tool is additive (no other tool's signature changed). The change is
 * reflected in `src/bootstrap/index.ts` registration log and in the apply
 * log under the versioned-contract section.
 *
 * Why this is not hidden: per the user instruction "update
 * registration/contracts/tests coherently rather than hiding
 * functionality", the seven→eight transition is documented at:
 *   - this header comment (module-level);
 *   - `src/bootstrap/index.ts` registration log (process-level);
 *   - `docs/superpowers/specs/2026-08-03-sdd-phase-agents-remediation-APPLY.md`
 *     (workstream-level).
 * --------------------------------------------------------------------------
 *
 * Companion ports (also versioned by this pass):
 *   - `SddChangeStateStorePort`: `acquireChangeStateLock` and
 *     `reclaimChangeStateLock` and `recoverChangeStateLock` now accept an
 *     optional `boundChangeName`/`expectedBoundChangeName` so the
 *     project-init sentinel can bind to its owning change (reviewer
 *     finding #1). A new `verifyInitRoundOwnership` method validates
 *     BOTH the user change and the sentinel atomically so a stale init
 *     runner cannot cause a persisted config mutation (reviewer finding
 *     #2).
 *   - `SddArtifactStorePort`: a new `persistArtifactWithOwnership` method
 *     wraps verify + write + readback + state-update + lock-release in a
 *     single SQLite transaction, closing the verify-then-write TOCTOU
 *     window (reviewer finding #3).
 *
 * All consumer-impact details and real RED→GREEN cycles are in
 * `docs/superpowers/specs/2026-08-03-sdd-phase-agents-remediation-APPLY.md`.
 */

import { randomUUID } from "node:crypto";

import { tool } from "@opencode-ai/plugin/tool";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";

import { assembleStatus, hasUnresolvedCriticalFinding } from "../application/sdd/compute-status.js";
import { assembleDiscoveryStatus } from "../application/sdd/compute-discovery-status.js";
import { isProjectInitialized } from "../application/sdd/init-round.js";
import { composePhasePrompt } from "../application/sdd/prompt-composition.js";
import { saveArtifact } from "../application/sdd/save-artifact.js";
import { captureWorktreeFingerprint } from "../application/sdd/worktree-fingerprint.js";
import { sddParseRequest } from "../application/sdd/entry-flow.js";
import {
  detectProjectFacts,
  getInitQuestions,
  saveInitConfig,
} from "../application/sdd/init-round.js";
import {
  declareBatch,
  recordCompletion,
  blockMidBatch,
  resumeBatch,
  readCheckpointData,
} from "../application/sdd/checkpoint.js";
import { canonicalizeProjectRoot } from "../domain/sdd/project-identity.js";
import { UnresolvableSkillError } from "../domain/sdd/prompt-composition.js";
import type { SkillResolutionAttempt } from "../domain/sdd/skill-resolution.js";
import { changeArtifactKey, initConfigKey } from "../domain/sdd/sdd-keys.js";
import {
  compareWorktreeFingerprints,
  isPhaseMutating,
  PHASE_MUTATING_TABLE,
  type WorktreeFingerprint,
} from "../domain/sdd/worktree-fingerprint.js";
import {
  SddChangeStateLockConflictError,
  SddChangeStateVersionConflictError,
  type SddArtifactStorePort,
  type SddChangeState,
  type SddChangeStateStorePort,
} from "../ports/sdd-artifact-store.port.js";

export interface SddToolsDeps {
  readonly store: SddArtifactStorePort;
  readonly changeStateStore: SddChangeStateStorePort;
  /**
   * Creates the skill resolver for the PER-CALL `args.projectRoot` — invoked
   * on every tool call, so resolution follows the module's documented
   * invariant (per-call root, never a startup-time capture; W-N1). The
   * returned resolver may optionally expose `attempts()` diagnostics, which
   * are folded into `UnresolvableSkillError` so a compose failure names every
   * skill source, its lookup key, and why it failed. Null from the resolver
   * means "unresolvable" (PC-6).
   */
  readonly createSkillResolver?: (projectRoot: string) => ((skillName: string) => string | null) & {
    readonly attempts?: (skillName: string) => readonly SkillResolutionAttempt[];
  };
  /**
   * Observability for the best-effort lock release on compose failure (W-N2):
   * a release failure is reported here instead of vanishing silently. The
   * ORIGINAL compose error is still the one rethrown to the caller.
   */
  readonly onLockReleaseError?: (error: unknown) => void;
  /** The default model reference for phases that don't name one (EF-15). */
  readonly defaultModel?: string;
  /** Injectable only to make worktree guardrails deterministic in integration tests. */
  readonly captureFingerprint?: (projectRoot: string) => Promise<WorktreeFingerprint>;
}

/**
 * Builds the eight SDD tools, each closing over the injected dependencies.
 * `projectRoot` arrives per-call from the tool's `context.directory` so each
 * invocation is namespaced by the session's actual project, not a startup-time
 * capture.
 */
export function buildSddTools(deps: SddToolsDeps): Record<string, ToolDefinition> {
  const defaultModel = deps.defaultModel ?? "claude-3-5-sonnet";
  const captureFingerprint = deps.captureFingerprint ?? captureWorktreeFingerprint;
  const ownerTokens = new Map<string, string>();
  const projectInitLockChangeName = "__sdd_project_init_lock__";
  const artifactPhaseByName = {
    explore: "sdd-explore",
    proposal: "sdd-propose",
    spec: "sdd-spec",
    design: "sdd-design",
    tasks: "sdd-tasks",
    apply: "sdd-apply",
    verifyReport: "sdd-verify",
    archiveReport: "sdd-archive",
  } as const;
  const artifacts = Object.keys(artifactPhaseByName) as Array<keyof typeof artifactPhaseByName>;

  const resolveProjectHash = (projectRoot: string): string =>
    canonicalizeProjectRoot(projectRoot).projectRootHash;

  const stateIdentity = (projectRoot: string, changeName: string): string =>
    `${resolveProjectHash(projectRoot)}/${changeName}`;

  const assertPublicChangeName = (changeName: string): void => {
    if (changeName.startsWith("__sdd_")) {
      throw new Error(`SDD_CHANGE_NAME_RESERVED: '${changeName}' is reserved for internal SDD state.`);
    }
  };

  const ensureChangeState = async (projectRoot: string, changeName: string): Promise<SddChangeState> => {
    const existing = await deps.changeStateStore.readChangeState(projectRoot, changeName);
    if (existing !== null) return existing;
    return deps.changeStateStore.writeChangeState({ projectRoot, changeName, artifactIndex: [] }, 0);
  };

  const loadArtifactContents = async (projectRootHash: string, changeName: string) => {
    const reads = await Promise.all(
      artifacts.map(async (artifact) => [artifact, await deps.store.readArtifact(changeArtifactKey(projectRootHash, changeName, artifact))] as const),
    );
    return Object.fromEntries(reads) as Record<(typeof artifacts)[number], string | null>;
  };

  const loadStatus = async (projectRoot: string, changeName: string, allIds: readonly string[]) => {
    const projectRootHash = resolveProjectHash(projectRoot);
    const [state, data, artifactContents] = await Promise.all([
      deps.changeStateStore.readChangeState(projectRoot, changeName),
      readCheckpointData(deps.store, projectRootHash, changeName),
      loadArtifactContents(projectRootHash, changeName),
    ]);
    const blockedReasons = state?.lock === undefined ? [] : [`Phase '${state.lock.phase}' is currently in flight.`];
    return assembleStatus({
      changeName,
      projectRoot,
      artifactContents,
      allIds,
      checkpoints: data.checkpoints,
      inFlightPhase: state?.lock?.phase ?? null,
      blockedReasons,
      verifyReportHasUnresolvedCritical: hasUnresolvedCriticalFinding(artifactContents.verifyReport),
      ...(data.blockedOn !== undefined ? { blockedOn: data.blockedOn } : {}),
    });
  };

  const sddStatus: ToolDefinition = tool({
    description:
      "Compute the unified SDD status for a named change: artifacts present/missing, dependency-graph readiness per phase, blockedReasons, nextRecommended, and checkpoint progress. Read-only.",
    args: {
      projectRoot: tool.schema.string().describe("Absolute path to the project root."),
      changeName: tool.schema.string().optional().describe("Optional change slug to report a selected change."),
      allIds: tool.schema.array(tool.schema.string()).optional().describe("All scenario ids for the change (from tasks.md)."),
    },
    async execute(args) {
      if (args.changeName !== undefined) assertPublicChangeName(args.changeName);
      const projectRootHash = resolveProjectHash(args.projectRoot);
      if (args.changeName === undefined) {
        const [initialized, states] = await Promise.all([
          isProjectInitialized(deps.store, projectRootHash),
          deps.changeStateStore.listChangeStates(args.projectRoot),
        ]);
        const changes = await Promise.all(states
          .filter((state) => state.changeName !== projectInitLockChangeName)
          .map(async (state) => {
          const status = await loadStatus(args.projectRoot, state.changeName, []);
          return { changeName: state.changeName, nextRecommended: status.nextRecommended };
          }));
        return { output: JSON.stringify(assembleDiscoveryStatus(args.projectRoot, initialized, changes), null, 2) };
      }
      const status = await loadStatus(args.projectRoot, args.changeName, args.allIds ?? []);
      return { output: JSON.stringify(status, null, 2) };
    },
  });

const sddComposePhasePrompt: ToolDefinition = tool({
    description:
      "Compose the prompt for a single SDD phase, acquiring the dispatch lock. Returns the subagentType grammar string and the composed prompt body.",
    args: {
      phase: tool.schema.string().describe("The phase name, e.g. sdd-explore, sdd-apply, sdd-verify."),
      projectRoot: tool.schema.string().describe("Absolute path to the project root."),
      changeName: tool.schema.string().describe("The change slug to compose."),
      modelReference: tool.schema.string().describe("Canonical model reference (provider/model)."),
    },
    async execute(args) {
      assertPublicChangeName(args.changeName);
      if (!Object.hasOwn(PHASE_MUTATING_TABLE, args.phase)) {
        throw new Error(`SDD_PHASE_INVALID: '${args.phase}' is not a supported SDD phase.`);
      }
      let projectInitLock: SddChangeState | null = null;
      let projectInitOwnerToken: string | null = null;
      const projectInitOwnerKey = stateIdentity(args.projectRoot, projectInitLockChangeName);
      let sentinelReclaimed = false;
      if (args.phase === "sdd-init") {
        // Final-review finding #1 — the project-global init sentinel is
        // BOUND to the change that acquired it. A different change trying
        // to acquire, reclaim, or recover a sentinel currently held by
        // another change receives `SddChangeStateSentinelBindingConflictError`
        // at the port layer. We pass `args.changeName` as `boundChangeName`
        // on every acquire/reclaim so the binding is set on first acquire
        // and verified on every subsequent reclaim.
        projectInitOwnerToken = ownerTokens.get(projectInitOwnerKey) ?? randomUUID();
        try {
          const projectInitState = await ensureChangeState(args.projectRoot, projectInitLockChangeName);
          projectInitLock = await deps.changeStateStore.acquireChangeStateLock(
            args.projectRoot,
            projectInitLockChangeName,
            "sdd-init",
            projectInitOwnerToken,
            projectInitState.version,
            args.changeName,
          );
        } catch (error) {
          if (error instanceof SddChangeStateLockConflictError) {
            const latest = await deps.changeStateStore.readChangeState(args.projectRoot, projectInitLockChangeName);
            if (latest?.lock?.phase === "sdd-init" && latest.boundChangeName === args.changeName) {
              projectInitOwnerToken = randomUUID();
              projectInitLock = await deps.changeStateStore.reclaimChangeStateLock(
                args.projectRoot,
                projectInitLockChangeName,
                "sdd-init",
                projectInitOwnerToken,
                latest.version,
                args.changeName,
              );
              sentinelReclaimed = true;
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
        ownerTokens.set(projectInitOwnerKey, projectInitOwnerToken);
      }
      const ownerKey = stateIdentity(args.projectRoot, args.changeName);
      let ownerToken = ownerTokens.get(ownerKey) ?? randomUUID();
      let lockedState: SddChangeState;
      let reclaimed = false;
      try {
        const state = await ensureChangeState(args.projectRoot, args.changeName);
        lockedState = await deps.changeStateStore.acquireChangeStateLock(
          args.projectRoot,
          args.changeName,
          args.phase,
          ownerToken,
          state.version,
        );
      } catch (error) {
// SPEC DL-6 — passive same-phase reclaim. A freshly constructed tool
      // surface composing the SAME phase as a stuck lock atomically replaces
      // the prior owner token (the previous process is presumed dead) instead
      // of refusing. A DIFFERENT phase still surfaces the typed conflict so
      // unrelated runners remain blocked. Reviewer finding #1 extends this
      // to the project-global init sentinel: an sdd-init compose transparently
      // reclaims the sentinel if it is held by sdd-init, and the response
      // carries `sentinelReclaimed: true` so the operator can observe it.
      if (error instanceof SddChangeStateLockConflictError) {
        const latest = await deps.changeStateStore.readChangeState(args.projectRoot, args.changeName);
          if (latest?.lock?.phase === args.phase) {
            ownerToken = randomUUID();
            lockedState = await deps.changeStateStore.reclaimChangeStateLock(
              args.projectRoot,
              args.changeName,
              args.phase,
              ownerToken,
              latest.version,
            );
            reclaimed = true;
          } else {
            if (projectInitLock !== null && projectInitOwnerToken !== null) {
              await deps.changeStateStore.releaseChangeStateLock(
                args.projectRoot,
                projectInitLockChangeName,
                projectInitOwnerToken,
                projectInitLock.version,
              );
              ownerTokens.delete(projectInitOwnerKey);
            }
            throw error;
          }
        } else {
          if (projectInitLock !== null && projectInitOwnerToken !== null) {
            await deps.changeStateStore.releaseChangeStateLock(
              args.projectRoot,
              projectInitLockChangeName,
              projectInitOwnerToken,
              projectInitLock.version,
            );
            ownerTokens.delete(projectInitOwnerKey);
          }
          throw error;
        }
      }
      ownerTokens.set(ownerKey, ownerToken);
      let baseline: WorktreeFingerprint;
      if (reclaimed && lockedState.baselineFingerprint !== undefined) {
        // SPEC DL-6 — passive same-phase reclaim. The original baseline was
        // captured by the first acquire of THIS phase; reusing it keeps the
        // worktree-fingerprint delta meaningful across the crash boundary so
        // unexpected writes from the crashed dispatch are still reported.
        baseline = JSON.parse(lockedState.baselineFingerprint) as WorktreeFingerprint;
      } else {
        baseline = await captureFingerprint(args.projectRoot);
      }
      const preparedState = await deps.changeStateStore.updateOwnedChangeState({
        projectRoot: lockedState.projectRoot,
        changeName: lockedState.changeName,
        artifactIndex: lockedState.artifactIndex,
        baselineFingerprint: JSON.stringify(baseline),
      }, ownerToken, lockedState.version);
      const projectConfig = await deps.store.readCheckpoint(initConfigKey(resolveProjectHash(args.projectRoot)));
      const upstreamArtifacts = Object.fromEntries(
        await Promise.all(preparedState.artifactIndex.map(async (artifact) => [
          artifact,
          await deps.store.readArtifact(changeArtifactKey(resolveProjectHash(args.projectRoot), args.changeName, artifact)),
        ] as const)),
      ) as Record<string, string | null>;
      let result: ReturnType<typeof composePhasePrompt>;
      // W-N1 — the resolver is created HERE, per call, from args.projectRoot,
      // so resolution always follows the session's actual project root and
      // never a startup-time capture.
      const skillResolver = deps.createSkillResolver?.(args.projectRoot);
      try {
        result = composePhasePrompt({
          phase: args.phase,
          modelReference: args.modelReference,
          upstreamArtifacts: Object.fromEntries(
            Object.entries(upstreamArtifacts).filter((entry): entry is [string, string] => entry[1] !== null),
          ),
          projectConfig: (projectConfig?.content ?? null) as Exclude<
            Parameters<typeof composePhasePrompt>[0]["projectConfig"],
            undefined
          >,
          // Spread conditionally: under exactOptionalPropertyTypes an explicit
          // `undefined` is not assignable to an optional property.
          ...(skillResolver !== undefined ? { skillResolver } : {}),
          currentInFlightPhase: null,
        });
      } catch (composeError) {
        // C-N1 remediation. The durable change-state lock was already
        // acquired above (and the baseline fingerprint already persisted
        // via updateOwnedChangeState) BEFORE this call. `composePhasePrompt`
        // can still throw (UnresolvableSkillError, PromptBudgetExceededError)
        // — without releasing here, that throw would leave the lock durably
        // held: same-phase retries would only keep re-acquiring their own
        // stuck phase via passive reclaim, and any OTHER phase would be
        // blocked until an operator ran sdd_recover_phase_lock. Release is
        // best-effort: if it itself fails (e.g. a concurrent reclaim already
        // replaced this token), the lock is no longer ours to leak either
        // way, and the caller needs to see the ORIGINAL compose error, not a
        // secondary release failure.
        try {
          await deps.changeStateStore.releaseChangeStateLock(
            args.projectRoot,
            args.changeName,
            ownerToken,
            preparedState.version,
          );
          ownerTokens.delete(ownerKey);
        } catch (releaseError) {
          // best-effort — see comment above — but no longer silent (W-N2).
          deps.onLockReleaseError?.(releaseError);
        }
        if (projectInitLock !== null && projectInitOwnerToken !== null) {
          try {
            await deps.changeStateStore.releaseChangeStateLock(
              args.projectRoot,
              projectInitLockChangeName,
              projectInitOwnerToken,
              projectInitLock.version,
            );
            ownerTokens.delete(projectInitOwnerKey);
          } catch (releaseError) {
            // best-effort — see comment above — but no longer silent (W-N2).
            deps.onLockReleaseError?.(releaseError);
          }
        }
        // Diagnosability — the application layer already attaches the
        // resolver's attempts, so this fold only covers the case where a
        // resolver exposes diagnostics the composition layer could not reach
        // (e.g. a resolver injected without `attempts` at compose time).
        if (composeError instanceof UnresolvableSkillError && composeError.attempts.length === 0) {
          const attempts = skillResolver?.attempts?.(composeError.skillName);
          if (attempts !== undefined && attempts.length > 0) {
            throw new UnresolvableSkillError(composeError.skillName, attempts);
          }
        }
        throw composeError;
      }
      return {
        output: JSON.stringify(
          {
            subagentType: result.subagentType,
            prompt: result.prompt,
            inFlightPhase: result.inFlightPhase,
            mutating: result.mutating,
            worktreeFingerprint: baseline,
            ...(reclaimed ? { lockReclaimed: true } : {}),
            ...(sentinelReclaimed ? { sentinelReclaimed: true } : {}),
          },
          null,
          2,
        ),
      };
    },
  });

  const sddSaveArtifact: ToolDefinition = tool({
    description:
      "Persist an SDD artifact with write-then-read-back durability (SS-9) and release the dispatch lock. Returns ok:true/false and inFlightPhase:null.",
    args: {
      projectRoot: tool.schema.string().describe("Absolute path to the project root."),
      changeName: tool.schema.string().describe("The change slug."),
      artifact: tool.schema.string().describe("Artifact name (explore, proposal, spec, design, tasks, apply, verifyReport, archiveReport)."),
      content: tool.schema.string().describe("The artifact content."),
    },
async execute(args) {
assertPublicChangeName(args.changeName);
      const ownerKey = stateIdentity(args.projectRoot, args.changeName);
      const ownerToken = ownerTokens.get(ownerKey);
      if (ownerToken === undefined) {
        // No in-memory token at all — fail closed before reading durable
        // state so we surface the same error shape regardless of whether a
        // lock is durably held.
        throw new SddChangeStateLockConflictError(undefined, "save");
      }
      const expectedPhase = artifactPhaseByName[args.artifact as keyof typeof artifactPhaseByName];
      if (expectedPhase === undefined) {
        throw new Error(`SDD_ARTIFACT_INVALID: '${args.artifact}' is not a writable SDD artifact.`);
      }
      // Pre-flight read: verify the durable owner AND gather the
      // baseline fingerprint + lock phase for the unexpected-writes
      // check. This read is NOT atomic with the eventual write; the
      // TOCTOU window for the ARTIFACT WRITE is closed below by
      // `persistArtifactWithOwnership` (final-review finding #3).
      const verified = await deps.changeStateStore.verifyOwnedLock(
        args.projectRoot,
        args.changeName,
        ownerToken,
      );
      if (verified.lock === undefined || verified.lock.phase !== expectedPhase) {
        throw new Error(
          `SDD_ARTIFACT_PHASE_MISMATCH: '${args.artifact}' belongs to '${expectedPhase}', not held phase '${verified.lock?.phase ?? "<none>"}'.`,
        );
      }
      let baseline: WorktreeFingerprint;
      let current: WorktreeFingerprint;
      try {
        if (verified.baselineFingerprint === undefined) throw new Error("missing durable baseline fingerprint");
        baseline = JSON.parse(verified.baselineFingerprint) as WorktreeFingerprint;
        current = await captureFingerprint(args.projectRoot);
      } catch {
        return { output: JSON.stringify({ ok: false, inFlightPhase: verified.lock!.phase, unexpectedWrites: true }, null, 2) };
      }
      if (
        baseline.gitProbeFailed ||
        current.gitProbeFailed ||
        compareWorktreeFingerprints(baseline, current, isPhaseMutating(verified.lock!.phase)).unexpectedWrites
      ) {
        return { output: JSON.stringify({ ok: false, inFlightPhase: verified.lock!.phase, unexpectedWrites: true }, null, 2) };
      }
      // Final-review finding #3 — atomic ownership + artifact persistence.
      // Wraps verify + write + readback + state update + lock release in a
      // single SQLite transaction. A concurrent reclaim that lands
      // between the pre-flight read above and the atomic commit advances
      // the durable version, so the conditional write fails and the
      // transaction rolls back the artifact insert. There is no path
      // that persists the artifact without first proving ownership holds
      // at commit time.
      //
      // The atomic operation lives on the ARTIFACT-store port so a test
      // fixture like `ArtifactFaultStore` can intercept the entire
      // atomic operation and exercise the failure paths (write-failure,
      // readback-failure) at the right seam.
      const projectRootHash = resolveProjectHash(args.projectRoot);
      const artifactKey = changeArtifactKey(projectRootHash, args.changeName, args.artifact);
      try {
        await deps.store.persistArtifactWithOwnership(
          args.projectRoot,
          args.changeName,
          ownerToken,
          artifactKey,
          args.content,
          args.artifact,
        );
      } catch (error) {
        // Lock / version conflict raised as the typed conflict so the
        // caller can surface it. Other failures (read-back mismatch,
        // unexpected-writes pre-flight, etc.) surface as `{ ok: false }`
        // — the transaction has rolled back, no artifact is persisted,
        // and the lock is RETAINED (the atomic operation releases only on
        // successful commit).
        if (error instanceof SddChangeStateLockConflictError) {
          throw error;
        }
        if (error instanceof SddChangeStateVersionConflictError) {
          throw new SddChangeStateLockConflictError(undefined, expectedPhase);
        }
        return { output: JSON.stringify({ ok: false, inFlightPhase: expectedPhase }, null, 2) };
      }
      ownerTokens.delete(ownerKey);
      return { output: JSON.stringify({ ok: true, inFlightPhase: null, artifact: args.artifact }, null, 2) };
    },
  });

  // Named `...Tool` so it does not shadow the imported `sddParseRequest` use
  // case that its own `execute` calls.
  const sddParseRequestTool: ToolDefinition = tool({
    description:
      "Parse a free-text request for explicit SDD mention, task description, and model phrase. Returns { taskDescription, modelPhrase, explicitSddMention }.",
    args: {
      text: tool.schema.string().describe("The raw request text."),
    },
    async execute(args) {
      const parsed = await sddParseRequest(args.text);
      return { output: JSON.stringify(parsed, null, 2) };
    },
  });

  const sddInitQuestions: ToolDefinition = tool({
    description:
      "Run project-fact detection and return only the residual questions the user must answer (never asks about storage backend). IR-4/IR-5.",
    args: {
      files: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .describe("Map of filename → file content for detection (package.json, tsconfig.json, etc.)."),
    },
    async execute(args) {
      const detection = detectProjectFacts(args.files as Record<string, string>);
      const result = getInitQuestions(detection);
      return { output: JSON.stringify({ detection, questions: result.questions }, null, 2) };
    },
  });

  const sddSaveConfig: ToolDefinition = tool({
    description:
      "Merge detected facts with user answers (user answers win) and persist the project config at sdd-init/{projectRootHash}. IR-6/IR-12.",
    args: {
      projectRoot: tool.schema.string().describe("Absolute path to the project root."),
      changeName: tool.schema.string().describe("The change whose held sdd-init lock authorizes this config save."),
      detection: tool.schema.unknown().describe("The InitDetectionResult from sdd_init_questions."),
      userAnswers: tool.schema
        .record(tool.schema.string(), tool.schema.unknown())
        .optional()
        .describe("User answers (win over detection on conflict)."),
    },
async execute(args) {
      assertPublicChangeName(args.changeName);
      const ownerKey = stateIdentity(args.projectRoot, args.changeName);
      const ownerToken = ownerTokens.get(ownerKey);
      const projectInitOwnerKey = stateIdentity(args.projectRoot, projectInitLockChangeName);
      const projectInitOwnerToken = ownerTokens.get(projectInitOwnerKey);
      if (ownerToken === undefined || projectInitOwnerToken === undefined) {
        // No in-memory token for either lock — fail closed before reading
        // durable state so we surface the same error shape regardless of
        // whether a lock is durably held.
        throw new SddChangeStateLockConflictError(undefined, "sdd-init");
      }
      // Final-review finding #2 — atomically validate BOTH the user
      // change and the bound project-init sentinel BEFORE any config
      // checkpoint write. A stale init runner whose in-memory token map
      // is out of date is refused with the typed conflict (and the
      // sentinel binding mismatch surfaces as
      // `SddChangeStateSentinelBindingConflictError`) before
      // `saveInitConfig` can land any persisted config mutation.
      let validated;
      try {
        validated = await deps.changeStateStore.verifyInitRoundOwnership(
          args.projectRoot,
          args.changeName,
          projectInitLockChangeName,
          ownerToken,
          projectInitOwnerToken,
        );
      } catch (error) {
        throw error;
      }
      const state = validated.userState;
      if (state.lock === undefined || state.lock.phase !== "sdd-init") {
        throw new SddChangeStateLockConflictError(
          state.lock === undefined ? undefined : { phase: state.lock.phase },
          "sdd-init",
        );
      }
      let baseline: WorktreeFingerprint;
      let current: WorktreeFingerprint;
      try {
        if (state.baselineFingerprint === undefined) throw new Error("missing durable baseline fingerprint");
        baseline = JSON.parse(state.baselineFingerprint) as WorktreeFingerprint;
        current = await captureFingerprint(args.projectRoot);
      } catch {
        return { output: JSON.stringify({ ok: false, inFlightPhase: state.lock!.phase, unexpectedWrites: true }, null, 2) };
      }
      if (
        baseline.gitProbeFailed ||
        current.gitProbeFailed ||
        compareWorktreeFingerprints(baseline, current, isPhaseMutating(state.lock!.phase)).unexpectedWrites
      ) {
        return { output: JSON.stringify({ ok: false, inFlightPhase: state.lock!.phase, unexpectedWrites: true }, null, 2) };
      }
      const projectRootHash = resolveProjectHash(args.projectRoot);
      const saved = await saveInitConfig(
        deps.store,
        projectRootHash,
        args.detection as Parameters<typeof saveInitConfig>[2],
        (args.userAnswers ?? {}) as Parameters<typeof saveInitConfig>[3],
      );
      await deps.changeStateStore.releaseChangeStateLock(
        args.projectRoot,
        args.changeName,
        ownerToken,
        validated.userState.version,
      );
      await deps.changeStateStore.releaseChangeStateLock(
        args.projectRoot,
        projectInitLockChangeName,
        projectInitOwnerToken,
        validated.sentinelState.version,
      );
      ownerTokens.delete(ownerKey);
      ownerTokens.delete(projectInitOwnerKey);
      return { output: JSON.stringify({ ...saved, inFlightPhase: null }, null, 2) };
    },
  });

  const sddCheckpoint: ToolDefinition = tool({
    description:
      "Checkpoint operations for mid-phase resumability. Action 'declare' sets totalIds; 'complete' records a done id; 'block' pauses for user input; 'resume' continues with an answer.",
    args: {
      projectRoot: tool.schema.string().describe("Absolute path to the project root."),
      changeName: tool.schema.string().describe("The change slug."),
      phase: tool.schema.enum(["apply", "verify"]).describe("The mutating phase."),
      action: tool.schema
        .enum(["declare", "complete", "block", "resume"])
        .describe("The checkpoint operation."),
      totalIds: tool.schema.array(tool.schema.string()).optional().describe("For 'declare': all scenario ids in the batch."),
      batchId: tool.schema.string().optional().describe("For 'declare': optional batch id."),
      completedId: tool.schema.string().optional().describe("For 'complete': the id just completed."),
      note: tool.schema.string().optional().describe("For 'complete': optional executor note to distill."),
      question: tool.schema.string().optional().describe("For 'block': the blocking question."),
      progressSummary: tool.schema.string().optional().describe("For 'block': progress summary for resume."),
      blockedItemId: tool.schema.string().optional().describe("For 'block': the item id that was mid-work."),
      answer: tool.schema.string().optional().describe("For 'resume': the user's answer."),
    },
    async execute(args) {
      assertPublicChangeName(args.changeName);
      const projectRootHash = resolveProjectHash(args.projectRoot);
      const base = { store: deps.store, projectRootHash, changeName: args.changeName, phase: args.phase };

      switch (args.action) {
        case "declare": {
          const result = await declareBatch({
            ...base,
            totalIds: args.totalIds ?? [],
            ...(args.batchId !== undefined ? { batchId: args.batchId } : {}),
          });
          return { output: JSON.stringify(result, null, 2) };
        }
        case "complete": {
          const result = await recordCompletion({
            ...base,
            completedId: args.completedId ?? "",
            ...(args.note !== undefined ? { note: args.note } : {}),
          });
          return { output: JSON.stringify(result, null, 2) };
        }
        case "block": {
          const result = await blockMidBatch({
            ...base,
            question: args.question ?? "",
            progressSummary: args.progressSummary ?? "",
            ...(args.blockedItemId !== undefined ? { blockedItemId: args.blockedItemId } : {}),
          });
          return { output: JSON.stringify(result, null, 2) };
        }
        case "resume": {
          const result = await resumeBatch({ ...base, answer: args.answer ?? "" });
          return { output: JSON.stringify(result, null, 2) };
        }
        default:
          return { output: JSON.stringify({ error: `Unknown checkpoint action: ${String(args.action)}` }) };
      }
    },
  });

  // SPEC DL-6 — the EIGHTH SDD MCP tool. Explicit deliberate clear/release of
  // a stuck dispatch lock. NEVER invoked automatically: it requires an
  // explicit `reason` from the caller, returns a server-stamped audit
  // record, and clears the durable lock so any phase (including the same
  // one) can re-acquire.
  //
  // When the cleared lock was held by `sdd-init`, the recovery also clears
  // the project-global `__sdd_project_init_lock__` sentinel (reviewer
  // finding #1) so a subsequent init dispatch can proceed. The sentinel
  // name is resolved internally; the public surface never accepts or
  // surfaces a reserved name. The sentinel's audit record carries a
  // cross-reference to the originating user change so downstream review can
  // attribute the clear.
  const sddRecoverPhaseLock: ToolDefinition = tool({
    description:
      "Explicitly clear a stuck dispatch lock with audit metadata. NEVER automatic. Caller supplies `reason`; the durable lock is removed and the audit record is returned so downstream review can attribute the clear.",
    args: {
      projectRoot: tool.schema.string().describe("Absolute path to the project root."),
      changeName: tool.schema.string().describe("The change slug whose lock is being recovered."),
      reason: tool.schema.string().min(1).describe("Caller-supplied reason recorded verbatim in the audit. Must be non-empty."),
    },
    async execute(args) {
      assertPublicChangeName(args.changeName);
      const ownerKey = stateIdentity(args.projectRoot, args.changeName);
      const state = await deps.changeStateStore.readChangeState(args.projectRoot, args.changeName);
      const currentVersion = state?.version ?? 0;
      // Final-review finding #1 — pass `args.changeName` as the expected
      // bound change name so the recovery of a sentinel bound to a
      // different change is refused with a typed conflict.
      const recovery = await deps.changeStateStore.recoverChangeStateLock(
        args.projectRoot,
        args.changeName,
        currentVersion,
        args.reason,
        args.changeName,
      );
      // The held owner token (if any) is dropped because the lock is gone —
      // any subsequent compose will re-acquire with a fresh token via the
      // reclaim-or-acquire path in sdd_compose_phase_prompt.
      ownerTokens.delete(ownerKey);

      // Final-review finding #1 — recovery of an init change MUST also
      // clear the project-global init sentinel, otherwise the sentinel
      // remains held and a subsequent init dispatch cannot proceed. The
      // sentinel is identified by the in-source constant
      // `projectInitLockChangeName`, never via any user-supplied change
      // name (the public surface rejects reserved names before reaching
      // this branch). The sentinel recovery also passes
      // `args.changeName` as `expectedBoundChangeName` so a sentinel
      // currently bound to a DIFFERENT live init is refused with
      // `SddChangeStateSentinelBindingConflictError` — the explicit
      // clear/recovery operation MUST NOT clobber a sentinel held by a
      // different change.
      let sentinelAudit: import("../ports/sdd-artifact-store.port.js").SddChangeStateLockRecovery | null = null;
      if (recovery.audit.priorLock?.phase === "sdd-init") {
        const sentinelState = await deps.changeStateStore.readChangeState(args.projectRoot, projectInitLockChangeName);
        if (sentinelState?.lock !== undefined) {
          const sentinelRecovery = await deps.changeStateStore.recoverChangeStateLock(
            args.projectRoot,
            projectInitLockChangeName,
            sentinelState.version,
            `${args.reason} [sentinel-recovery from ${args.changeName}]`,
            args.changeName,
          );
          sentinelAudit = sentinelRecovery.audit;
          ownerTokens.delete(stateIdentity(args.projectRoot, projectInitLockChangeName));
        }
      }

      return {
        output: JSON.stringify(
          {
            ok: true,
            inFlightPhase: null,
            audit: recovery.audit,
            ...(sentinelAudit !== null ? { sentinelAudit } : {}),
          },
          null,
          2,
        ),
      };
    },
  });

  return {
    sdd_status: sddStatus,
    sdd_compose_phase_prompt: sddComposePhasePrompt,
    sdd_save_artifact: sddSaveArtifact,
    sdd_parse_request: sddParseRequestTool,
    sdd_init_questions: sddInitQuestions,
    sdd_save_config: sddSaveConfig,
    sdd_checkpoint: sddCheckpoint,
    sdd_recover_phase_lock: sddRecoverPhaseLock,
  };
}
