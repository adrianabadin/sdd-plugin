# SDD Phase Agents — Implementation Tasks

Derived from `2026-08-02-sdd-phase-agents-SPEC.md` (closure pass, 129
scenarios) and `2026-08-01-sdd-phase-agents-design.md` (revision 6).

**One task = exactly one spec scenario**, per the design's Hard Rule (§6).
Task ids are stable and become `allIds` in the checkpoint schema (§4), so
`apply` and `verify` partition along the same axis. Do not split or merge
tasks downstream — that breaks the axis both phases share.

Strict TDD applies: every task is a RED→GREEN→REFACTOR cycle, with the
single exception marked VERIFY-ONLY.

---

## Work unit ordering

```
WU1 identity+store primitives ─┬─> WU2 status schema ──> WU3 routing
                               │
                               ├─> WU4 dispatch lock
                               └─> WU5 semantic gateway ──> WU6 init round
                                                              │
WU7 prompt composition <───────────────────────────────────────┘
   │
   ├─> WU8 worktree fingerprint
   ├─> WU9 checkpoint
   └─> WU10 entry flow ──> WU11 executor contract
WU12 verify-only
```

WU1 gates everything (every key derives from project identity). WU7 needs
`testingSkill` from WU6's persisted config. WU10 needs WU5 (parsing) and
WU2 (discovery shape). WU11 asserts against composed-prompt text, so it
needs WU7.

---

## WU1 — Project identity and store primitives

Foundation. Every PMC key derives from this, so nothing else can be
correct until it is.

- [x] **PI-1** — a relative path is canonicalized to an absolute realpath
- [x] **PI-2** — Windows path variants (8.3 short name, drive case, mixed
      case) collapse to one identical `projectRootHash`
- [x] **PI-3** — a symlinked project root hashes to its target, not the link
- [x] **PI-4** — a stored record carries the readable canonical path
      alongside the hash
- [x] **SS-8** — no `pmc` CLI stdout is parsed; all access via
      `agent-memory-mcp` tools with structured JSON
- [x] **SS-9** — `sdd_save_artifact` reports failure when the read-back does
      not return the written content
- [x] **SS-10** — `sdd_checkpoint` reports failure when the read-back does
      not reflect the completion
- [x] **SS-11** — change artifacts are keyed `sdd/{projectRootHash}/{changeName}/{artifact}`
- [x] **SS-12** — consolidated specs are keyed `sdd/{projectRootHash}/specs/{capability}`

## WU2 — Status schema

- [x] **SS-1** — full shape returns every declared field (`changeName`,
      `projectRoot`, `status`, `artifacts`, `dependencies`,
      `nextRecommended`, `blockedReasons`, `allIds`, `checkpoints`,
      `inFlightPhase`)
- [x] **SS-2** — stored artifacts are exactly `missing` or `done`, never
      `partial`
- [x] **SS-3** — `applyProgress` is computed from checkpoints across all
      three states (`partial` / `done` when `completedIds ⊇ allIds` /
      `missing` when empty)
- [x] **SS-4** — `dependencies` contains a row for each of the eight
      phase-valued recommendations
- [x] **SS-5** — the discovery shape returns `{projectRoot, initialized,
      changes[], nextRecommended}` restricted to `init | select-change | sdd-new`
- [x] **SS-6** — an uninitialized project reports `initialized: false` and
      `nextRecommended: init`
- [x] **SS-7** — `status` is `blocked` iff `blockedReasons` is non-empty or
      `blockedOn` is present, `ok` otherwise

## WU3 — Routing derivation

The load-bearing derivation: the orchestrator routes on these exclusively.

- [x] **RT-1** — the entry phase is `ready` when no upstream artifact precedes it
- [x] **RT-2** — the entry phase becomes `all_done` once its artifact exists
- [x] **RT-3** — `propose` is `blocked` until `explore` is done
- [x] **RT-4** — `propose` is `ready` once `explore` is done
- [x] **RT-5** — `spec` and `design` are `blocked` while `proposal` is missing
- [x] **RT-6** — `spec` is `ready` once `proposal` is done
- [x] **RT-7** — a phase whose own artifact exists is `all_done`
- [x] **RT-8** — `tasks` is `blocked` with only one of spec/design done
      (fan-in is AND, not OR)
