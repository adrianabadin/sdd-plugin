# Independent Strict-TDD Verification — SDD Phase Agents Remediation

**Target:** `f9c25344c41ab60e098e4ae058c76fd365af28b4` on `feat/sdd-phase-agents-remediation-1` (based on `d10b292`)
**Date:** 2026-08-04
**Mode:** adversarial · independent · Strict TDD · scoped round (C-2, C-3, C-4, C-1-partial)
**Method:** live command execution + direct source inspection. No production or test file was modified.

> **This report supersedes** Engram observation **#2416** and the file-based
> `docs/superpowers/specs/2026-08-03-sdd-phase-agents-VERIFY-fresh-d10b292.md`.
> The apply log `docs/superpowers/specs/2026-08-03-sdd-phase-agents-remediation-APPLY.md`
> was treated as an unverified claim throughout and is itself audited below.

## Verdict: FAIL — not archivable

The remediation is a real and substantial engineering improvement: three of
the four in-scope prior CRITICALs are genuinely closed at the source level,
and the SQLite optimistic-concurrency fix is proven by a true two-process
race test. However, archive is blocked by:

1. a **new production-blocking defect** — `sdd_compose_phase_prompt` cannot
   succeed for `sdd-tasks` or `sdd-apply` in the real bootstrap, and each
   failed attempt now leaks a **durable** stuck lock (an aggravation caused
   by this remediation's own durable-lock work);
2. **Strict-TDD evidence for the 12 remediation tasks is only 3/12 genuinely
   observed**, with 5 tasks labelled "directly observed" while containing no
   RED artifact at all;
3. the apply log contains **provably false provenance statements** that
   contradict both the git diff and the log's own files-changed matrix.

## Tree and command evidence

Working tree was clean at start and at end; the only file added is this report.

| Command | Exit | Result |
|---|---:|---|
| `git rev-parse HEAD` | 0 | `f9c25344c41ab60e098e4ae058c76fd365af28b4` — exact target. |
| `git rev-parse --abbrev-ref HEAD` | 0 | `feat/sdd-phase-agents-remediation-1` — correct branch. |
| `git status --porcelain` (start) | 0 | Empty — clean. |
| `pmc get-context src/bootstrap/sdd-tools.ts compact` | 0 | Structural context obtained before source reads (pmc-skill). |
| `npm run build` | 0 | tsc + tsup green; "Build success in 83ms". |
| `npm run test:typecheck:strict` | 0 | `tsc --project tsconfig.test.json --noEmit` clean. |
| `npm run test:typecheck:persistence` | 0 | `tsc --project tsconfig.persistence-tests.json --noEmit` clean. |
| `node scripts/run-persistence-tests.mjs` | **1** | 33 declared / 33 reached / **32 passed / 1 failed** — only `tests/bun-readiness.test.ts`. |
| `npx tsx tests/bun-readiness.test.ts` | 1 | Cause independently confirmed: ENOENT copyfile `opencode-models.test.db`. Fixture is **untracked in git** (`git ls-files` empty) and absent from this worktree while present in the main checkout. Pre-existing, environmental, unrelated. |
| 16 x `npx tsx tests/sdd-*.test.ts` (each individually) | 0 (all) | artifact-store, change-state, checkpoint-use-case, discovery-status, dispatch-lock, entry-flow, executor-contract, init-round, keys, project-identity, prompt-composition, routing, semantic-gateway, status-schema, tools.integration, worktree-fingerprint. |
| `npx tsx tests/sqlite-mcp-tool-client-occ.test.ts` | 0 | OC-1 and OC-2 pass; debug line `a={"version":1} b={"version":1,"conflict":true}`. |
| `npx tsx tests/sqlite-mcp-tool-client.test.ts` | 0 | 6 bridge checks pass. |
| `npx tsx tests/sdd-change-state.test.ts` | 0 | Pass. |
| `npx tsx tests/sdd-tools.integration.test.ts` | 0 | Pass (emits only a header and a single summary line — see WARNING 5). |
| `git status --porcelain` (end) | 0 | Exactly one entry: this report. |

`npm run test:model-routes` was deliberately NOT run (declared environmental,
out of SDD scope, and not needed to classify anything found here).

## Strict-TDD completeness — the 12 remediation tasks (C-1, in scope)

The apply log header says "three passes, twelve tasks" but enumerates fifteen
numbered items (Pass 1 = 1-4, Pass 2 = 5-9, Pass 3 = 10-15). The reconciliation
to twelve is unstated; it works only if the three log-writing tasks (4, 8, 14)
are excluded. The table below audits those twelve substantive tasks.

| Task | Claim in log | RED actually present in the log | Ruling |
|---|---|---|---|
| 1 build fix | RED directly observed | Yes — two TS2379/TS2375 compiler errors quoted | **OBSERVED** (compiler error, not a failing test) |
| 2 DL-6 durable recovery | RED directly observed | Yes — "TypeError: secondAdapter.reclaimChangeStateLock is not a function", and "Missing SDD tool 'sdd_recover_phase_lock'" | **OBSERVED** (test *errored*, did not assert-fail) |
| 3 persistence runner registration | RED directly observed | No command output — prose describing the SUITE array | **NARRATIVE** |
| 5 sentinel reclaim | RED explicitly "(narrative...)" | None | **NARRATIVE** (honestly self-labelled) |
| 6 `verifyOwnedLock` before write | "RED to GREEN (directly observed)" | **None** — only a GREEN pass line | **MISLABELLED** |
| 7 reclaim retry uses fresh state | "RED to GREEN (directly observed)" | **None** — only a GREEN pass line | **MISLABELLED** |
| 9 header reconciliation | no cycle claimed | n/a — documentation task | **NONE** |
| 10 sentinel binds to owning change | RED directly observed | Yes — but the quoted RED is `SddChangeStateSentinelBindingConflictError`, a class that cannot exist before the implementation; the log states the pre-existing test "previously asserted 'second sdd-init reclaims the sentinel'" and was **updated after** the code | **OBSERVED but implementation-first** |
| 11 `sdd_save_config` dual-lock validation | "RED to GREEN (directly observed)" | **None** — only a GREEN pass line | **MISLABELLED** |
| 12 remove artifact-save TOCTOU | "RED to GREEN (directly observed)" | **None** — only "All sdd-tools integration tests passed." | **MISLABELLED** (and this is the highest-stakes task) |
| 13 repair reclaim regression test | "RED to GREEN (directly observed)" | **None** — only a GREEN pass line | **MISLABELLED** |
| 15 doc/header reconciliation | no cycle claimed | n/a — documentation task | **NONE** |

**Tally: 3/12 genuinely observed RED-before-GREEN** (tasks 1, 2, 10 — and task 10's
RED is an updated-test-after-code cycle). **2/12 narrative. 5/12 assert "directly
observed" while the document contains no RED artifact. 2/12 documentation-only.**

**Corroboration from git is zero.** Every remediation commit lands production
code and its tests together — `d072168` contains the OCC fix *and*
`tests/sqlite-mcp-tool-client-occ.test.ts` *and* the worker;
`a57cf3e` contains the port, adapter and their tests. There is no RED commit
anywhere in `d10b292..f9c2534`, so the RED claims rest entirely on the apply
log's own narration, which is demonstrably unreliable (see CRITICAL C-N2).

The apply log is explicit that it does **not** claim evidence for the 131
historical parent-change tasks. That gap therefore **remains fully open**:
Strict-TDD evidence for `sdd-phase-agents` is still **0/131**.

## Claim / requirement compliance matrix

| # | Apply-log claim | Verdict | Source evidence |
|---|---|---|---|
| 1 | An 8th tool `sdd_recover_phase_lock` exists and is bootstrap-wired; the lifecycle is reachable through the **registered tool definitions** | **CONFIRMED** | `src/bootstrap/sdd-tools.ts:756-765` returns exactly 8 ToolDefinitions; `src/bootstrap/index.ts:241` calls buildSddTools({store, changeStateStore}) and `:257` returns `{ tool: sddTools }`. `tests/sdd-tools.integration.test.ts:34-36` resolves tools by name and calls `definition.execute(args)` — the real tool boundary, not helpers. 103 assertions. The prior "hollow tool boundary" failure mode is genuinely fixed. |
| 2 | `persistArtifactWithOwnership` removes a save-path TOCTOU; `verifyOwnedLock` runs before artifact writes | **CONFIRMED for the artifact write** | `src/infrastructure/pmc/pmc-sdd-artifact-store.adapter.ts:394-432` runs read-state, verify-owner, write artifact, read back, then a **conditional** state write under the version read in step 1, all inside `runInTransactionSync`. A reclaim landing mid-window advances the version, the OCC write fails, and BEGIN/ROLLBACK discards the artifact insert. A second caller can still *interleave*, but it can only cause a **rejection**, never a stale persisted artifact. `verifyOwnedLock` runs at `src/bootstrap/sdd-tools.ts:422-426`; the code honestly documents that this pre-flight is not itself atomic (`:417-421`). |
| 3 | SQLite OCC write is atomic via rawCall + runInTransactionSync; the test exercises two truly concurrent clients | **CONFIRMED** | `sqlite-mcp-tool-client.adapter.ts` handleStore now issues a single `UPDATE ... WHERE id = ? AND version = ? RETURNING version`, with `INSERT ... ON CONFLICT(id) DO NOTHING RETURNING version` for the create case. The mutation cannot succeed twice from one expected version. `tests/sqlite-mcp-tool-client-occ.test.ts:57-96` **spawns two OS processes** via child_process.spawn, rendezvouses them on a filesystem barrier (`tests/_helpers/sqlite-mcp-tool-client-occ-worker.ts:49-89`), and asserts exactly one winner plus one row at the winner's content. The prior report's "sequential test is insufficient" objection is answered. Note the barrier gates the *first statement*, which in the fixed code is the mutation itself, so the interleaving is natural rather than forced — the test still discriminates, because a check-then-upsert implementation would produce two winners and fail. |
| 4 | The sentinel binds to the OWNING change; `sdd_save_config` atomically validates both locks | **CONFIRMED** | Binding enforced at `pmc-sdd-artifact-store.adapter.ts:350-352` (SddChangeStateSentinelBindingConflictError); boundChangeName threaded from `sdd-tools.ts:247-254` and `:260-267`. `sdd_save_config` calls verifyInitRoundOwnership (`sdd-tools.ts:554-560`) which validates the user token, the sentinel token AND the binding (`adapter.ts:331-352`) **before** saveInitConfig at `:588`. |
| 5 | sqlite-mcp-tool-client.adapter.ts and tsconfig.test.json are "prior work, NOT touched by any apply pass" | **REFUTED** | See CRITICAL C-N2. |
| 6 | Every reviewer finding has its own RED-GREEN cycle with directly observed output | **REFUTED** | See the Strict-TDD table above: 3/12. |

## Findings

### CRITICAL

**C-N1 — `sdd_compose_phase_prompt` is unusable for `sdd-tasks` and `sdd-apply`
in production, and each attempt leaks a durable lock.**

`src/bootstrap/index.ts:241` constructs the tool surface with **no**
skillResolver:

    sddTools = buildSddTools({ store: sddStore, changeStateStore: sddStore });

`src/bootstrap/sdd-tools.ts:373` therefore omits the key entirely, so
composePhasePrompt falls back to its default resolver, which by deliberate
design returns null (`src/application/sdd/prompt-composition.ts:45`):

    skillResolver = () => null,

STATIC_PHASE_SKILLS_MAP (`src/domain/sdd/prompt-composition.ts:60-61`) maps
`sdd-tasks` to ["work-unit-commits", "chained-pr"] and `sdd-apply` to
["work-unit-commits"], and `src/application/sdd/prompt-composition.ts:87-90`
throws UnresolvableSkillError on the first unresolved name. Two of the eight
phases therefore **always** throw in the real plugin.

The remediation makes this strictly worse. The durable lock is acquired at
`src/bootstrap/sdd-tools.ts:284` and the baseline fingerprint is committed at
`:348` — both **before** the composePhasePrompt call at `:361`. There is
**no try/catch around that call** (verified at `:355-375`), so the throw
propagates with the durable lock still held. In the baseline this was a
transient in-memory failure (prior WARNING 1); it is now a persisted stuck lock
requiring `sdd_recover_phase_lock` to clear. The same leak occurs for any
PromptBudgetExceededError. No test covers the failure path, because every
integration test injects a working resolver
(`tests/sdd-tools.integration.test.ts:501-502` and elsewhere:
skillResolver returning "/skills/" + skill), which is exactly the
"tests pass because the fixture is not the production wiring" defect class the
prior report identified.

**C-N2 — The apply log's provenance statements are false, which disqualifies it
as standalone Strict-TDD evidence.**

- `src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.ts` — log line 47 lists
  it as "prior work in this worktree (NOT touched by any apply pass)". The log's
  **own** files-changed matrix (line 571) says `modified` in Pass 3. The git
  diff supports the matrix: `git log --oneline -- <file>` shows
  `d072168 fix(pmc): make SqliteMcpToolClient OCC writes atomic...`, and
  `git diff --name-status d10b292..f9c2534` marks it `M`. **The log contradicts
  itself, and the diff refutes the "untouched" side.**
- `tsconfig.test.json` — asserted untouched at log lines 48 **and** 590, and
  omitted from the matrix entirely. `git diff --name-status` marks it `M`, and
  `db8e67a test(sdd): register new persistence-gate test files in runner and
  strict tsconfig` adds four entries to it. **Factually false and unrecorded.**
- `tests/sqlite-mcp-tool-client-occ.test.ts` and
  `tests/_helpers/sqlite-mcp-tool-client-occ-worker.ts` — log lines 49-50 call
  them prior work "present at session start", with only "the timeout changed".
  `git diff --name-status d10b292..f9c2534` marks both `A` (added), introduced
  by `d072168` — **the same commit that made the OCC fix they are supposed to
  prove.** Git cannot distinguish "created earlier in the session but untracked"
  from "created by this commit", so the *pre-existence* claim is **UNVERIFIED**
  rather than disproven; what is proven is that there is no RED commit and no
  independent corroboration for the primary C-4 evidence.
- The log header states "**Branch**: in-progress remediation branch (NO COMMITS
  MADE)" and the self-review repeats "No commits were made." Seven commits exist
  in `d10b292..f9c2534`. The artifact was never reconciled with the state it
  documents.

