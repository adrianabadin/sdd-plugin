# Handoff — SDD Phase Agents: skill resolver blocker (C-R1) and open findings

**Written:** 2026-08-04
**For:** the next agent picking up `feat/sdd-phase-agents-remediation-1`
**Status of the change:** FAIL — not archivable. Blocked on one design decision, not on missing implementation effort.

Read this document first. It is self-contained: it tells you where the work is, what is genuinely closed (do not redo it), what is open, and what the one blocking decision is. Every claim below is labelled by how it was established.

Evidence labels used throughout:
- **[verified]** — the orchestrator re-ran the command or read the source itself.
- **[report]** — established by an independent verification agent and recorded in a committed report; not personally re-checked.
- **[claim]** — asserted by an apply log and NOT independently confirmed. Treat as a hypothesis.

---

## 1. Where the work is

| | |
|---|---|
| Repo | `C:\Users\aabad\Documents\CODE\ia\sdd-plugin2` |
| Worktree (all work lives here) | `C:\Users\aabad\Documents\CODE\ia\sdd-plugin2\.worktrees\sdd-phase-agents-remediation-1` |
| Branch | `feat/sdd-phase-agents-remediation-1` |
| HEAD | `a5a7815` |
| Base | `d10b292` (`feat/sdd-phase-agents`) |
| Tree | clean **[verified]** |
| Pushed / PR | no, and no — everything is local **[verified]** |

12 commits on top of `d10b292`, in order:

```
8265eb6  chore(sdd): pre-existing working-tree state carried into this branch
d072168  fix(pmc): make SqliteMcpToolClient OCC writes atomic, add sync transaction primitives
a57cf3e  feat(sdd): durable change-state lock recovery, ownership verification, atomic artifact persist
2ad4a69  feat(sdd): add sdd_recover_phase_lock (8th MCP tool) and wire ownership checks into bootstrap
aeb575e  test(sdd): propagate persistArtifactWithOwnership stub across existing store fakes
db8e67a  test(sdd): register new persistence-gate test files in runner and strict tsconfig
f9c2534  docs(sdd): add remediation APPLY log
35fda35  docs(sdd): add fresh independent verification report for f9c2534   <- FAIL #1
1f8b111  fix(sdd): release the dispatch lock when compose fails (C-N1a)
e049eb2  fix(sdd): wire a real skill resolver into the SDD bootstrap (C-N1b)
c18cdd4  docs(sdd): correct the round-1 apply log in place and add round-2 apply log
a5a7815  docs(sdd): add round-2 verification report for c18cdd4            <- FAIL #2
```

### Artifact index

| Document (paths relative to the worktree) | What it is |
|---|---|
| `docs/superpowers/specs/2026-08-03-sdd-phase-agents-VERIFY-fresh-d10b292.md` | Verification of the parent change. FAIL, 5 CRITICAL. The original baseline. |
| `docs/superpowers/specs/2026-08-03-sdd-phase-agents-remediation-APPLY.md` | Round-1 apply log. **Contained false statements**; corrected in place, see its `CORRECTIONS` section. |
| `docs/superpowers/specs/2026-08-04-sdd-phase-agents-remediation-VERIFY-f9c2534.md` | Verification round 1. FAIL, 3 new CRITICAL. |
| `docs/superpowers/specs/2026-08-04-sdd-phase-agents-remediation-2-APPLY.md` | Round-2 apply log (C-N1 + log corrections). |
| `docs/superpowers/specs/2026-08-04-sdd-phase-agents-remediation-2-VERIFY-c18cdd4.md` | Verification round 2, 414 lines. **The most current and authoritative document.** FAIL. |
| `docs/plans/2026-08-03-sdd-phase-agents-remediation-implementation.md` | The original 5-task remediation plan (superseded by events). |

Engram topic `sdd/sdd-phase-agents/verify-report` (observation id 2416) holds the latest verify summary.

---

## 2. THE BLOCKER — C-R1: where does the skill registry come from?

This is a **design/product decision**, not an implementation task. Do not let an apply agent invent an answer; that is how the current half-fix happened.

