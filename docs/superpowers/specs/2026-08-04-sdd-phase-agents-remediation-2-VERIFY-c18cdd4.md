# Independent Strict-TDD Verification (Round 2) — SDD Phase Agents Remediation

**Target:** `c18cdd4f056e89cdb5ceeb72fbddeb084b58243e` on `feat/sdd-phase-agents-remediation-1`
**Base of the audited round:** `35fda35` (the previous verification target's commit)
**Date:** 2026-08-04
**Mode:** adversarial · independent · Strict TDD · scoped to closure of **C-N1 (A1+A2)**, **C-N2**, **C-N3**
**Method:** live command execution, direct source inspection, and **executable revert/injection probes run in throwaway scratch copies of the tree**. No production or test file in this worktree was modified.

> **This report supersedes** `docs/superpowers/specs/2026-08-04-sdd-phase-agents-remediation-VERIFY-f9c2534.md`
> for the three findings it scopes (C-N1, C-N2, C-N3). All other findings in that report
> (W-1..W-5) and all deferred parent CRITICALs remain in force and are restated below as
> still open.
> `docs/superpowers/specs/2026-08-04-sdd-phase-agents-remediation-2-APPLY.md` was treated
> throughout as an **unverified claim**, not as evidence.

---

## Verdict: FAIL — not archivable

Round 2 is honest, narrowly scoped work and is materially better than the round it
replaces. **C-N1 half A1 is genuinely CLOSED and I proved it myself** by reverting the fix
in a scratch copy and observing the committed regression test go red with the exact
expected assertion. **C-N2 is CLOSED**: every corrected provenance fact re-checks against
`git log` / `git diff`.

Archive is nonetheless blocked by:

1. **C-N1 half A2 is only PARTIALLY CLOSED.** `sdd_compose_phase_prompt` for
   `sdd-tasks` / `sdd-apply` now works — but *only* when an untracked, gitignored,
   externally-generated `.atl/skill-registry.md` happens to exist at the plugin's startup
   directory. That file is **absent from this very worktree**, is produced by **no code in
   this repository**, is named by **no spec**, and its absence produces **no diagnostic**.
   Two of eight phases remain unusable out of the box on any fresh clone, CI runner, or
   worktree.
2. **A newly-introduced contract violation**: the resolver is bound to the *startup*
   directory, in direct contradiction of the invariant documented six lines above the
   function it is passed into (`src/bootstrap/sdd-tools.ts:120-125`), with zero test
   coverage.
3. **C-N3 is PARTIALLY CLOSED.** Round 2's own evidence is materially better and honestly
   labelled, but its headline RED artifact was deleted before commit and is unauditable
   from git; and the five round-1 tasks that overclaimed "directly observed" were
   **relabelled, not re-evidenced** — the 3/12 tally is unchanged in substance.
4. All out-of-scope items from the prior report remain open, including 0/131 historical
   Strict-TDD evidence.

---

## Tree and command evidence

Working tree was clean at start (`git status --porcelain` empty) and at end contains
exactly one entry: this report. `git rev-parse HEAD` =
`c18cdd4f056e89cdb5ceeb72fbddeb084b58243e`, `git rev-parse --abbrev-ref HEAD` =
`feat/sdd-phase-agents-remediation-1`.

### Mandated gates

| Command | Exit | Result |
|---|---:|---|
| `git rev-parse HEAD` | 0 | `c18cdd4f056e89cdb5ceeb72fbddeb084b58243e` — exact target. |
| `git rev-parse --abbrev-ref HEAD` | 0 | `feat/sdd-phase-agents-remediation-1` — correct branch. |
| `git status --porcelain` (start) | 0 | Empty — clean. |
| `npm run build` | **0** | `tsc` clean; `tsup` — "ESM Build success in 75ms". |
| `npm run test:typecheck:strict` | **0** | `tsc --project tsconfig.test.json --noEmit` clean, no output. |
| `npm run test:typecheck:persistence` | **0** | `tsc --project tsconfig.persistence-tests.json --noEmit` clean, no output. |
| `node scripts/run-persistence-tests.mjs` | **1** | 33 declared / 33 reached / **32 passed / 1 failed / 0 blocked** — the single failure is `tests/bun-readiness.test.ts`. |
| `git status --porcelain` (end) | 0 | Exactly one entry: this report. |

### Every `tests/sdd-*.test.ts`, run individually via `npx tsx`

| Suite | Exit | Last line |
|---|---:|---|
| `tests/sdd-artifact-store.test.ts` | 0 | `All sdd-artifact-store tests passed.` |
| `tests/sdd-change-state.test.ts` | 0 | `All sdd-change-state tests passed.` |
| `tests/sdd-checkpoint-use-case.test.ts` | 0 | `All sdd-checkpoint tests passed successfully!` |
| `tests/sdd-discovery-status.test.ts` | 0 | `All sdd-discovery-status tests passed.` |
| `tests/sdd-dispatch-lock.test.ts` | 0 | `All sdd-dispatch-lock tests passed.` |
| `tests/sdd-entry-flow.test.ts` | 0 | `pass: EF-21 health probe overwrites single fixed key without accumulating` |
| `tests/sdd-executor-contract.test.ts` | 0 | `All WU11 sdd-executor-contract tests passed!` |
| `tests/sdd-init-round.test.ts` | 0 | `All 13 sdd-init-round (WU6) tests passed successfully!` |
| `tests/sdd-keys.test.ts` | 0 | `All sdd-keys tests passed.` |
| `tests/sdd-project-identity.test.ts` | 0 | `All sdd-project-identity tests passed.` |
| `tests/sdd-prompt-composition.test.ts` | 0 | `All 10 sdd-prompt-composition (WU7) tests passed successfully!` |
| `tests/sdd-routing.test.ts` | 0 | `All sdd-routing tests passed.` |
| `tests/sdd-semantic-gateway.test.ts` | 0 | `All sdd-semantic-gateway tests passed.` |
| **`tests/sdd-skill-registry.test.ts`** (new, A2) | 0 | `All sdd-skill-registry tests passed.` (7 `pass:` lines) |
| `tests/sdd-status-schema.test.ts` | 0 | `All sdd-status-schema tests passed.` |
| **`tests/sdd-tools.integration.test.ts`** (extended, A1) | 0 | `All sdd-tools integration tests passed.` |
| `tests/sdd-worktree-fingerprint.test.ts` | 0 | `All 10 sdd-worktree-fingerprint (WU8) tests passed successfully!` |

**17/17 pass.** The round-2 apply log's gate table matches my independent runs on every row.

### Independent probes I ran (not taken from any log)

All probes ran in throwaway copies produced by `git archive <sha> | tar -x` into the
session scratchpad, with `node_modules` supplied by an NTFS junction. The audited worktree
was never touched.

| Probe | Exit | Result |
|---|---:|---|
| P1 — `tests/sdd-tools.integration.test.ts` in a scratch copy of `c18cdd4`, unmodified | 0 | Passes — the scratch harness itself is sound. |
| P2 — same, with the A1 `try`/`catch` hunk **reverse-applied** (`patch -R`) | **1** | Suite goes red. Failure surfaces as `Error: EPERM ... rmSync` from the `finally` block — the real assertion is **masked**. |
| P3 — P2 with the `finally` `rmSync` wrapped in `try`/`catch` (scratch only) | **1** | The true failure is revealed: `AssertionError: the durable lock acquired by the failed compose does not survive the throw`, actual `{ phase: 'sdd-tasks' }` vs expected `undefined`, at `tests/sdd-tools.integration.test.ts:1194`. |
| P4 — P2 with the *first* assertion blanked, to isolate the triangulation assertion | **1** | `SddChangeStateLockConflictError: SDD_CHANGE_STATE_LOCK_CONFLICT: 'sdd-tasks' is owned by another runner; cannot acquire 'sdd-explore'` — the different-phase compose genuinely fails when the lock leaks. |
| P5 — standalone tool-boundary probe: production `createSkillRegistryResolver` + real `SqliteMcpToolClient` + real `PmcSddArtifactStoreAdapter`, registry **present** | 0 | `sdd_compose_phase_prompt` for `sdd-tasks` **SUCCEEDS**. Prompt contains a `## Skills to load before work` block listing the `work-unit-commits` and `chained-pr` SKILL.md paths. |
| P6 — same probe, registry **absent** | 0 | Compose **throws** `UNRESOLVABLE_SKILL: mapped skill "work-unit-commits" could not be resolved to a readable path`; durable `lock after throw: undefined` — released. |
| P7 — `tests/bootstrap-clean-startup.test.ts` at `c18cdd4` | 1 | `AssertionError: bootstrap must not register the obsolete config staging hook`, unexpected `'tool'` key, at `tests/bootstrap-clean-startup.test.ts:81`. |
| P8 — same test in a scratch copy of **`35fda35`** (pre-round-2) | 1 | **Identical** assertion, same actual/expected, same line 81. |
| P9 — same test in a scratch copy of **`d10b292`** (pre-remediation baseline) | 1 | **Identical** assertion, same actual/expected, same line 81. |

### Known pre-existing failures — cause confirmed by me

- **`tests/bun-readiness.test.ts`** — the sole persistence-suite failure. Cause matches the
  prior report (missing untracked `opencode-models.test.db` fixture). Pre-existing,
  environmental, out of scope.
- **`tests/bootstrap-clean-startup.test.ts`** — **CONFIRMED PRE-EXISTING, and older than
  the apply log claims.** P7/P8/P9 show the identical assertion at `c18cdd4`, `35fda35`
  **and `d10b292`**. It is not a regression from the resolver wiring, nor from round 1.
  **However, the apply log's stated root cause is wrong** — see W-N7.
- **`npm run test:model-routes`** — declared environmental, deliberately not run, out of
  scope. `git diff --stat d10b292..HEAD` over the model-routing paths is empty
  (independently re-run), so the round is genuinely zero-diff there.

No other failure was observed in any gate.

---

## Ruling table — C-N1 (split), C-N2, C-N3

| Finding | Ruling | Source evidence |
|---|---|---|
| **C-N1 · A1** — compose lock leak | **CLOSED** | `src/bootstrap/sdd-tools.ts:361-416` wraps `composePhasePrompt` in `try`/`catch`, releases the change-state lock at `:392-397` with `preparedState.version` and the init sentinel at `:404-409`, each in its own inner `try`/`catch`, and rethrows the original `composeError` at `:415`. Proven at the **registered tool boundary**: `tests/sdd-tools.integration.test.ts:1176-1220` builds `buildSddTools` with **no** `skillResolver` and calls `definition.execute()` through the suite's `invoke()` helper (`:34-36`). Probe **P3** shows the committed assertion fires with the exact expected diff when the fix is reverted; probe **P4** shows the different-phase triangulation assertion also fires; probe **P6** shows the release also happens with the *production* fs-backed resolver. |
| **C-N1 · A2** — resolver / compose usability | **PARTIALLY CLOSED** | `src/bootstrap/index.ts:249-253` wires `createSkillRegistryResolver(directory OR process.cwd())`. Probe **P5** proves compose for `sdd-tasks` now succeeds end-to-end **when the registry exists**. But `.gitignore:43` is `/.atl/`; `git check-ignore -v .atl/skill-registry.md` returns `.gitignore:43:/.atl/`; `git ls-files .atl` is empty; and `.atl/` **does not exist in this worktree**. Probe **P6** proves compose for `sdd-tasks` still throws here. A repo-wide search for `skill-registry` matches only the 3 new files, `tsconfig.test.json`, `src/bootstrap/index.ts` and the apply log — **no code in this repository generates the registry**. See CRITICAL C-R1. |
| **C-N2** — apply-log truthfulness | **CLOSED** (with W-N4) | All four false statements are corrected in place in `docs/superpowers/specs/2026-08-03-sdd-phase-agents-remediation-APPLY.md:11-105`, with 12 inline `CORRECTED, see CORRECTIONS above` pointers (lines 132, 133, 134, 135, 268, 347, 368, 478, 506, 562, 732, 745) plus two `FALSE, see CORRECTIONS below` header annotations (lines 5, 6). Nothing was deleted. Every fact re-verified by me against git — see the C-N2 audit table below. One new inaccurate commit attribution (W-N4). |
| **C-N3** — Strict-TDD evidence, this round | **PARTIALLY CLOSED** | Round 2 has 3 substantive units. A1's log-side RED rests on a deleted throwaway script (`tests/_scratch-repro-cn1.ts`, never committed, **unauditable from git**), but a permanent regression test exists and I reproduced the RED myself (P3/P4). A2's parser/adapter RED is `ERR_MODULE_NOT_FOUND` — real but uncorroborated (test and both modules land in the same commit `e049eb2`). A2's bootstrap wiring is honestly self-declared as having **no** RED/GREEN cycle; that admission is **accurate** — no test exercises `SddPlugin`'s `skillResolver` wiring. The five round-1 mislabelled tasks were **relabelled, not re-evidenced**; 0/131 historical unchanged. |

---

## Strict-TDD completeness — round 2's three units

| Unit | Log's claim | RED auditable from git? | Permanent regression guard? | Ruling |
|---|---|---|---|---|
| **A1** `try`/`catch` lock release | "RED — directly observed" via a standalone repro script deleted before commit | **No** — `tests/_scratch-repro-cn1.ts` is in no commit; `git log` has no RED commit. The in-suite RED was admittedly masked by `rmSync` `EPERM`. | **Yes** — `tests/sdd-tools.integration.test.ts:1193-1197` (lock assertion) and `:1203-1218` (different-phase triangulation). Both proven to fire on revert (P3, P4). | **VERIFIED BY INDEPENDENT REPRODUCTION.** The log's own evidence is **INSUFFICIENT** as standalone Strict-TDD proof (deleted artifact), but the claim is true and now independently reproducible from committed artifacts. |
| **A2** `skill-registry.ts` + adapter | "RED — directly observed": `ERR_MODULE_NOT_FOUND` before either module existed | **No** — test and both modules land together in `e049eb2`; no RED commit. | Yes — `tests/sdd-skill-registry.test.ts` (7 assertions, including PC-6 null cases). | **OBSERVED but UNCORROBORATED.** Same class the prior report accepted for round-1 task 2 ("test errored, did not assert-fail"). Acceptable, weak. |
| **A2** bootstrap wiring line | Explicitly "**NOT** independently RED/GREEN tested" | n/a | **No** — confirmed: nothing imports `SddPlugin` to assert `skillResolver`; `tests/bootstrap-clean-startup.test.ts` invokes `SddPlugin` but asserts only hook keys and fails identically at `d10b292`. | **NOT TESTED — admission ACCURATE and correctly labelled.** |

**Coverage gap the log does not disclose:** the *mandatory-skill happy path* has no test.
`grep -o 'phase: "sdd-[a-z]*"' tests/sdd-tools.integration.test.ts | sort | uniq -c` gives
`sdd-tasks` **x1** — the new *negative* scenario only. The 7 `sdd-apply` composes all use
the fabricated fixture resolver. **No committed test composes `sdd-tasks` or `sdd-apply`
successfully through the real fs-backed `createSkillRegistryResolver`.** I had to write
probe P5 to establish that it works at all.

### Round-1 evidence is unchanged in substance

The prior report's tally (3/12 observed, 2/12 narrative, 5/12 mislabelled, 2/12 doc-only)
is now *accurately documented* in the round-1 log, but no RED was re-established for tasks
6, 7, 11, 12, 13. The prior report's own remedy ("re-establish RED evidence for the five
mislabelled tasks") was **not performed** — round 2 explicitly scoped it out. Task 12
(`persistArtifactWithOwnership`, the highest-stakes change) still has no RED artifact.

---

## C-N2 audit — every corrected fact re-checked against git

| Correction claim in the round-1 log | My independent check | Verdict |
|---|---|---|
| "NO COMMITS MADE" is FALSE; `d10b292..35fda35` shows **8 commits**: `8265eb6`, `d072168`, `a57cf3e`, `2ad4a69`, `aeb575e`, `db8e67a`, `f9c2534`, `35fda35` | `git rev-list --count d10b292..35fda35` = **8**; `git log --oneline` lists exactly those 8 SHAs | **ACCURATE** |
| `sqlite-mcp-tool-client.adapter.ts` was NOT untouched — modified by `d072168` | `git diff --name-status d10b292..f9c2534` returns `M`; `git log -- <path>` returns `d072168` | **ACCURATE** |
| `tsconfig.test.json` was NOT untouched — modified | `git diff --name-status d10b292..f9c2534` returns `M` | **ACCURATE on the substance** |
| ...specifically "touched by that same commit's diff (`d072168`) and again by `db8e67a`" (also inline at log line 133) | `git show --name-only --format="" d072168` lists exactly 3 files: the adapter, the OCC worker, the OCC test. **`tsconfig.test.json` is not among them.** `git log d10b292..f9c2534 -- tsconfig.test.json` returns **`db8e67a` only** | **NEW FALSE ATTRIBUTION, see W-N4** |
| `tests/sqlite-mcp-tool-client-occ.test.ts` and `tests/_helpers/sqlite-mcp-tool-client-occ-worker.ts` are `A` (added) by `d072168`; pre-existence is **UNVERIFIABLE from git**, not disproven | `git diff --name-status d10b292..f9c2534` returns `A` for both; both listed in `git show --name-only d072168` | **ACCURATE, and correctly hedged** |
| Tasks 6, 7, 11, 12, 13 were MISLABELLED "directly observed" | Inline pointers present at log lines 347, 368, 478, 506, 562; task-3 RED heading at 268; self-review at 732; header at 745 | **ACCURATE and complete** |
| 131 historical tasks remain **0/131** | Stated at correction item 5 and in the preserved original text | **ACCURATE** |

The original text is preserved below the corrections section; nothing was deleted.

---

## Findings

### CRITICAL

**C-R1 — C-N1 half A2 is not closed: `sdd-tasks` / `sdd-apply` compose still fails in any
deployment without a gitignored, externally-generated `.atl/skill-registry.md`, with no
generator, no fallback, and no diagnostic.**

`src/bootstrap/index.ts:252` wires
`skillResolver: createSkillRegistryResolver(directory || process.cwd())`.
`src/infrastructure/skills/skill-registry-resolver.adapter.ts:25` fixes the path to
`<projectRoot>/.atl/skill-registry.md` and `:28-32` returns `null` on **any** read failure.
`STATIC_PHASE_SKILLS_MAP` (`src/domain/sdd/prompt-composition.ts:60-61`) makes
`work-unit-commits` / `chained-pr` mandatory for `sdd-tasks` and `work-unit-commits` for
`sdd-apply`, and `src/application/sdd/prompt-composition.ts:85-88` throws on the first
`null`.

Independently established facts:

- `.gitignore:43` is `/.atl/`; `git check-ignore -v .atl/skill-registry.md` returns
  `.gitignore:43:/.atl/` for `.atl/skill-registry.md`; `git ls-files .atl` is empty.
- `.atl/` **does not exist** in this worktree; it exists only in the developer's main
  checkout (102 lines, containing `work-unit-commits` at line 91 and `chained-pr` at
  line 31).
- A repo-wide search for `skill-registry` matches **only** the three new files, the apply
  log, `tsconfig.test.json`, and `src/bootstrap/index.ts`. **Nothing in this repository
  generates the registry.** `gentle-ai` is an *external* binary
  (`/c/Users/aabad/scoop/shims/gentle-ai`) — the apply log's claim that `.atl/` is
  "regenerated per-checkout by gentle-ai skill-registry refresh" describes a tool outside
  this codebase and outside its dependency graph.
- Probe **P5**: with the registry present, compose succeeds. Probe **P6**: with it absent,
  compose throws.

So the defect changed shape rather than disappearing: from "always fails everywhere" to
"works on the author's machine, fails on a fresh clone, CI, container, or worktree —
silently, with an error message that never mentions the registry." This is a published
package (`package.json` ships only `dist/`). Two of eight phases are unusable out of the
box. **PARTIALLY CLOSED, not CLOSED.**

*What a correct fix requires:*

1. Resolve the registry against the **per-call `args.projectRoot`**, not the startup
   directory (see W-N1).
2. Make the registry a **declared, enforceable contract**: commit a registry or a
   checked-in default, or add a bootstrap / `sdd_status` readiness check that reports the
   expected absolute path and how to produce it.
3. Make `UnresolvableSkillError` carry the **registry path and the reason** (file missing
   vs. name absent) so the failure is actionable.
4. Add an integration test that composes `sdd-tasks` **successfully** through the real
   `createSkillRegistryResolver` at the tool boundary, plus one asserting the
   registry-missing diagnostic.
5. Settle the design ambiguity upstream in section 5.1 instead of leaving an invented
   policy in code comments.

*On whether parsing a gitignored local markdown file is the right source at all:* the
implementation is **defensible as an interim narrowest reading** — design section 5.1
(`docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md:417-419`) says only
"resolved to absolute paths against the project's skill registry at compose time", the
ambiguity is flagged in three places (module header, commit message, apply log), and
crucially it **does not fabricate paths**, so PC-6 stays reachable. But it is **not a
settled contract**: it makes a shipped production code path depend on an artifact that git
does not carry, this repo does not produce, and no spec names. The repo's only mention of
`.atl` outside the new code is `.gitignore:43`. Treat it as provisional pending design
sign-off — it should not be recorded as closing C-N1.

### WARNING

**W-N1 — The resolver is bound to the plugin's startup directory, contradicting the
documented per-call invariant, with no test coverage.**
`src/bootstrap/sdd-tools.ts:120-125` states verbatim: "`projectRoot` arrives per-call from
the tool's `context.directory` so each invocation is namespaced by the session's actual
project, **not a startup-time capture**." `src/bootstrap/index.ts:252` passes
`createSkillRegistryResolver(directory || process.cwd())`, where `directory` is captured
once at `:166`. Every SDD tool still takes `projectRoot` per call (`sdd-tools.ts:223`), so
a compose for project B executed by a plugin started in project A resolves skills against
**A's** registry. This is a newly-introduced violation of an invariant documented in the
same module, and no test covers it. The fail mode is usually closed (unresolvable, throw,
lock released), but a startup-root registry that *does* contain the name yields a
project-scope path from the wrong project.

**W-N2 — Best-effort lock release swallows every error silently; a transient store failure
still leaks the lock with no signal.**
`src/bootstrap/sdd-tools.ts:391-401` and `:403-413` wrap each release in an empty catch
with **no logging**. The comment at `:387-390` justifies this with "if it itself fails ...
the lock is no longer ours to leak either way" — true for the concurrent-reclaim case, but
**not** for a transient failure (SQLITE_BUSY_SNAPSHOT per still-open W-2, a closed client,
an OCC mismatch). In that case the lock **is** still ours, **is** still held, and the
operator gets no indication at all — they see only the original `UNRESOLVABLE_SKILL` and
must guess to run `sdd_recover_phase_lock`. Note also that `ownerTokens.delete(ownerKey)`
at `:398` sits *inside* the try, after the await, so a throwing release also leaves the
in-memory token behind.

**W-N3 — Resolved skill paths are never checked for readability, though the error message
promises "a readable path".**
`src/domain/sdd/prompt-composition.ts:12` emits
`UNRESOLVABLE_SKILL: mapped skill "X" could not be resolved to a readable path`, but
`src/infrastructure/skills/skill-registry-resolver.adapter.ts:33` returns the registry's
Path cell verbatim and `src/application/sdd/prompt-composition.ts:86` only tests
truthiness. A stale registry row pointing at a deleted SKILL.md therefore injects a dead
absolute path into the composed prompt — a weaker form of exactly the fabricated-path
defect PC-6 exists to prevent, displaced one layer out.

**W-N4 — The C-N2 correction introduces a new false commit attribution.**
`docs/superpowers/specs/2026-08-03-sdd-phase-agents-remediation-APPLY.md` correction item 2
(and its inline pointer at line 133) states `tsconfig.test.json` "is touched by that same
commit's diff (`d072168`) and again by `db8e67a`".
`git show --name-only --format="" d072168` returns exactly three paths —
`src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.ts`,
`tests/_helpers/sqlite-mcp-tool-client-occ-worker.ts`,
`tests/sqlite-mcp-tool-client-occ.test.ts` — and
`git log d10b292..f9c2534 -- tsconfig.test.json` returns **`db8e67a` only**. The
correction's *conclusion* (the file was modified; the original "untouched" claim was false)
is right; the *provenance detail* is wrong. In a section whose entire purpose is provenance
accuracy, this must be fixed.

**W-N5 — The rmSync EPERM masking was diagnosed but left unfixed, so the A1 regression
guard reports a misleading error on revert.**
Probe P2 (revert, unmodified suite) fails with an EPERM permission error on the temp
directory raised from `tests/sdd-tools.integration.test.ts:1224` — the finally block's
`rmSync(tempDir, ...)`. The real assertion is only visible once that rmSync is guarded
(P3). Root cause is test hygiene, not the product: `noResolverClient.close()` sits at the
*end* of the scenario (`:1219`), so any assertion failure before it leaves an open SQLite
handle and Windows refuses the directory removal. The suite still goes non-zero, so the
guard *works* — but a future engineer reverting the fix will see a filesystem error, not
"the durable lock ... does not survive the throw".
Relatedly, the round-2 log's claim that the masking "is itself a side effect of the same
bug (an unreleased lock keeps a SQLite handle referenced in a code path that never reaches
close)" is **inaccurate**: *any* assertion failure anywhere before a client close produces
the identical EPERM; it has nothing to do with lock state.

**W-N6 — No committed test exercises the mandatory-skill happy path through the production
resolver.** `sdd-tasks` appears exactly once in `tests/sdd-tools.integration.test.ts`
(`:1187`), in the *negative* scenario; the 7 `sdd-apply` composes use the fabricated
fixture resolver. This is a residue of the same "tests pass because the fixture is not the
production wiring" class the prior report raised as C-N1 — narrowed, not eliminated.

**W-N7 — The round-2 apply log misdiagnoses `tests/bootstrap-clean-startup.test.ts`.**
The log (lines 236-245) asserts the failure "stems from the Prisma bootstrap client closing
before the async PRAGMA call resolves". The actual assertion (P7/P8/P9) is
"bootstrap must not register the obsolete config staging hook", with an unexpected `tool`
key in the returned hook set — i.e. the SDD tool surface registration
(`src/bootstrap/index.ts:244+`), which is present as far back as `d10b292`. The
CLIENT_CLOSED PRAGMA line is unrelated log noise. The log's *conclusion* (pre-existing, not
a regression) is **correct and independently confirmed**, and is in fact *stronger* than
claimed — it predates the entire remediation, not just round 2. Only the causal explanation
is wrong.