Individually these are sloppiness; together, in the one document that carries
all the RED evidence, they mean the log cannot be relied upon where git and
source do not independently corroborate it.

**C-N3 — Strict-TDD evidence for the 12 remediation tasks is 3/12, with 5 tasks
overclaiming "directly observed".**

Detailed in the Strict-TDD table. Tasks 6, 7, 11, 12 and 13 are headed
"RED to GREEN (directly observed)" yet contain only a GREEN pass line. Task
12 is the atomic-persist task — the single most load-bearing change in the
remediation — and has no RED artifact whatsoever. Under the Strict-TDD protocol
in force, a claim of observation that the document itself does not support is a
process failure, not a documentation nit.

### WARNING

**W-1 — Ownership displacement protection does not apply within a single tool
surface, which is the production topology.**
`ownerTokens` is a process-wide Map keyed only by
projectRootHash + "/" + changeName (`src/bootstrap/sdd-tools.ts:129`, `:146-147`).
`sdd_save_artifact` reads the token **at save time** (`:406`), not at compose
time. A second same-phase compose on the same surface reclaims the durable lock
and overwrites the map entry (`:302-311`, `:337`). The first, still-live
dispatch then saves using the replacement token, passes verifyOwnedLock,
and its artifact commits. Every integration test that exercises displacement
uses **two separate** buildSddTools instances
(`tests/sdd-tools.integration.test.ts:1018`/`:1033`, `:1108`/`:1124`,
`:501`/`:502`), each with its own map — so the single-surface case is untested
and unprotected. `src/bootstrap/index.ts:241` creates exactly one surface.
This does not violate the SPEC (which explicitly blesses same-phase
re-acquisition at `2026-08-02-sdd-phase-agents-SPEC.md:404-407`), but it does
mean the Pass 2 Task 6 claim in the apply log — that the displaced surface
sdd_save_artifact REJECTS the save — holds only cross-process.