### The situation

`sdd_compose_phase_prompt` must resolve mandatory skills to absolute paths for two phases:

```
sdd-tasks -> ["work-unit-commits", "chained-pr"]
sdd-apply -> ["work-unit-commits"]
```
(`src/domain/sdd/prompt-composition.ts`) **[verified]**

If any mapped skill resolves to `null`, the domain throws `UnresolvableSkillError`. That throw is deliberate (PC-6): an earlier version fabricated `/skills/${name}` paths, which silently baked bogus paths into prompts. Failing loud is correct.

Commit `e049eb2` wired a resolver at `src/bootstrap/index.ts:252` that parses `<projectRoot>/.atl/skill-registry.md`. **[verified]**

### Why that does not actually work

- `.atl/` is gitignored at `.gitignore:43`, untracked, and absent from the worktree. It exists only in the author's main checkout. **[verified]**
- **No code in this repository generates the registry.** It is produced by `gentle-ai`, an external scoop-installed binary. **[report]**

So a fresh clone, a CI runner, or any other machine has no registry, the resolver returns `null` for every name, and `sdd-tasks` / `sdd-apply` compose still throws. The current state makes the failure *safe* (see §3, A1) and makes success *possible on the author's machine*. It does not make the tool usable in production.

### The decision to make

| Option | What it means | Cost | Risk |
|---|---|---|---|
| **A. Operational precondition** | Keep parsing the registry, but fix the real bug and make the failure diagnosable. Document the registry as a required external artifact. | Small | Gap stays real, but visible and explained rather than hidden. |
| **B. Ship a default registry** | Commit a versioned `.atl/skill-registry.md` (or an equivalent under a non-ignored path) that `gentle-ai` overwrites when present. | Medium | Changes who owns the registry; the committed copy can drift from the external binary's output. |
| **C. Change the resolution source** | Stop depending on a gitignored file from an external binary. Resolve skills from explicit orchestrator injection, or from a declared contract in the project config. | Large — touches design, spec, and several phases | Cleanest long-term; needs a real `sdd-design` phase, not an apply round. |

**No option has been chosen.** The user was asked and chose to produce this handoff instead.

### What a correct fix requires (applies to A, B and C alike) — **[report]**

1. Bind the resolver to the **per-call** `args.projectRoot`, not the startup `directory`. See W-N1 in §4 — this is an outright bug against the module's own documented invariant, and it should be fixed regardless of which option is chosen.
2. Give `UnresolvableSkillError` the registry path and the reason (missing file / unreadable / name absent), so the failure is diagnosable instead of opaque.
3. Add a declared, enforced registry contract — either a committed default or an explicit bootstrap readiness check that surfaces "registry missing" clearly at startup.
4. Add an integration test for the **happy path**: mandatory-skill resolution through the real resolver at the registered tool boundary. Today only the failure path is covered (W-N6).

---

## 3. Genuinely closed — do NOT redo

| Item | Status | Evidence |
|---|---|---|
| **C-2** — MCP tools were a hollow boundary over correct helpers | CLOSED | 8 tools registered and returned; `sdd_status` has a real discovery branch and reads `inFlightPhase` from durable state, so crashed locks are visible; the integration test calls `definition.execute()`. **[report]** |
| **C-3** — WF-3 fingerprint existed only below the tool boundary | CLOSED | Captured, persisted, returned, and recomputed at save with fail-closed comparison. **[report]** |
| **C-4** — checkpoint OCC not atomic in real SQLite | CLOSED | Single conditional `UPDATE … WHERE id=? AND version=? RETURNING`; the test spawns **two OS processes** with a filesystem rendezvous. **[report]** |
| **C-N1 / A1** — compose leaked a durable lock on failure | CLOSED | `try/catch` at `src/bootstrap/sdd-tools.ts:361-416` releases lock and init sentinel best-effort, then rethrows the original error **[verified]**. The verifier reverted the hunk in a scratch copy and the committed test failed as expected — so a permanent regression guard exists, not a one-off. **[report]** |
| **C-N2** — round-1 apply log contained false statements | CLOSED | `CORRECTIONS` section plus 12 inline pointers, nothing deleted; facts re-checked against `git log` / `git diff`. **[report]**, section header **[verified]**. One new inaccuracy was introduced — see W-N4. |