- [x] **RT-9** — `apply` is `ready` once `tasks` is done
- [x] **RT-10** — `verify` is `blocked` while `applyProgress` is `partial`
- [x] **RT-11** — `nextRecommended` picks the earliest ready phase, tiebroken
      by graph order (spec before design)
- [x] **RT-12** — non-empty `blockedReasons` routes to `resolve-blockers`
- [x] **RT-13** — an attempt-cap block sets `status: blocked` and
      `nextRecommended: resolve-blockers` in the same computation
- [x] **RT-14** — a completed cycle yields `dependencies.archive: ready` and
      `nextRecommended: archive`
- [x] **RT-15** — an unresolved CRITICAL in `verifyReport` blocks archive,
      and no flag/config/argument can override it
- [x] **RT-16** — incomplete tasks (`completedIds` not covering `allIds`)
      block archive
- [x] **RT-17** — a finished cycle (all rows `all_done`) yields
      `nextRecommended: complete`, never a phase name
- [x] **RT-18** — an incoherent dependency set (nothing ready, nothing
      blocked, not finished) routes to `resolve-blockers`

> RT-17/RT-18 were added during WU3: the spec pinned no behavior for "no
> phase ready", and the implementer's fallback would have recommended
> `archive` on an already-archived change — an archive-forever loop. The
> `complete` value was added to the `nextRecommended` enum to close it.
> Task count is now **131**, not 129.

## WU4 — Dispatch lock

- [x] **DL-1** — acquiring sets `inFlightPhase` when it was null
- [x] **DL-2** — a compose for a *different* phase raises
      `PhaseAlreadyInFlightError` and leaves the lock untouched
- [x] **DL-3** — a compose for the *same* phase re-acquires successfully
      (a phase can always resume itself)
- [x] **DL-4** — `sdd_save_artifact` clears `inFlightPhase`
- [x] **DL-5** — a lock stuck by a crashed dispatch remains visible in
      `sdd_status`
- [x] **DL-6** — an explicit clear releases a stuck lock; there is no
      automatic timeout-based release

## WU5 — Semantic gateway

- [x] **SG-1** — the gateway issues requests against exactly the configured
      endpoint and model
- [x] **SG-2** — shipped defaults are the verified ones (BigModel endpoint,
      `glm-4.7-flash`, `BIGMODEL_API_KEY`, `timeoutMs` 8000, `maxTokens` 512)
- [x] **SG-3** — the API key is read from `process.env[apiKeyEnvVar]` at call
      time and never appears in config, logs, or any persisted record
- [x] **SG-4** — an empty `content` with non-empty `reasoning_content` is
      treated as truncation and retried with a larger budget, never returned
      as a valid empty result
- [x] **SG-5** — a timeout aborts and reports rather than hanging
- [x] **SG-6** — a failed `batchNotes` distillation yields an empty note and
      the batch proceeds

## WU6 — Init round

- [x] **IR-1** — detection reports a slot for each of stack, testing command,
      strict-TDD support, conventions
- [x] **IR-2** — an uninferable test command is recorded as unknown, never a
      defaulted guess, and appears among the residuals
- [x] **IR-3** — the init phase neither prompts the user nor persists config
      itself
- [x] **IR-4** — inferred facts produce no question
- [x] **IR-5** — no storage-backend question is ever asked
- [x] **IR-6** — config merges detected facts with user answers, the user's
      answer winning on conflict, persisted at `sdd-init/{projectRootHash}`
- [x] **IR-7** — the detected testing skill is persisted as a `testingSkill`
      config key
- [x] **IR-8** — an unregistered testing skill persists as an explicit
      `null`, not an absent key
- [x] **IR-9** — an already-initialized project skips the round
- [x] **IR-10** — a first-time run executes the full round before any other
      phase dispatches
- [x] **IR-11** — a request conflicting with stored config re-opens that field
- [x] **IR-12** — `sdd_save_config` is refused before detection has run

## WU7 — Prompt composition

- [x] **PC-1** — every required upstream artifact appears whole, not as
      preview, id, or summary
- [x] **PC-2** — exceeding the budget fails loud naming the offending
      artifact; no truncated or summarized prompt is produced
- [x] **PC-3** — the returned `subagentType` is the complete grammar string
      `model-route:v1|sdd-mr-base|<modelReference>`