**W-2 — runInTransactionSync uses a deferred BEGIN, not BEGIN IMMEDIATE.**
`src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.ts:165` issues
`this.db.exec("BEGIN")`. The transaction reads (readStoredChangeStateSync)
before it writes, so under concurrency the read-to-write upgrade can return
SQLITE_BUSY_SNAPSHOT, which busy_timeout (set at `:91`) does **not** retry.
There is no retry loop around persistArtifactWithOwnership. The failure mode
is fail-closed (a spurious hard error, not corruption), but it is untested and
inconsistent with the rest of the repo, which uses BEGIN IMMEDIATE
(`tests/sqlite-contention.test.ts:116`).

**W-3 — The error type named by SPEC DL-2 is never raised at the tool boundary.**
`2026-08-02-sdd-phase-agents-SPEC.md:401` requires PhaseAlreadyInFlightError.
`grep -rn PhaseAlreadyInFlightError src/ tests/` shows it only in
`src/application/sdd/dispatch-lock.ts` and its unit test. The registered tool
raises SddChangeStateLockConflictError instead, and
`src/bootstrap/sdd-tools.ts:374` hardcodes `currentInFlightPhase: null`, so
acquireDispatchLock can never fire in production. Observable behaviour
(refuse + lock intact) is satisfied; the spec-named type is not.
`dispatch-lock.ts` remains dead code on the production path.