---

## 4. Open findings

### CRITICAL

**C-R1 — the skill registry is not a guaranteed artifact.** See §2. This is the blocker.

### WARNINGS — the user asked that these be folded into the same round as C-R1

| ID | Finding | Location | Label |
|---|---|---|---|
| **W-N1** | The resolver is bound to the startup `directory`, contradicting the module's own stated invariant. The docstring above `buildSddTools` says `projectRoot` "arrives per-call from the tool's `context.directory` … not a startup-time capture" — and the resolver does exactly the opposite. Clear bug; fix it whichever option §2 takes. | `src/bootstrap/sdd-tools.ts:120-125` vs `src/bootstrap/index.ts:252` | **[verified]** |
| **W-N2** | The lock release in the compose catch block is silent best-effort: if `releaseChangeStateLock` throws, the failure is swallowed with no signal. Intentional (the caller must see the original compose error), but currently unobservable. | `src/bootstrap/sdd-tools.ts:391-401` | **[verified]** |
| **W-N3** | No readability check on the registry file — absent and unreadable are indistinguishable to the caller. | `src/domain/sdd/prompt-composition.ts:12`, `src/infrastructure/skills/skill-registry-resolver.adapter.ts:33` | **[report]** |
| **W-N4** | The round-1 log correction introduced a **new** false attribution: it says `d072168` touched `tsconfig.test.json`. It did not — `db8e67a` and `e049eb2` did. | round-1 APPLY log, line 133 | **[verified]** |
| **W-N5** | Reverting the `try/catch` surfaces first as a misleading `rmSync` EPERM on Windows (an open SQLite handle); the real assertion only appears once the `finally` is guarded. A future regression could be misdiagnosed. | `tests/sdd-tools.integration.test.ts:1224` | **[report]** |
| **W-N6** | No happy-path test for mandatory-skill resolution through the real resolver. Only the failure path is covered. | — | **[report]** |
| **W-N7** | The round-2 apply log misdiagnoses `bootstrap-clean-startup.test.ts`. Its *conclusion* (pre-existing, not a regression) is right; its *diagnosis* is wrong. The real cause is an unexpected `'tool'` hook key from SDD tool-surface registration, not the Prisma PRAGMA. The failure goes back to `d10b292`, older than the log claims. | `tests/bootstrap-clean-startup.test.ts` | **[report]** |
| **W-N8** | The `buildSddTools` docstring still says "the **seven** SDD tools" with eight registered. | `src/bootstrap/sdd-tools.ts:121` | **[verified]** |

Earlier WARNINGs from verification round 1, deliberately deferred by the user and still untouched: **W-1** `ownerTokens` is process-wide and read at save time, so displacement protection fails within a single tool surface — which is the production topology; **W-2** deferred `BEGIN` rather than `BEGIN IMMEDIATE`; **W-3** `PhaseAlreadyInFlightError` never raised at the boundary, `dispatch-lock.ts` dead in production; **W-4** an unremediated baseline warning; **W-5** the integration suite prints one line for 103 assertions. **[report]**

### Strict-TDD evidence — C-N3, PARTIALLY CLOSED

This is a process finding and it matters, because two rounds have now been failed partly on it.

- Round 1: **3 of 12** tasks have genuinely observed RED. 2 narrative, 5 were headed "RED → GREEN (directly observed)" with no RED artifact at all — including task 12, the atomic persist, the highest-stakes change. Round 2 **relabelled** those five honestly but did **not** re-establish RED for them. Still 3/12. **[report]**
- Round 2's own A1 RED was captured with a throwaway script deleted before commit → **not accepted** as standalone evidence, though the claim turned out to be true and is now independently reproducible. **[report]**
- The A2 bootstrap wiring line has no dedicated RED/GREEN cycle; the log admits this and the admission is accurate. **[report]**
- The **131 historical parent tasks remain at 0/131** Strict-TDD evidence. No round has attempted to reconstruct it, and reconstructing it after the fact is not possible. This is a standing archive blocker unless the user explicitly waives it. **[report]**