- [x] **PC-4** — the prompt body carries no natural-language model trigger
- [x] **PC-5** — mapped skills appear as absolute paths under the mandatory
      heading, paths not contents
- [x] **PC-6** — an unresolvable mapped skill fails composition
- [x] **PC-7** — a phase with an empty map entry composes with no skills heading
- [x] **PC-8** — `testingSkill: null` resolves to nothing and composition
      still succeeds
- [x] **PC-9** — the shared executor contract appears exactly once, ahead of
      phase content and inlined artifacts

## WU8 — Worktree fingerprint

- [x] **WF-1** — an unchanged tree yields no `unexpectedWrites`
- [x] **WF-2** — a non-mutating phase that modified a tracked file is reported
- [x] **WF-3** — a newly created untracked file is detected
      (`--porcelain=v1 -uall`, which `git diff` would miss)
- [x] **WF-4** — a commit made during the phase is detected via the `HEAD` sha
- [x] **WF-5** — a dirty baseline yields no false positive (delta against the
      compose-time snapshot, not absolute cleanliness)
- [x] **WF-6** — a mutating phase's changes are not reported
- [x] **WF-7** — a non-git project falls back to a `(relpath, size, mtime_ns)`
      walk and still functions
- [x] **WF-8** — `mutating` comes from the declared per-phase table
- [x] **WF-9** — `sdd-verify` is `mutating: true`

## WU9 — Checkpoint

- [x] **CP-1** — a verify batch leaves `checkpoints.apply.completedIds` untouched
- [x] **CP-2** — declaring a batch records `totalIds` and sets `batchId`
- [x] **CP-3** — an interrupted batch retains its full plan with zero completions
- [x] **CP-4** — a second batch preserves earlier `completedIds` and replaces
      only `currentBatch`
- [x] **CP-5** — a completion adds to `completedIds` and drops from `remainingIds`
- [x] **CP-6** — resending the same `completedId` is idempotent
- [x] **CP-7** — an id without a checkpoint stays in `remainingIds` even with
      partial code on disk
- [x] **CP-8** — re-declaring an incomplete id increments `attemptCounts`
- [x] **CP-9** — re-declaring a completed id does not increment
- [x] **CP-10** — reaching the cap (default 3) sets `status: blocked` with
      `blockedReasons` naming the id
- [x] **CP-11** — `sdd_checkpoint` is refused from any phase other than apply
      or verify
- [x] **CP-12** — `batchNotes` is generated via the semantic gateway, not
      authored by the executor
- [x] **CP-13** — a scenario implemented exactly as designed records no note
- [x] **CP-14** — blocking mid-batch leaves `completedIds` unchanged and
      populates `blockedOn`
- [x] **CP-15** — resuming inlines the answer and continues from
      `remainingIds` starting at the blocked item
- [x] **CP-16** — a conflicting concurrent write is re-read and retried once
- [x] **CP-17** — a second conflict raises rather than overwriting

## WU10 — Entry flow

- [x] **EF-1** — a request naming a model yields all three parse fields
- [x] **EF-2** — a request naming no model yields `modelPhrase: null`
- [x] **EF-3** — a request with no SDD mention yields
      `explicitSddMention: false`
- [x] **EF-4** — a mid-run gateway timeout fails loud with the human fallback
      and attempts no secondary provider
- [x] **EF-5** — `changeName` is a deterministic slug of the task description
- [x] **EF-6** — an unambiguous existing change name is reused
- [x] **EF-7** — an ambiguous collision asks rather than guessing
- [x] **EF-8** — `explicitSddMention: false` refuses the run; size/file
      count/risk never select SDD
- [x] **EF-9** — gates evaluate in order and the first failure stops the run
      with no later side effects
- [x] **EF-10** — `/sdd-go` only routes; it never edits or implements
- [x] **EF-11** — a resolvable alias produces a canonical reference and dispatches
- [x] **EF-12** — `RouteUnknownError` becomes a `blockedOn` question, not an abort
- [x] **EF-13** — `RouteAmbiguousError` surfaces the resolver's candidate list
- [x] **EF-14** — `QuarantinedModelError` takes the same `blockedOn` path
- [x] **EF-15** — an unnamed model still dispatches through the grammar with
      the configured default inside it; no bare `subagent_type`
- [x] **EF-16** — an unbootstrapped project is refused with the exact command
      named, never auto-bootstrapped