**W-4 — Prior WARNING 2 is unremediated.** `sdd_parse_request`
(`src/bootstrap/sdd-tools.ts:494-504`) still takes only `text`, has no
projectRoot, and calls sddParseRequest(args.text) with no gateway service
and no timeout — the EF-4 timeout path is still not the runtime tool path.
`sdd_init_questions` (`:506-519`) still takes caller-supplied file contents and
has no projectRoot, contrary to the explicit-root rule.

**W-5 — The integration suite is unobservable.**
`tests/sdd-tools.integration.test.ts` emits only a header (`:160`) and
"All sdd-tools integration tests passed." (`:1163`) across 103 assertions. Both
the persistence runner and the apply log cite that single line as evidence. A
scenario silently removed or short-circuited would be invisible. Every other
SDD suite prints per-case "pass:" lines.

### SUGGESTION

1. Inject a real skillResolver at `src/bootstrap/index.ts:241`, and wrap the
   compose body in try/catch that releases the durable lock on any throw —
   this closes C-N1 in both halves.
2. Print per-case "pass:" lines in `tests/sdd-tools.integration.test.ts` to match
   the other suites.
3. Key ownerTokens by an opaque per-dispatch handle returned from compose, and
   require the caller to present it to save, so displacement protection holds
   intra-process.