### SUGGESTION

1. Clear the persisted `baselineFingerprint` (written at `src/bootstrap/sdd-tools.ts:348-353`
   before compose) when the compose-failure path releases the lock. It is currently
   overwritten by the next compose, so it is benign today — but it is residual state from a
   dispatch that never happened.
2. Close `noResolverClient` (and every per-scenario client) in a finally, and guard the
   suite-level rmSync, so assertion failures are never masked on Windows (W-N5).
3. Print per-case `pass:` lines in `tests/sdd-tools.integration.test.ts` — still the only
   SDD suite that emits a single summary line for 100+ assertions (prior W-5, unaddressed).
4. Fix the stale docstring at `src/bootstrap/sdd-tools.ts:121` — "Builds the **seven** SDD
   tools" while the module header and `src/bootstrap/index.ts:261` both say eight. This was
   SUGGESTION 5 of the prior report and is still unaddressed.
5. Commit tests separately from implementation so RED is corroborated by git rather than by
   narration. Both round-2 commits still bundle test with implementation.
6. Never delete a RED artifact before commit. If a scratch reproduction is genuinely needed,
   commit it (even temporarily) or paste it verbatim into the log so it is auditable.

---

## Out of scope this round — restated as STILL OPEN

None of the following were verified or remediated here. All remain open and block a clean
archive of the parent change.