- [x] **EF-17** — a failed store probe refuses the run
- [x] **EF-18** — an unreachable gateway degrades (direct questions,
      `batchNotes` disabled)
- [x] **EF-19** — unavailable `pmc_get_context` degrades to plain reads
- [x] **EF-20** — the health probe writes then reads back the same key,
      declaring healthy only on content match
- [x] **EF-21** — the probe overwrites one fixed key rather than accumulating

## WU11 — Executor contract

Mostly assertions against composed-prompt text and orchestrator behavior.

- [x] **PE-1** — the artifact is emitted as a fenced `SDD_ARTIFACT:` block and
      persisted by the orchestrator; the executor calls no persistence tool
      but `sdd_checkpoint`
- [x] **PE-2** — the final output is text, `SDD_ARTIFACT:` first, contract
      fields last
- [x] **PE-3** — a blocked phase populates non-empty `blockedOn.question` and
      `blockedOn.progressSummary`, and the resume inlines the summary
- [x] **PE-4** — `skill_resolution` is exactly `paths-injected` or
      `not-read`; any other value is a contract violation
- [x] **PE-5** — `skill_resolution: not-read` is treated as a failed gate
- [x] **PE-6** — the executor's tool-call log contains no artifact-store call
- [x] **PE-7** — `pmc_get_context` is available to every phase
- [x] **PE-8** — the executor's tool-call log contains no interactive tool
      call; the orchestrator relays the question
- [x] **PE-9** — the composed `sdd-tasks` prompt instructs the three forecast
      lines verbatim, including the `1000-line budget risk:` wording
- [x] **PE-10** — the composed `sdd-tasks` prompt carries the
      one-task-per-scenario Hard Rule
- [x] **PE-11** — the composed `sdd-design` prompt carries the per-scenario
      signature Hard Rule
- [x] **PE-12** — the composed `sdd-apply` prompt says checkpoints are the
      tick marks and forbids tasks.md edits
- [x] **PE-13** — the composed `sdd-explore` prompt instructs decomposition on
      oversized scope
- [x] **PE-14** — the composed `sdd-propose` prompt instructs 3–5 questions
      only on genuine ambiguity
- [x] **PE-15** — `unexpectedWrites` is treated as a failed gate entering the
      escalate-don't-loop path, not merely logged
- [x] **PE-16** — the Gatekeeper validator dispatches on the configured
      default model through the explicit grammar

## WU12 — Verify-only

- [x] **MR-1** — **VERIFY-ONLY, no RED phase.** Confirm the fleet cap: 25
      routes rejected outright even with `sizeException`, 24 accepted with
      one. Already green in the working tree
      (`disk-agent-generator.ts:74`); this task is a verification only.

---

## Notes for `apply`

**Four tasks are multi-assert and were flagged by verification.** Each is a
single truth table, so each remains one task and one RED→GREEN cycle — but
write the test to cover every branch rather than only the first:
`SS-3` (three `applyProgress` states), `SS-7` (both branches plus the
negative), `MR-1` (reject-25 and accept-24 are two decode outcomes), `CP-4`
(cumulative *and* `currentBatch` replaced).

**Do not batch across work-unit boundaries.** WU boundaries follow real
dependency edges, so a batch spanning them will hit unimplemented
prerequisites mid-run.

---

## Review Workload Forecast

Decision needed before apply: Yes
Chained PRs recommended: Yes
1000-line budget risk: Medium

**Why.** 129 tasks across twelve work units, each a full TDD cycle with its
own test. At a conservative ~15 changed lines of implementation plus test
per scenario, the total lands near 2000 changed lines — roughly twice the
1000-line review budget, so a single PR is still not defensible.

What the raised budget *does* change is the shape of the split. Every work
unit now fits inside one PR on its own: the largest is WU10 at 21 tasks
(~315 lines), and the next largest are WU9 (17), WU3 and WU11 (16 each) —
all comfortably under 1000. So the work-unit boundaries are sufficient as
PR boundaries, and the secondary splits an earlier forecast suggested for
WU3 and WU10 are no longer needed. Twelve chained PRs, one per work unit,
each independently reviewable, each ending at a real dependency edge with
the tree green.

Risk is `Medium` rather than `Low` because the aggregate still exceeds the
budget by ~2×, so the chaining decision is real — but no individual review
is oversized, which is what the budget actually protects.
