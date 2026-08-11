# SDD Phase Agents — Remediation Round 2 APPLY Log

**Change**: `sdd-phase-agents-remediation-1`
**Worktree**: `C:\Users\aabad\Documents\CODE\ia\sdd-plugin2\.worktrees\sdd-phase-agents-remediation-1`
**Branch**: `feat/sdd-phase-agents-remediation-1`
**Base of this round**: `35fda35` (the independent verification target)
**Mode**: Strict TDD, scoped to CRITICAL **C-N1** only (the two defects it
names) plus the truthfulness fix on the round-1 apply log (**C-N2**).
**Date**: 2026-08-04

**Scope discipline**: this round implements exactly two production tasks
(A1, A2) and one documentation task (B). It does NOT touch WARNING W-1
through W-5, SS-8, CP-16/CP-17, EF-4, SS-10, RT-13, or
`tests/bun-readiness.test.ts` — all deliberately deferred per the user's
instruction, unchanged in this round's diff.

---

## Source of the tasks

`docs/superpowers/specs/2026-08-04-sdd-phase-agents-remediation-VERIFY-f9c2534.md`,
finding **C-N1**: `sdd_compose_phase_prompt` was unusable in production for
`sdd-tasks`/`sdd-apply` (no `skillResolver` injected at bootstrap → every
mapped skill unresolvable → `UnresolvableSkillError` on every real compose
for those two phases), and every such failure durably leaked the
change-state lock it had just acquired (no `try/catch` around the
`composePhasePrompt` call, which ran after the lock acquire and the
baseline-fingerprint persist).

Two distinct defects, remediated as two separate RED→GREEN cycles below
(A1, A2), per the task instruction.

---

## A1 — lock must not leak on compose failure

### Where the leak lived
`src/bootstrap/sdd-tools.ts`, `sdd_compose_phase_prompt`'s `execute`:
`deps.changeStateStore.acquireChangeStateLock(...)` (lock acquired) →
`deps.changeStateStore.updateOwnedChangeState(...)` (baseline fingerprint
persisted under that lock) → `composePhasePrompt(...)` called with **no**
`try/catch**`. A throw from composition propagated straight out of
`execute()`, leaving the durable lock held.

### RED — directly observed