- **W-1** — `ownerTokens` is a process-wide Map (`src/bootstrap/sdd-tools.ts:129`,
  `:146-147`); displacement protection does not hold intra-process, which is the production
  topology (`src/bootstrap/index.ts` creates exactly one surface).
- **W-2** — `runInTransactionSync` uses a deferred BEGIN, not BEGIN IMMEDIATE
  (`src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.ts:165`); the read-to-write
  upgrade can return SQLITE_BUSY_SNAPSHOT, which busy_timeout does not retry.
- **W-3** — `PhaseAlreadyInFlightError` (SPEC DL-2) is never raised at the tool boundary;
  `src/bootstrap/sdd-tools.ts:376` still hardcodes `currentInFlightPhase: null`, so
  `acquireDispatchLock` remains dead on the production path.
- **W-4** — `sdd_parse_request` still has no projectRoot, no gateway service and no timeout;
  `sdd_init_questions` still takes caller-supplied file contents (EF-4 runtime path).
- **W-5** — `tests/sdd-tools.integration.test.ts` remains unobservable (header plus one
  summary line for 100+ assertions).
- **SS-8 / C-5** — the live persistence backend is still `new SqliteMcpToolClient()`
  (`src/bootstrap/index.ts:241`), the private memories schema, not the specified
  agent-memory MCP tool path.