4. Use BEGIN IMMEDIATE in runInTransactionSync, or add a bounded retry.
5. Fix the stale docstring at `src/bootstrap/sdd-tools.ts:121` ("Builds the
   seven SDD tools") — the module header two lines above correctly says eight.
6. Reconcile the "twelve tasks" header in the apply log with its fifteen
   enumerated items, correct the provenance table, and remove "NO COMMITS MADE".
7. Commit tests separately from implementation so RED is corroborated by git and
   the Strict-TDD claim does not depend on narration.

## Re-evaluation of the five prior CRITICALs

| Prior | Status | Evidence |
|---|---|---|
| **C-1** Strict-TDD evidence missing (131 tasks) | **PARTIALLY CLOSED (remediation) / STILL OPEN (parent)** | For the 12 remediation tasks an apply log now exists, but only 3/12 carry genuinely observed RED and 5/12 overclaim (C-N3). For the 131 historical tasks the log explicitly declines to claim evidence — that gap is untouched: **0/131**. |
| **C-2** Tools registered but no durable SDD lifecycle | **CLOSED** | `sdd_status` now has a real discovery branch when changeName is omitted (`sdd-tools.ts:200-212`, SS-5/SS-6) and derives inFlightPhase from durable state (`:182`) with blockedReasons (`:175`), so a crashed lock is visible. The lock is persisted and version-conditioned via acquireChangeStateLock (`:284`). No tool accepts a caller-supplied lock or fingerprint (`:222-226`, `:398-402`). verifyReportHasUnresolvedCritical is now computed from the **stored** report (`:184`) rather than trusted from the caller. DL-6 explicit clear exists as the 8th tool (`:685-754`). |
| **C-3** WF-3 fingerprint only below the tool boundary | **CLOSED** | `sdd_compose_phase_prompt` captures at the boundary (`sdd-tools.ts:346`), persists the baseline durably (`:348-353`) and **returns** worktreeFingerprint to the caller (`:383`). `sdd_save_artifact` recomputes at the boundary (`:437`) and fails closed on gitProbeFailed or unexpected writes (`:441-447`); `sdd_save_config` does the same (`:576-586`). Production uses the real captureWorktreeFingerprint by default (`:128`); the injection seam is test-only. |
| **C-4** Checkpoint OCC not atomic in real SQLite | **CLOSED** | Single conditional `UPDATE ... WHERE id = ? AND version = ? RETURNING version`, plus `INSERT ... ON CONFLICT DO NOTHING RETURNING` for creation, in `sqlite-mcp-tool-client.adapter.ts` handleStore. Proven by `tests/sqlite-mcp-tool-client-occ.test.ts`, which spawns **two independent OS processes** with a filesystem rendezvous and asserts exactly one winner (OC-1 create race, OC-2 stale-version race). Observed live: `a={"version":1} b={"version":1,"conflict":true}`. Caveat W-2 on the separate transaction primitive. |
| **C-5 / SS-8** Live backend is SqliteMcpToolClient, not the real agent-memory MCP path | **STILL OPEN — out of scope this round** | `src/bootstrap/index.ts:239` still constructs `new SqliteMcpToolClient()`, which opens the private `memories` schema directly. Unchanged and not addressed. |

## Out of scope this round — restated as STILL OPEN

None of the following were verified or remediated; all remain open and block a
clean archive of the parent change:

- **C-5 / SS-8** — live persistence backend is the private SQLite schema, not
  the specified agent-memory-mcp tool path (`src/bootstrap/index.ts:239`).
- **CP-16 / CP-17** — checkpoint optimistic concurrency at the *application*
  layer (`src/application/sdd/checkpoint.ts` read-modify-write). The SQLite fix
  in this round addresses the storage primitive, not the CP-16/CP-17 finding.
- **EF-4** — semantic-gateway timeout is not on the runtime tool path
  (`sdd-tools.ts:501`; see W-4).
- **SS-10** — read-back on real checkpoint write paths.
- **RT-13** — status/routing disagreement on unresolved CRITICAL findings.
- **Strict-TDD evidence for the 131 historical parent-change tasks** — 0/131,
  explicitly not claimed by the apply log.

## Model-route and bun-readiness separation

- `tests/bun-readiness.test.ts` — cause independently reproduced and confirmed:
  ENOENT copyfile `opencode-models.test.db`. The fixture is untracked
  (`git ls-files opencode-models.test.db` returns empty) and exists only in the
  main checkout, not in this worktree. Pre-existing and unrelated; excluded from
  the verdict.
- `npm run test:model-routes` — declared environmental (generated
  `.opencode/agents/sdd-mr-v1-*.md` files) and deliberately not run.

No other failure was observed in any gate.

## Artifact paths changed

- `docs/superpowers/specs/2026-08-04-sdd-phase-agents-remediation-VERIFY-f9c2534.md` — this report only.
  Confirmed by `git status --porcelain` at the end of the run.

## Final verdict

**FAIL — do not archive.** C-2, C-3 and C-4 are genuinely closed and the work is
materially better than `d10b292`. Archive is nonetheless blocked by C-N1 (a
production-blocking compose failure that now leaks a durable lock), C-N2 (the
false provenance in the apply log, which removes the evidentiary basis for the
un-corroborated RED claims) and C-N3 (3/12 Strict-TDD evidence with five
overclaims), plus the six out-of-scope items that remain open.

**Next recommended phase: `sdd-apply`** — remediate C-N1 first (inject
skillResolver, release the lock on compose failure, add a test for the failure
path), then correct the apply log and re-establish RED evidence for the five
mislabelled tasks. A fresh Strict-TDD verification should follow.

No production or test file was modified during this verification.