Written first, extending `tests/sdd-tools.integration.test.ts` per the
task instruction (existing patterns: real `SqliteMcpToolClient` +
`PmcSddArtifactStoreAdapter`, `invoke()` helper calling the registered tool
definition's `execute()`). The scenario builds `buildSddTools` with **no**
`skillResolver` (reproducing the real `src/bootstrap/index.ts` gap),
composes `sdd-tasks` (a phase with mandatory skills), and asserts the
durable lock does not survive the throw.

Because the assertion failure inside the shared `runTests()` try/finally
was, on this Windows machine, itself masked by a **second, unrelated**
failure (`rmSync` `EPERM` on the temp directory — caused by an open SQLite
handle from the very assertion path that hadn't reached `.close()` yet), a
minimal standalone reproduction (`tests/_scratch-repro-cn1.ts`, deleted
before commit, not part of the delivered diff) was used to capture the
underlying RED cleanly before implementing the fix:

```
compose threw (expected): UNRESOLVABLE_SKILL: mapped skill "work-unit-commits" could not be resolved to a readable path
stateAfterFailedCompose.lock = {"phase":"sdd-tasks"}
ASSERTION FAILED (this is the expected RED before the fix): the durable lock must not survive the throw
+ actual - expected

+ {
+   phase: 'sdd-tasks'
+ }
- undefined
```

This is genuine RED: the compose call throws as designed by the existing
PC-6 default resolver, and the durable lock (`{"phase":"sdd-tasks"}`) is
provably still held afterward — exactly the defect C-N1 describes.

The full extended `tests/sdd-tools.integration.test.ts` run at this point
exits non-zero via the masking `EPERM`, not a clean assertion failure
message; the standalone reproduction above is what was directly observed
as the true RED. This masking behavior is itself informative: it is a side
effect of the same bug (an unreleased lock keeps a SQLite handle referenced
in a code path that never reaches `.close()`), not a flaw in the test
design.

### GREEN — directly observed

Fix: wrap the `composePhasePrompt` call in `try/catch`; on any throw,
best-effort release the change-state lock (and the project-init sentinel,
if one was acquired for `sdd-init`) via `releaseChangeStateLock`, delete
the in-memory owner-token entries, and rethrow the original error (never a
secondary release failure).

Standalone reproduction after the fix:

```
compose threw (expected): UNRESOLVABLE_SKILL: mapped skill "work-unit-commits" could not be resolved to a readable path
stateAfterFailedCompose.lock = undefined
ASSERTION PASSED: lock released
```

Full extended suite, run via `npx tsx tests/sdd-tools.integration.test.ts`:

```
--- sdd-tools integration (Task 3, RED-first) ---
All sdd-tools integration tests passed.
```
Exit code: `0`.

### Triangulation
- The new scenario also asserts a **second** compose call, for a
  **different** phase (`sdd-explore`, no mandatory skills) on the **same**
  change, succeeds without invoking `sdd_recover_phase_lock` — this is
  what distinguishes a genuine release from the pre-existing passive
  same-phase reclaim (DL-6), which would only have kept re-acquiring the
  same stuck `sdd-tasks` phase forever without ever unblocking a phase
  switch.
- Ran through the real `PmcSddArtifactStoreAdapter` + `SqliteMcpToolClient`
  boundary against a real SQLite file, not a hand-built state literal.
- Full `tests/sdd-tools.integration.test.ts` (all pre-existing scenarios
  plus the new one) passes: `0` exit, `All sdd-tools integration tests
  passed.`

### Safety net (regression check)
Reverting the `try/catch` (manually re-inspected, not re-run as a separate
command in this log) restores the exact RED behavior captured above,
because the fix is additive around the existing call and removes no
production branch; the reproduction script's RED/GREEN pair before/after
the same one-hunk edit is the regression evidence.

### Files touched
- `src/bootstrap/sdd-tools.ts` — `try/catch` around `composePhasePrompt`
  in `sdd_compose_phase_prompt`.
- `tests/sdd-tools.integration.test.ts` — new scenario (see above).

### Commit
`1f8b111 fix(sdd): release the dispatch lock when compose fails after acquiring it (C-N1a)`

---

## A2 — bootstrap must inject a real skill resolver

### Investigation before implementing
Searched for the canonical intended contract before writing any code:
- `docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md` §5.1
  (lines 417-418): mapped skill names are "resolved to absolute paths
  against the project's skill registry at compose time." The design does
  **not** specify the registry's file location or table format — only
  that one exists and that resolution happens against it.
- `docs/superpowers/specs/2026-08-02-sdd-phase-agents-TASKS.md:177` (PC-6):
  "an unresolvable mapped skill fails composition" — must stay reachable.
- `src/application/sdd/prompt-composition.ts` PC-6 comment: the prior
  default resolver "fabricated `/skills/${name}`, which made the throw
  branch unreachable in production" — the fix must NOT reintroduce that.
- The task instruction itself names `.atl/skill-registry.md` as the
  registry this repository actually uses, mapping skill name → absolute
  `SKILL.md` path. Confirmed present in the **main repo**
  (`C:\Users\aabad\Documents\CODE\ia\sdd-plugin2\.atl\skill-registry.md`,
  a real 96-line file with a "Skill | Trigger / description | Scope |
  Path" table) and **absent from this worktree** (`.atl/` does not exist
  under `.worktrees\sdd-phase-agents-remediation-1`; confirmed via a
  directory listing before writing any code) — `.atl/` is a local,
  gitignored artifact regenerated per-checkout by `gentle-ai
  skill-registry refresh`, not a committed file.

### Ambiguity — flagged, not silently resolved
The design does not pin down the registry's file location or exact
markdown shape. This is a genuine ambiguity, not something the SPEC
settles. **Resolution implemented (narrowest reading that satisfies the
stated PC-6 scenario):** parse the `.atl/skill-registry.md` markdown-table
convention this repository's own registry file actually uses (documented
by that file's own "Loading protocol" section), located at
`<projectRoot>/.atl/skill-registry.md`. Return `null` — never a fabricated
path — for any skill name absent from the table, **and** for the entire
registry when the file cannot be read at all (this worktree's actual
state). This is a deliberate design decision presented here as exactly
that, not as settled upstream design: another reasonable reading (e.g.
resolving against `~/.claude/skills`-style user-scope directories directly,
or against the process's `cwd` rather than the tool's `projectRoot`) was
not implemented and would need product/design sign-off if the current
choice proves wrong in practice.

### RED — directly observed
`tests/sdd-skill-registry.test.ts` was written first, importing
`resolveSkillPathFromRegistry` from a not-yet-created
`src/domain/sdd/skill-registry.ts` and `createSkillRegistryResolver` from a
not-yet-created `src/infrastructure/skills/skill-registry-resolver.adapter.ts`:

```
node:internal/modules/esm/resolve:271
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\aabad\Documents\CODE\ia\sdd-plugin2\.worktrees\sdd-phase-agents-remediation-1\src\domain\sdd\skill-registry.js' imported from ...\tests\sdd-skill-registry.test.ts
```
Exit code: `1`. This is a genuine "test errored because the feature does
not exist yet" RED for a brand-new module — there was nothing pre-existing
to regress against.

### GREEN — directly observed
After implementing `src/domain/sdd/skill-registry.ts` (pure markdown-table
parser: last-cell/first-cell backtick extraction, header/separator rows
skipped because their name cell never matches the backtick pattern) and
`src/infrastructure/skills/skill-registry-resolver.adapter.ts`
(fs-backed wrapper, `readFileSync` per call, returns `null` on any read
failure):

```
--- sdd-skill-registry (C-N1 remediation, RED-first) ---
  pass: resolves a known skill name from the registry table
  pass: resolves a second known skill name from the registry table
  pass: an unmapped skill name resolves to null (PC-6 stays reachable)
  pass: the table header/separator rows are not misparsed as skill entries
  pass: fs-backed resolver reads a real .atl/skill-registry.md and resolves a known name
  pass: fs-backed resolver returns null for an unmapped name
  pass: a missing registry file resolves to null instead of throwing
All sdd-skill-registry tests passed.
```
Exit code: `0`.

### Bootstrap wiring — NOT independently RED/GREEN tested (stated plainly)
`src/bootstrap/index.ts` now calls
`buildSddTools({ store, changeStateStore, skillResolver:
createSkillRegistryResolver(directory || process.cwd()) })`. This one-line
change was **not** exercised by a dedicated RED→GREEN cycle: doing so
end-to-end requires a full `SddPlugin()` invocation with a working
`SqliteMcpToolClient` (real SQLite schema, env vars, Prisma bootstrap),
which the existing `tests/bootstrap-clean-startup.test.ts` demonstrates is
substantial setup, disproportionate to one DI wiring line for this scoped
round. What WAS directly observed instead:
- `npm run build` — exit `0` (compiles, including the new import).
- `npx tsc --project tsconfig.test.json --noEmit` — exit `0`.
- Source inspection of the final `src/bootstrap/index.ts` diff (below).
- `tests/bootstrap-clean-startup.test.ts` was run before and after this
  change to check for regression: it **fails identically both before and
  after**, confirmed by checking out the pre-remediation `src/bootstrap/*`
  files at `35fda35` into the working tree and re-running the same test —
  same `AssertionError` (`bootstrap must not register the obsolete config
  staging hook`, actual includes an unexpected `'tool'` key), same
  location. This is a **pre-existing environmental failure unrelated to
  this round's changes**, not a regression introduced
  here, and it is **not** one of the mandated gates for this round.

  **CORRECTION 2026-08-04 (W-N7): the *conclusion* above (pre-existing, not
  a regression) stands, but the *diagnosis* this log originally gave —
  "it stems from the Prisma bootstrap client closing before the async
  PRAGMA call resolves in this test's temp-dir setup" — was wrong. The
  real cause is the unexpected `'tool'` hook key that SDD tool-surface
  registration adds to the bootstrap result, which this test's assertion
  does not expect; the failure reproduces byte-identically at `d10b292`,
  older than this log claimed. The original (wrong) sentence is preserved
  below struck through, per the in-place correction rule:**
  ~~(it stems from the Prisma bootstrap client closing before the async
  PRAGMA call resolves in this test's temp-dir setup, independent of
  `skillResolver`)~~
This is reported here as **not directly observed** for the wiring line
itself, per the instruction to label unobserved cycles honestly.

### Files touched
- `src/domain/sdd/skill-registry.ts` (new)
- `src/infrastructure/skills/skill-registry-resolver.adapter.ts` (new)
- `src/bootstrap/index.ts` (modified — resolver wired at `buildSddTools`)
- `tsconfig.test.json` (modified — registers the new test file)
- `tests/sdd-skill-registry.test.ts` (new)

### Commit
`e049eb2 fix(sdd): wire a real skill resolver into the SDD bootstrap (C-N1b)`

---

## B — apply log truthfulness

`docs/superpowers/specs/2026-08-03-sdd-phase-agents-remediation-APPLY.md`
was corrected **in place**, with a new "CORRECTIONS — added 2026-08-04"
section at the top naming every false statement C-N2 identified, each
re-verified directly against `git log`/`git diff` before being written
(not merely copied from the verification report), plus inline
`**CORRECTED, see CORRECTIONS above**` pointers at each false statement's
original location (the "NO COMMITS MADE" header line, the "Mode" line, the
"prior work, NOT touched" table rows for
`sqlite-mcp-tool-client.adapter.ts` / `tsconfig.test.json` /
`tests/sqlite-mcp-tool-client-occ.test.ts` / `tests/_helpers/`, the five
mislabelled "RED → GREEN (directly observed)" task headers for tasks 6, 7,
11, 12, 13, the Task 3 RED heading, and the self-review section). The
original document text is preserved below the corrections section, per the
"do not silently rewrite history" instruction — nothing was deleted.

This document (the round-2 apply log you are reading) is the new,
from-scratch record for THIS round's two production tasks; the round-1
document remains the historical record for round-1's tasks, now truthfully
annotated.

### Files touched
- `docs/superpowers/specs/2026-08-03-sdd-phase-agents-remediation-APPLY.md`
  (corrected in place)
- `docs/superpowers/specs/2026-08-04-sdd-phase-agents-remediation-2-APPLY.md`
  (this document, new)

---

## Gate status — directly observed, this round's final HEAD

| Command | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | `tsc` clean, `tsup` — "Build success in 78ms". |
| `npm run test:typecheck:strict` (`tsc --project tsconfig.test.json --noEmit`) | 0 | clean. |
| `npm run test:typecheck:persistence` (`tsc --project tsconfig.persistence-tests.json --noEmit`) | 0 | clean. |
| `node scripts/run-persistence-tests.mjs` | 1 | 33 declared / 33 reached / **32 passed / 1 failed** — only `tests/bun-readiness.test.ts` (pre-existing, out of scope, confirmed unrelated to this round's diff). |
| `npx tsx tests/sdd-tools.integration.test.ts` | 0 | `All sdd-tools integration tests passed.` (includes the new A1 scenario.) |
| `npx tsx tests/sdd-artifact-store.test.ts` | 0 | `All sdd-artifact-store tests passed.` |
| `npx tsx tests/sdd-change-state.test.ts` | 0 | `All sdd-change-state tests passed.` |
| `npx tsx tests/sdd-checkpoint-use-case.test.ts` | 0 | `All sdd-checkpoint tests passed successfully!` |
| `npx tsx tests/sdd-discovery-status.test.ts` | 0 | `All sdd-discovery-status tests passed.` |
| `npx tsx tests/sdd-dispatch-lock.test.ts` | 0 | `All sdd-dispatch-lock tests passed.` |
| `npx tsx tests/sdd-entry-flow.test.ts` | 0 | last line: `pass: EF-21 health probe overwrites single fixed key without accumulating` |
| `npx tsx tests/sdd-executor-contract.test.ts` | 0 | `All WU11 sdd-executor-contract tests passed!` |
| `npx tsx tests/sdd-init-round.test.ts` | 0 | `All 13 sdd-init-round (WU6) tests passed successfully!` |
| `npx tsx tests/sdd-keys.test.ts` | 0 | `All sdd-keys tests passed.` |
| `npx tsx tests/sdd-project-identity.test.ts` | 0 | `All sdd-project-identity tests passed.` |
| `npx tsx tests/sdd-prompt-composition.test.ts` | 0 | `All 10 sdd-prompt-composition (WU7) tests passed successfully!` |
| `npx tsx tests/sdd-routing.test.ts` | 0 | `All sdd-routing tests passed.` |
| `npx tsx tests/sdd-semantic-gateway.test.ts` | 0 | `All sdd-semantic-gateway tests passed.` |
| `npx tsx tests/sdd-skill-registry.test.ts` | 0 | `All sdd-skill-registry tests passed.` (new, A2). |
| `npx tsx tests/sdd-status-schema.test.ts` | 0 | `All sdd-status-schema tests passed.` |
| `npx tsx tests/sdd-worktree-fingerprint.test.ts` | 0 | `All 10 sdd-worktree-fingerprint (WU8) tests passed successfully!` |

**17/17 `tests/sdd-*.test.ts` suites pass** (16 pre-existing + 1 new:
`sdd-skill-registry.test.ts`). Only known failure across every gate is
`tests/bun-readiness.test.ts` (pre-existing, environmental, explicitly out
of scope per the task instruction).

### Model-routing zero-diff (out of scope, verified)
```
git diff --stat d10b292..HEAD -- src/domain/model-routing src/infrastructure/opencode "src/cli/model-route-*.ts" "tests/model-route-*" "tests/natural-model-*"
```
Empty output — zero diff across the full remediation (round 1 + round 2)
relative to the `d10b292` baseline.

### Out-of-scope items confirmed untouched (per the task instruction)
- WARNING W-1 through W-5 — unchanged (no edits to `ownerTokens` sharding,
  `BEGIN`/`BEGIN IMMEDIATE`, `PhaseAlreadyInFlightError`, `sdd_parse_request`
  gateway wiring, or the integration suite's per-case logging).
- SS-8 (SqliteMcpToolClient vs the real agent-memory MCP path) — untouched.
- CP-16/CP-17, EF-4, SS-10, RT-13 — untouched.
- `tests/bun-readiness.test.ts` — untouched, failure unrelated (missing
  `opencode-models.test.db` fixture, confirmed pre-existing at `35fda35`
  before this round's changes as well as in round 1's own log).
- `docs/superpowers/specs/2026-08-04-sdd-phase-agents-remediation-VERIFY-f9c2534.md`
  and `docs/superpowers/specs/2026-08-03-sdd-phase-agents-VERIFY-fresh-d10b292.md`
  — not edited.

---

## Self-review

- A1 has a genuine RED→GREEN cycle with directly observed command output
  (via a standalone reproduction, because the full integration suite's
  RED-state failure was masked by an unrelated Windows `EPERM` cleanup
  error, itself explained above — a masking artifact, not fabricated
  evidence).
- A2's domain/infra split has a genuine RED→GREEN cycle (module-not-found
  → all assertions pass). The one-line bootstrap wiring itself is
  explicitly labelled **not independently RED/GREEN tested**, with the
  reasoning stated, rather than claimed as observed.
- Design ambiguity on the skill-registry contract is flagged in this
  document, in the new source files' header comments, and in the commit
  message — not silently resolved and presented as settled.
- Round-1's apply log is corrected in place with a dedicated corrections
  section and inline pointers; nothing was deleted.
- Every command in the Gate Status table above was executed in this
  session at the current HEAD before this document was written; none are
  copied from the round-1 log or the verification report.
- Zero model-routing diff confirmed against the `d10b292` baseline, not
  just against round 1's HEAD.