- **CP-16 / CP-17** — application-layer checkpoint optimistic concurrency
  (`src/application/sdd/checkpoint.ts` read-modify-write) is untouched; the SQLite fix
  addressed the storage primitive only.
- **EF-4** — the semantic-gateway timeout is not on the runtime tool path.
- **SS-10** — read-back on real checkpoint write paths.
- **RT-13** — status/routing disagreement on unresolved CRITICAL findings.
- **Strict-TDD evidence for the 131 historical parent-change tasks — 0/131**, explicitly not
  claimed by either apply log and untouched by this round.

`tests/bun-readiness.test.ts` (missing untracked fixture) and `npm run test:model-routes`
(generated `.opencode/agents/sdd-mr-v1-*.md`) remain excluded as environmental.

---

## Final verdict

**FAIL — do not archive.**

Round 2 did real, honest work. **C-N1 A1 is CLOSED and I proved it independently** by
reverting the fix and watching the committed test fail with the exact expected assertion,
then watching the triangulation assertion fail too — the strongest evidence produced in
either round. **C-N2 is CLOSED**; every corrected provenance fact re-checks against git,
with one new attribution error (W-N4). The round-2 log is markedly more honest than
round 1's: it labels its one untested wiring line as untested, flags its design ambiguity in
three places, and its gate table matched my independent runs on every row.

Archive is blocked by:

- **C-R1** — C-N1 A2 is only PARTIALLY CLOSED; `sdd-tasks` / `sdd-apply` still cannot
  compose on any checkout lacking a gitignored file this repo does not produce, with no
  diagnostic.
- **W-N1** — a newly-introduced violation of the module's own documented per-call
  invariant, untested.
- **C-N3** — PARTIALLY CLOSED: A1's log-side RED is unauditable (deleted artifact), the
  mandatory-skill happy path is untested, and round 1's five mislabelled tasks were
  relabelled rather than re-evidenced.
- Eleven out-of-scope items that remain open, including **0/131** historical Strict-TDD
  evidence.

**Next recommended phase: `sdd-apply`** — close C-R1 (per-call registry root, declared
contract or checked-in fallback, actionable diagnostic, happy-path integration test), then
W-N1, W-N4 and W-N5. A fresh independent Strict-TDD verification should follow before any
archive attempt.

No production or test file in this worktree was modified during this verification. All
revert and injection probes ran against throwaway `git archive` copies in the session
scratchpad. `git status --porcelain` at the end of this run shows exactly one entry:
`docs/superpowers/specs/2026-08-04-sdd-phase-agents-remediation-2-VERIFY-c18cdd4.md`.