---

## 5. Out of scope in every round so far — still open

Do not assume these were handled. None were touched.

- **SS-8 / C-5** — the live backend is `SqliteMcpToolClient` opening a private `memories` SQLite schema directly. Its `callTool` names emulate MCP but never reach the external `agent-memory-mcp` server. The spec requires the structured agent-memory MCP tool path. This is the largest remaining architectural gap.
- Deferred parent CRITICALs: **CP-16 / CP-17, EF-4, SS-10, RT-13**.

---

## 6. Gates

Run from inside the worktree.

```
npm run build                          # expect exit 0
npm run test:typecheck:strict          # expect exit 0
npm run test:typecheck:persistence     # expect exit 0
node scripts/run-persistence-tests.mjs # expect exit 1 -> 32/33, see below
npx tsx tests/<each sdd-*.test.ts>     # 17 suites, all exit 0
```

Last full run at `c18cdd4`: build / both typechecks clean, all 17 SDD suites pass, persistence 32/33. **[report]**

### Known pre-existing failures — separate them, never let them excuse a new failure

| Failure | Cause | Verdict |
|---|---|---|
| `tests/bun-readiness.test.ts` | missing `opencode-models.test.db` fixture in this worktree | pre-existing, unrelated |
| `tests/bootstrap-clean-startup.test.ts` | unexpected `'tool'` hook key from SDD tool registration; byte-identical failure at `d10b292`, `35fda35` and `c18cdd4` | pre-existing, NOT a regression **[report]** |
| `npm run test:model-routes` | `tests/model-route-cli.test.ts` requires no generated `sdd-mr-v1-*.md` in `.opencode/agents/`; 13 are present | environmental, out of SDD scope |

---

## 7. Constraints for whoever continues

These held for every round and should keep holding.

1. **Strict TDD is active.** RED first, with output you actually observed and can point at. You will be audited against git history. Two rounds have already failed on manufactured or unauditable evidence — under-claiming is safe, over-claiming is what fails.
2. **Never touch model-routing.** `src/domain/model-routing/`, `src/infrastructure/opencode/`, `src/cli/model-route-*.ts`, `tests/model-route-*`, `tests/natural-model-*`. Verify zero-diff before finishing:
   ```
   git diff --stat d10b292..HEAD -- src/domain/model-routing src/infrastructure/opencode "src/cli/model-route-*.ts" "tests/model-route-*" "tests/natural-model-*"
   ```
   Must be empty. It is empty today. **[verified]**
3. **Do not push, open a PR, merge or rebase** without the user asking.
4. **Never edit a verification report.** They are historical records. Apply logs may be corrected, but only in place with an explicit corrections section — never by silently rewriting.
5. Verification must be done by a **fresh-context, independent** agent that modifies nothing. Both rounds followed this and both caught real defects the apply agent had missed or overstated.

---

## 8. Recommended order for the next session

1. **Get the C-R1 decision from the user** (§2, options A / B / C). Nothing else is worth doing first — the answer determines whether this is an apply round or a design round.
2. Fix **W-N1** regardless of that answer. It is a plain bug against a documented invariant.
3. Implement the chosen option with real RED→GREEN cycles, plus the happy-path integration test (W-N6) and the diagnosable error (W-N3, and W-N2's silent swallow).
4. Sweep the cheap ones in the same round: **W-N4** (false attribution in the round-1 log), **W-N8** (the "seven tools" docstring), **W-N7** (correct the misdiagnosis in the round-2 log).
5. Run a fresh independent verification against the resulting commit.
6. Only then discuss archive — and note that even a clean verification leaves **SS-8**, the deferred parent CRITICALs, and **0/131 historical Strict-TDD evidence** open. Archive requires the user to either close those or explicitly waive them.
