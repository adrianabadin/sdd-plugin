# SDD Phase Agents — Verify Report

**Change**: `sdd-phase-agents`
**Branch**: `feat/sdd-phase-agents`
**Scope**: all 131 tasks / 14 suites (WU1–WU12), full independent pass, fresh context
**Executor**: `sdd-verify` (read-only; no source, test, or git state was modified)

**Artifacts verified against**
- Spec — `docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md`
- Tasks — `docs/superpowers/specs/2026-08-02-sdd-phase-agents-TASKS.md`
- Design — `docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md` (revision 6)

**Engram**: findings `sdd/sdd-phase-agents/verify-report` (#2416) · remediation brief `sdd/sdd-phase-agents/verify-remediation-brief` (#2418)

---

## Verdict

> **`status: blocked` — NOT archivable.**
> **4 CRITICAL · 13 WARNING · 5 SUGGESTION.** Recommended next phase: `sdd-apply`.

Every suite is green, the build is green and strict typecheck is green. **That is the problem**: all four CRITICAL findings are false greens — tests that pass against an implementation that does not do what the scenario says.

### Context that shaped where this pass looked

A prior verification covered only WU1–WU5 and failed with 3 CRITICAL, all false greens, since remediated. It also surfaced that **WU6–WU12 were implemented outside the chain and never passed any gate**: their six suites were not registered in `tsconfig.test.json`, so they ran under `tsx` (which does not typecheck) and had never compiled in strict mode. They are now registered and strict-clean. This pass therefore weighted WU6–WU12 heaviest — and that is where three of the four CRITICALs are.

---

## Real execution

All commands run by the verifier; no report was taken on trust.

| Command | Result |
|---|---|
| `npx tsx tests/sdd-*.test.ts` (14 suites) | **14/14 pass** — 132 named cases |
| `npm run build` (`tsc && tsup`) | **green** |
| `npm run test:typecheck:strict` | **green** — all 14 SDD suites registered in `tsconfig.test.json` |
| `npx tsx tests/model-route-disk-generator.test.ts` (MR-1) | **green** — `HARD_MAX_ROUTES = 24` at `disk-agent-generator.ts:74` |

### Per-suite case counts

| Suite | Cases | Suite | Cases |
|---|---|---|---|
| `sdd-project-identity` | 5 | `sdd-init-round` | 12 |
| `sdd-keys` | 2 | `sdd-prompt-composition` | 9 |
| `sdd-artifact-store` | 3 | `sdd-worktree-fingerprint` | 10 |
| `sdd-status-schema` | 5 | `sdd-checkpoint-use-case` | 17 |
| `sdd-discovery-status` | 2 | `sdd-entry-flow` | 21 |
| `sdd-routing` | 18 | `sdd-executor-contract` | 16 |
| `sdd-dispatch-lock` | 6 | `sdd-semantic-gateway` | 6 |

### Test-case / task arithmetic — clean

131 tasks. 130 distinct scenario IDs carry an asserting test; MR-1 is covered by the disk-generator suite. 132 named cases = 130 IDs + a second PI-4 case (shape and round-trip split) + one unnamed `saveArtifact` integration case. **No deficit.** The prior pass caught its first CRITICAL precisely on this arithmetic (44 cases for 46 tasks); it does not recur.

### Known false positives — excluded by instruction, confirmed as stated

- `npm run test:model-routes` fails in `model-route-cli.test.ts` for a pre-existing, unrelated reason: 13 real `sdd-mr-v1-*.md` files in `.opencode/agents/` from prior use, and that test assumes an empty directory.
- `HARD_MAX_ROUTES` 16 to 24 in `disk-agent-generator.ts` is prior work, already green, out of scope. Re-confirmed green anyway via MR-1.

---

## CRITICAL

### C-1 · CP-16 / CP-17 — optimistic concurrency does not exist

**File**: `src/application/sdd/checkpoint.ts:111-143`
**Scenario**: `sdd-checkpoint` → "checkpoint writes use optimistic concurrency" (both scenarios)
**Design**: §9.12, design doc lines 971–977

The design is literal:

> Read the current record **with its version**, apply the change, write **conditional on the version being unchanged**; on conflict, re-read and retry once; on a second conflict, fail loud rather than silently losing an update.

`writeCheckpointsDurable` performs a plain read-modify-write. A grep for `version`, `etag`, `ifMatch`, `conditional` and `compareAndSwap` across all of `src/**/sdd` plus `src/ports/sdd-artifact-store.port.ts` returns **zero hits**. There is no version field anywhere in the data path.

The retry loop catches **exceptions thrown by the store**, not concurrent modification. The test confirms the gap rather than closing it — it sets `store.failOnAttempts = [1]`, which makes `writeCheckpoint` throw an `Error`. That proves "retry when storage errors", a different scenario. The spec says *GIVEN the stored checkpoint record changed between read and write* — a condition this implementation is structurally unable to detect. A concurrent writer's update is silently overwritten, which is exactly what CP-17 forbids.

### C-2 · EF-4 — there is no timeout at all

**File**: `src/application/sdd/entry-flow.ts:29-52`
**Scenario**: `sdd-entry-flow` → "a mid-run gateway timeout fails loud with a human fallback"
**Design**: line 91 — the gateway is used *with an explicit timeout*

`ParseRequestOptions.timeoutMs` is declared at line 34 and **never read**. `sddParseRequest` calls neither `callSemanticGateway` nor `withTimeout`; it awaits `options.service.parse(text)` unbounded and re-wraps whatever is thrown as `GatewayTimeoutError`. A real hang hangs forever. The WU10 to WU5 edge of the work-unit graph is not realized in code.

The test is green by construction: the injected service's `parse()` throws `GatewayTimeoutError` immediately, so the timeout path is never exercised. And `assert.equal(secondaryAttempted, false)` observes a `fallbackService` that the implementation **never references** — it would pass against any implementation, including an empty one.

### C-3 · SS-10 — read-back never runs on a real checkpoint path

**File**: `src/application/sdd/checkpoint.ts:57-65`, `:277`, `:316`
**Scenario**: `sdd-status-store` → "checkpoint writes are read back too"

`saveCheckpoint` is the only function that verifies read-back, and only the test calls it. The four production paths — `declareBatch`, `recordCompletion`, `blockMidBatch`, `resumeBatch` — all write without re-reading. `blockMidBatch:277` and `resumeBatch:316` bypass the durable path entirely with a raw `store.writeCheckpoint`. The durability guarantee is proven against dead code.

### C-4 · RT-13 — the remediation closed only one of two paths

**File**: `src/application/sdd/compute-status.ts:98-120`
**Scenario**: `sdd-routing` → the invariant behind "an attempt-cap block routes to resolve-blockers"

Probe run against `assembleStatus` with `verifyReportHasUnresolvedCritical: true`:

    { "status": "ok", "next": "resolve-blockers", "blockedReasons": [], "archive": "blocked" }

The orchestrator is told to resolve blockers, told there are none, and told the state is fine. The unresolved CRITICAL never pushes a reason into `blockedReasons`, so `computeStatusFlag` cannot see it. This is the same defect class as the original RT-13 CRITICAL — `status` and `nextRecommended` disagreeing — reached by a different input.

---

## Status of the three previously-remediated CRITICALs

Verified by mechanism, not by "the test now passes".

| ID | Verdict | Evidence |
|---|---|---|
| **RT-13** | **Genuinely closed** | `AssembleStatusInput` no longer carries `nextRecommended`. `assembleStatus` derives the attempt-cap `blockedReasons` itself (`compute-status.ts:98-114`) and feeds that same array to `computeNextRecommended` at `:120`. The test enters through `assembleStatus`, not through two functions fed a hand-built array. |
| **PI-4** | **Genuinely closed** | Real round-trip through the port: `registerProjectRoot` writes via `store.writeArtifact`, `readProjectRecord` reads via `store.readArtifact`, under key `sdd-project/{hash}`. Not a return-value shape assertion. *Caveat*: no production code calls it — test-only, like the rest of the modules. |
| **RT-17 / RT-18** | **Discriminate** | RT-17 asserts equality with `complete` **and** `notEqual` against all eight phase names — it fails if the implementation returns a phase. RT-18 feeds a deliberately inconsistent all-`blocked` dependency set and asserts `resolve-blockers`, documenting why `computeDependencies` cannot itself produce that shape. |

---

## WARNING

The three carried over from the prior pass are **all still open**, as suspected.

| ID | File | Finding |
|---|---|---|
| **SG-4** | `semantic-gateway.ts:107-109` | The "never return empty as valid" branch is untested. `SemanticGatewayTruncationError` has 3 grep hits, all in the source — **no test ever constructs it**. The test only exercises truncated-then-good-retry. Replacing the branch with a bare return of the retried content stays green. |
| **SG-5** | `semantic-gateway.ts:50-60`, `ports/semantic-gateway-client.port.ts:9-16` | `withTimeout` uses `Promise.race`; `SemanticGatewayHttpPort.chatCompletion` has no `AbortSignal`. The request is **abandoned, not aborted**. The spec says it aborts and reports the timeout. |
| **DL-5** | `dispatch-lock.ts:83-85` | `inspectInFlightPhase` is the identity function; the test asserts that inspecting `apply` returns `apply`. Tautology — it cannot fail. The scenario is about `sdd_status` surfacing a stuck lock, so the assertion belongs against the status computation. |
| **DL-6** | `dispatch-lock.ts:55-77` | `release` and `clear` are behaviorally identical. See the dedicated judgment below. |
| **IR-2** | `init-round.ts:71-75`, `:93-94` | "Never guess" violated: the Go and Rust test commands are hardcoded from manifest presence, not detected. `strictTddSupport` is inferred `true` merely because a test command exists. |
| **WF-3** | `tests/sdd-worktree-fingerprint.test.ts` | The **entire git capture path is untested**. WF-1 to WF-6 feed hand-built fingerprint literals to `compareWorktreeFingerprints`; only WF-7 (non-git) calls `captureWorktreeFingerprint`. The `--porcelain=v1 -uall` flag is never asserted — dropping `-uall` leaves every test green, and that flag is precisely what WF-3 calls load-bearing. |
| — | `application/sdd/worktree-fingerprint.ts:47-50` | A failing `git status` is swallowed into an empty string, so the guard silently degrades to "clean tree" instead of reporting that it could not check. |
| **CP-12** | `checkpoint.ts:205-211` | With no gateway injected, `batchNotes` takes the executor's own text verbatim. CP-12 says notes are generated via the semantic-utility gateway, **not authored in the executor's own output**. |
| **CP-15** | `checkpoint.ts:295-318` | "Continues from `remainingIds`, **starting with the item that was blocked**" is unimplemented. `BlockedOn` carries no item id and `resumeBatch` never touches `remainingIds`. The test's assertion of `["s2"]` is residue from `declareBatch`. |
| **PC-5 / PC-6** | `application/sdd/prompt-composition.ts:44` | The default `skillResolver` fabricates a `/skills/NAME` path — it always resolves, so PC-6's unresolvable-skill guard **cannot fire in production**, and the paths are not absolute on Windows. |
| **PE-16** | `domain/sdd/executor-contract.ts:246-250` | `getGatekeeperValidatorDispatch` returns `buildSubagentType` applied to its own argument. The scenario's whole point — the configured **default** model, not the phase's own — is undiscriminable by this shape. |
| **EF-6** | `domain/sdd/entry-flow.ts:94` | `resolveChangeNameDomain` matches with `startsWith`, so a derived slug `auth` silently "reuses" an unrelated existing change `auth-refactor`. |
| **EF-9 / EF-16** | `application/sdd/entry-flow.ts:245-295`, `:89` | EF-9 only proves gate 1; the implemented order (mention, preflight, **model**, change) does not match the spec's enumerated order (mention, preflight, change, parsing). EF-16 trusts a caller-supplied `initialized` boolean rather than probing. |

---

## Requested judgment: `releaseDispatchLock` vs `clearDispatchLock`

**They do not satisfy DL-6. The distinction is purely nominal.**

The source itself concedes it (`dispatch-lock.ts:64-73`): at the code level both take no argument and always return `null`, and nothing in the module's signatures distinguishes "the phase itself finished" from "a human is force-clearing a stuck lock" — that distinction lives entirely in which call site invokes which name.

The scenario requires the explicit clear to be a **deliberate and distinct** path. Two functions with identical bodies encode no path distinction, only a naming convention that nothing enforces. The positive half of the test asserts that the clear returns `null`, which cannot fail. Nor does any test assert the scenario's actual consequence: that phase Q can acquire the lock after the clear.

The one part that **does** discriminate is the source scan asserting the module contains no `setTimeout`, `setInterval`, `Date.now`, `expiresAt`, `expiry` or `ttl`. That genuinely closes the "never automatic on timeout" half and should be kept.

**Recommendation**: collapse into one function taking a persisted reason — `release(reason: "completed" | "force-clear")` — so the deliberate path is observable in the record; or keep a single function and delete the other. Two identical functions prove nothing.

---

## Signature changes from the remediation — no broken call sites

| Change | Verification |
|---|---|
| `AssembleStatusInput` lost `nextRecommended` (now computed internally) | Full grep: the only production consumer is `assembleStatus` itself; tests updated. Strict typecheck green. |
| `releaseDispatchLock` / `clearDispatchLock` lost the unused parameter | The sole production call site is `save-artifact.ts:58`, consistent. |

**No behavior lost, no inconsistent call site.**

---

## Scope prerequisite before archive — not a code fix

The **MCP tool surface is unimplemented**: none of the seven tools in design §2 (`sdd_status`, `sdd_save_artifact`, `sdd_checkpoint`, `sdd_compose_phase_prompt`, `sdd_parse_request`, `sdd_init_questions`, `sdd_save_config`) exists. Every module under `src/domain/sdd` and `src/application/sdd` is imported **only by tests**.

This was reported as previously agreed and deferred as out of scope for WU1–WU12. That deferral is **recorded nowhere**:

| Searched | Result |
|---|---|
| SPEC "Out of scope" (lines 1006–1022) | 6 items; MCP surface absent. The only MCP-surface mention is `sdd-onboard`, phrased as the exception that confirms the rule |
| Design doc | nothing |
| `TASKS.md` | nothing; WU1–WU12 all ticked, no scope marker |
| grep for `WARNING-3` / `W-3` across `docs/` | 0 hits |
| Engram (`sdd-plugin`) | only #2411 (WU1) and #2413 (WU3) apply-progress |

Accepting the account, this is filed as a **WARNING, not a CRITICAL** — but two actions are required before archive:

1. Write the deferral into the SPEC's "Out of scope" list.
2. Delete the stale promise at `src/application/sdd/dispatch-lock.ts:6-8`, which states that the actual MCP tool wiring into those two tools is WU7. WU7 shipped without it and never retracted the claim.

An unrecorded deferral is indistinguishable from a defect to the next fresh-context pass. This one already cost a full re-verification cycle.

---

## Remediation brief for `sdd-apply`

Strict TDD is active — every item starts RED. Full version in Engram at `sdd/sdd-phase-agents/verify-remediation-brief` (#2418).

**Suggested order**: SG-5 (add `AbortSignal` to the port), then C-2 which inherits real abort for free, then C-1 and C-3 together since both rewrite `writeCheckpointsDurable`, then C-4 which is independent.

**The decisive instruction**: for C-1 and C-2 the existing tests pass against an empty implementation. They must be **replaced, not extended** — adding cases alongside them leaves the false green intact.

| Item | RED that must be written first |
|---|---|
| **C-1** | A `FakeStore` that **mutates the stored record between the read and the write** inside `writeCheckpointsDurable`. The current `failOnAttempts` (which throws) only proves retry-on-storage-error. Requires a port change: `readCheckpoint` returns content plus version, `writeCheckpoint` accepts an expected version and rejects on mismatch. |
| **C-2** | A port that **hangs** (never resolves) with a short `timeoutMs`. Delete the `secondaryAttempted` / `fallbackService` assertion — it observes a symbol the implementation never references. Route `sddParseRequest` through `callSemanticGateway`. |
| **C-3** | Falls out with C-1; additionally route `blockMidBatch` and `resumeBatch` through the durable path instead of raw `store.writeCheckpoint`. |
| **C-4** | Assert `status`, `nextRecommended` and non-empty `blockedReasons` **together from `assembleStatus`** — the production entry point, the pattern that correctly closed the original RT-13. Fix: append a blocked reason when `verifyReportHasUnresolvedCritical` is set, mirroring the attempt-cap logic at `:98-114`. |

**Cheap WARNINGs worth folding into the same batch**: the SG-4 throw-path test, the SG-5 `AbortSignal`, the silent git failure at `worktree-fingerprint.ts:47-50`, the executor-authored note at `checkpoint.ts:209`, and the fabricated skill paths at `prompt-composition.ts:44`.

---

## What is genuinely solid

Stated without reservation, after looking hard.

- **WU1 — project identity.** `realpathSync.native` plus a Windows case-fold before hashing (`project-identity.ts:31-47`) is correct. PI-2 (8.3 short name, drive case, mixed case) and PI-3 (symlink) are real assertions against real filesystem behavior, not mocks.
- **WU3 — routing**, apart from C-4. `computeDependencies` taking exactly one argument **as the enforcement mechanism** for "the archive gate has no override" is good design: the absence of a second parameter is checked by the test via `computeDependencies.length === 1` rather than promised in a comment.
- **PC-9** counts contract occurrences with `indexOf` versus `lastIndexOf` and asserts real ordering; **PC-2** asserts the error's `artifactName`, `artifactSize` and `budgetLimit`. Both discriminate.
- **SS-8**: the `PmcSddArtifactStoreAdapter` is asserted to route every access through a named MCP tool, with a source scan proving no `child_process` import and no `exec` or `spawn` call.

---

## Root-cause pattern across the change

The recurring defect shape is **a test asserting against hand-built literals fed to a pure comparator**, which never exercises the capture or wiring half of its own scenario. It appears in WF-1 to WF-6, RT-18, DL-5, DL-6 and CP-16/CP-17.

The correct template already exists in this repo: the RT-13 remediation, which asserts through the production entry point (`assembleStatus`) rather than through two functions handed the same array. Applying that template to DL-5, WF-1 to WF-6 and CP-16/CP-17 would close most of the remaining exposure.
