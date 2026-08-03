# SDD Phase Agents — Delta Specs

Derived from `2026-08-01-sdd-phase-agents-design.md` (revision 6, validated
PASS by an independent fourth pass) and `2026-08-01-sdd-phase-agents-DECISIONES.md`.

**Scenario granularity is deliberate.** The design's own Hard Rule says one
task = exactly one scenario, independently RED→GREEN testable in isolation
(§6 `sdd-tasks`). These scenarios are written to that bar, so they map 1:1
onto tasks and onto `allIds` in the checkpoint schema. Splitting or merging
them downstream breaks that axis.

Capabilities below are **ADDED** unless marked otherwise.

---

## Capability: `sdd-project-identity`

Namespacing and canonicalization of the project root. Everything else keys
off this, so it comes first.

### ADDED Requirement: project root is canonicalized before use

Every MCP tool takes `projectRoot` explicitly and canonicalizes it. PMC's
ambient/last-used project state is never trusted (§8.2 row 1).

**Scenario: a relative path is canonicalized to an absolute realpath**
- GIVEN a `projectRoot` given as a relative path or containing `..`
- WHEN any SDD MCP tool resolves it
- THEN it is resolved to an absolute realpath before any key is derived

**Scenario: Windows path variants collapse to one identity**
- GIVEN the same directory expressed with a short (8.3) name, an uppercase
  drive letter, and mixed case
- WHEN each is canonicalized
- THEN all three produce the identical `projectRootHash`

**Scenario: a symlinked project root resolves to its target**
- GIVEN a `projectRoot` that is a symlink
- WHEN it is canonicalized
- THEN the hash is derived from the link target, not the link path

### ADDED Requirement: records carry the readable path alongside the hash

**Scenario: a stored record is findable after the project moves**
- GIVEN an SDD record written under `hash(canonicalPath)`
- WHEN the record is read back
- THEN it also contains the canonical path as readable text, so a moved
  project's history can be located rather than silently orphaned

---

## Capability: `sdd-status-store`

The unified status object and its persistence in PMC.

### ADDED Requirement: `sdd_status` returns the full shape for a named change

**Scenario: full shape includes every declared field**
- GIVEN a `projectRoot` and an existing `changeName`
- WHEN `sdd_status` is called
- THEN it returns `changeName`, `projectRoot`, `status`, `artifacts`,
  `dependencies`, `nextRecommended`, `blockedReasons`, `allIds`,
  `checkpoints`, `inFlightPhase`

**Scenario: artifacts are two-state, never `partial`**
- GIVEN stored artifacts for explore/proposal/spec/design/tasks/verifyReport/archiveReport
- WHEN status is computed
- THEN each is exactly `missing` or `done` (§9.13 — one blob per artifact,
  so `partial` has no meaning)

**Scenario: `applyProgress` is computed from checkpoints, not asserted**
- GIVEN `allIds` = [s1, s2, s3] and `checkpoints.apply.completedIds` = [s1, s2]
- WHEN status is computed
- THEN `applyProgress` is `partial`
- AND when `completedIds` ⊇ `allIds`, it is `done`
- AND when `completedIds` is empty, it is `missing`

**Scenario: `dependencies` has a row for every phase-valued recommendation**
- GIVEN any change state
- WHEN status is computed
- THEN `dependencies` contains rows for explore, propose, spec, design,
  tasks, apply, verify, archive

> Note: this covers the *phase-valued* recommendations only. `init`,
> `select-change` and `resolve-blockers` are not phases and have no
> dependency row — the design's claim that per-phase rows make "every value
> `nextRecommended` can return representable" is inaccurate on those three
> and should be corrected there too.

### ADDED Requirement: `sdd_status` returns a discovery shape without a `changeName`

**Scenario: discovery shape lists changes and its own recommendation**
- GIVEN a `projectRoot` and no `changeName`
- WHEN `sdd_status` is called
- THEN it returns `{ projectRoot, initialized, changes: [{changeName, nextRecommended}], nextRecommended }`
- AND `nextRecommended` is restricted to `init | select-change | sdd-new`
  (the answers meaningful before a change exists — design §4, discovery
  shape block)

**Scenario: an uninitialized project reports `init`**
- GIVEN a `projectRoot` with no persisted `sdd-init/{projectRootHash}`
- WHEN the discovery shape is computed
- THEN `initialized` is false and `nextRecommended` is `init`

### ADDED Requirement: `status: blocked` is derived, never caller-asserted

**Scenario: blocked is true iff there is a reason**
- GIVEN `blockedReasons` is non-empty OR `blockedOn` is present
- WHEN status is computed
- THEN `status` is `blocked`
- AND otherwise it is `ok`

### ADDED Requirement: the store is PMC only, via MCP tools

**Scenario: no CLI text is parsed**
- GIVEN any read or write of SDD state
- WHEN it executes
- THEN it goes through `agent-memory-mcp`'s MCP tools with structured JSON
- AND no `pmc` CLI stdout is parsed (§8.2 row 5)

### ADDED Requirement: writes are read back to prove durability

PMC's writes are not guaranteed atomic (§8.2 row 3). Read-back is a
durability check — it proves bytes landed, not that a concurrent writer
won't clobber them later, and not that content is correct.

**Scenario: a write that did not land is reported, not assumed**
- GIVEN `sdd_save_artifact` wrote an artifact
- WHEN the read-back does not return the written content
- THEN the call reports failure rather than treating the phase as saved

**Scenario: checkpoint writes are read back too**
- GIVEN `sdd_checkpoint` recorded a completion
- WHEN the read-back does not reflect it
- THEN the call reports failure

### ADDED Requirement: PMC keys follow the declared namespace shapes

**Scenario: change artifacts are namespaced by project and change**
- GIVEN a project and a change
- WHEN an artifact is persisted
- THEN its key is `sdd/{projectRootHash}/{changeName}/{artifact}`

**Scenario: consolidated specs are namespaced by capability**
- GIVEN `sdd-archive` emitting a consolidated spec
- WHEN it is persisted
- THEN its key is `sdd/{projectRootHash}/specs/{capability}`

---

## Capability: `sdd-routing`

How `dependencies` and `nextRecommended` are computed. The orchestrator
routes on these exclusively, so they are the load-bearing derivation in the
whole design.

### ADDED Requirement: dependency state is derived from the Dependency Graph

The graph (design §4) is linear with one fork-then-join at tasks. In
dependency-input order the phases are:

`explore → propose → spec ∥ design → tasks → apply → verify → archive`

where `spec` and `design` are both unblocked by `propose` alone (they are
parallel, neither depends on the other), and `tasks` requires *both* spec
and design (a fan-in AND). `explore` has no upstream artifact dependency
(it is the entry phase after init). The linear order used for
`nextRecommended` tiebreaking (when two phases are simultaneously `ready`)
is the `nextRecommended` enum from design §4:
`explore | propose | spec | design | tasks | apply | verify | archive`.

**Scenario: the entry phase is ready when no upstream artifact exists**
- GIVEN `explore` is `missing` and no upstream artifact precedes it
- WHEN status is computed
- THEN `dependencies.explore` is `ready`

**Scenario: the entry phase becomes all_done once its artifact exists**
- GIVEN `explore` is `done`
- WHEN status is computed
- THEN `dependencies.explore` is `all_done`

**Scenario: propose is blocked until explore is done**
- GIVEN `explore` is `missing`
- WHEN status is computed
- THEN `dependencies.propose` is `blocked`

**Scenario: propose is ready once explore is done**
- GIVEN `explore` is `done` and `propose` is `missing`
- WHEN status is computed
- THEN `dependencies.propose` is `ready`

**Scenario: a phase whose inputs are missing is blocked**
- GIVEN `proposal` is `missing`
- WHEN status is computed
- THEN `dependencies.spec` and `dependencies.design` are `blocked`

**Scenario: a phase whose inputs are present is ready**
- GIVEN `proposal` is `done` and `spec` is `missing`
- WHEN status is computed
- THEN `dependencies.spec` is `ready`

**Scenario: a phase whose own artifact exists is all_done**
- GIVEN `spec` is `done`
- WHEN status is computed
- THEN `dependencies.spec` is `all_done`

**Scenario: tasks requires both spec and design**
- GIVEN `spec` is `done` and `design` is `missing`
- WHEN status is computed
- THEN `dependencies.tasks` is `blocked` (the fan-in is an AND, not an OR)

**Scenario: apply is ready once tasks is done**
- GIVEN `tasks` is `done` and `applyProgress` is `missing` (no completions yet)
- WHEN status is computed
- THEN `dependencies.apply` is `ready`

**Scenario: verify requires apply to be complete**
- GIVEN `applyProgress` is `partial`
- WHEN status is computed
- THEN `dependencies.verify` is `blocked`

### ADDED Requirement: `nextRecommended` is the first ready phase in graph order

When multiple phases are simultaneously `ready`, the one earliest in the
linear order (`explore | propose | spec | design | tasks | apply | verify |
archive`) wins.

**Scenario: routing picks the earliest ready phase, tiebroken by graph order**
- GIVEN `proposal` is `done`, `spec` is `missing`, `design` is `missing`
- WHEN status is computed
- THEN `nextRecommended` is `spec` (both spec and design are ready, and spec
  precedes design in graph order)

**Scenario: blockers outrank phase recommendations**
- GIVEN `blockedReasons` is non-empty
- WHEN status is computed
- THEN `nextRecommended` is `resolve-blockers`

**Scenario: an attempt-cap block routes to resolve-blockers**
- GIVEN `attemptCounts[s5]` reached the cap and `sdd_status` now returns
  `status: blocked` with `blockedReasons` naming s5
- WHEN `nextRecommended` is read from the same status object
- THEN it is `resolve-blockers` — the blocked state and the routing change
  happen together in the same computation, never one without the other

**Scenario: a finished cycle recommends `complete`, not a phase**
- GIVEN every phase row is `all_done` (archive included) and there are no
  blockers
- WHEN status is computed
- THEN `nextRecommended` is `complete`
- AND it is never a phase name — the orchestrator routes on this field
  exclusively, so returning `archive` for an already-archived change would
  be an instruction to archive it again, forever

**Scenario: an incoherent dependency set routes to `resolve-blockers`**
- GIVEN no phase is `ready`, `blockedReasons` is empty, and the cycle is not
  finished
- WHEN status is computed
- THEN `nextRecommended` is `resolve-blockers` — the rows are internally
  inconsistent, and surfacing that beats silently picking a phase

> Both scenarios were found during WU3 implementation: the original spec
> pinned no behavior for "no phase ready", so the implementer had to invent
> a fallback. `complete` was added to the `nextRecommended` enum to close it.

**Scenario: a completed cycle recommends archive**
- GIVEN `explore`, `proposal`, `spec`, `design`, `tasks` all `done`,
  `applyProgress` is `done`, and `verifyReport` is `done` with no unresolved
  CRITICAL
- WHEN status is computed
- THEN `dependencies.archive` is `ready` and `nextRecommended` is `archive`

### ADDED Requirement: the archive gate has no override

**Scenario: an unresolved CRITICAL blocks archive**
- GIVEN a `verifyReport` containing an unresolved CRITICAL finding
- WHEN status is computed
- THEN `dependencies.archive` is `blocked`
- AND no flag, config value, or caller argument can make it `ready`

**Scenario: incomplete tasks block archive**
- GIVEN `checkpoints.apply.completedIds` does not cover `allIds`
- WHEN status is computed
- THEN `dependencies.archive` is `blocked`

---

## Capability: `sdd-init-round`

The init round: the `sdd-init` phase detects project facts, the orchestrator
asks only the residual questions, and `sdd_save_config` persists the merged
result once per project. (Preflight health probing is a separate concern that
lives in `sdd-entry-flow` — the "round" here is the init detection + questions
+ config-persist sequence, not the preflight probe.)

### ADDED Requirement: `sdd-init` detects and reports; it never asks or persists

**Scenario: detection reports all four targets**
- GIVEN a project with a recognizable stack, conventions, testing capability,
  and strict-TDD support
- WHEN the `sdd-init` phase runs
- THEN its artifact contains a slot for each of the four: stack, testing
  command, strict-TDD support, and conventions

**Scenario: detection never guesses — it reports unknown rather than inventing**
- GIVEN a project whose test command cannot be inferred from its files
- WHEN the `sdd-init` phase runs
- THEN the artifact records the test command as unknown (not a defaulted
  guess like `npm test`)
- AND that field appears among the residual facts `sdd_init_questions` surfaces

**Scenario: the init phase asks the user nothing directly**
- GIVEN the `sdd-init` phase executing
- WHEN it encounters something it cannot infer
- THEN it reports it for the orchestrator to ask
- AND it neither prompts the user nor persists config itself

### ADDED Requirement: `sdd_init_questions` returns only residual questions

**Scenario: inferred facts produce no question**
- GIVEN detection determined the test command, stack, TDD support, and
  conventions
- WHEN `sdd_init_questions` is called
- THEN none of those inferred facts appears as a question

**Scenario: no artifactStore question is ever asked**
- GIVEN any project
- WHEN `sdd_init_questions` is called
- THEN no storage-backend question appears — persistence is always PMC

### ADDED Requirement: `sdd_save_config` persists the merged round once per project

**Scenario: config merges detected facts with user answers, answers winning**
- GIVEN detection found stack=typescript and the user answered a different
  testing command than detection inferred
- WHEN `sdd_save_config` is called with both
- THEN the persisted config contains the user's testing command (not the
  detected one), plus the detected stack (which the user did not override)
- AND the merged config is persisted at `sdd-init/{projectRootHash}`

**Scenario: the detected testing skill is recorded as a config key**
- GIVEN detection identified the project's testing skill
- WHEN config is persisted
- THEN it contains `testingSkill` as a key whose value the static
  phase→skills map later dereferences (never re-derived at compose time)

**Scenario: an unregistered testing skill is recorded as null, not omitted**
- GIVEN a project with no registered testing skill
- WHEN config is persisted
- THEN the config contains `testingSkill` with value `null` (the key is
  present, so `sdd-prompt-composition`'s "resolves to none" scenario fires on
  an explicit null rather than an absent key)

**Scenario: an already-initialized project is not re-asked**
- GIVEN a persisted `sdd-init/{projectRootHash}`
- WHEN a new SDD run starts in the same project
- THEN the init round is skipped

**Scenario: a first-time run executes the round in full**
- GIVEN no persisted `sdd-init/{projectRootHash}` exists for this project
- WHEN a new SDD run starts
- THEN the init round runs in full: the `sdd-init` phase detects,
  `sdd_init_questions` returns residuals, the user answers, and
  `sdd_save_config` persists — before any other phase dispatches

**Scenario: a request conflicting with stored config re-opens the round**
- GIVEN stored config recording one model and a new request naming a
  different one
- WHEN the run starts
- THEN the conflicting field is re-asked rather than silently overridden

### ADDED Requirement: the round's tool ordering is enforced

The output of `sdd_init_questions` depends on detection having run first (it
returns "only what could not be inferred"), so the ordering is load-bearing,
not cosmetic.

**Scenario: saving config before questions are gathered is refused**
- GIVEN the `sdd-init` phase has not yet run detection
- WHEN `sdd_save_config` is called
- THEN it is refused — config cannot be persisted before detection's
  residual questions are known

---

## Capability: `sdd-dispatch-lock`

Structural serialization of phase dispatch. Added in revision 6 (H2) —
replaces a prose premise that the orchestrator was expected to honor.

### ADDED Requirement: `sdd_compose_phase_prompt` acquires the dispatch lock

**Scenario: acquiring sets the in-flight phase**
- GIVEN `inFlightPhase` is null
- WHEN `sdd_compose_phase_prompt` is called for phase P
- THEN it succeeds and `inFlightPhase` becomes P

**Scenario: a second concurrent compose is refused**
- GIVEN `inFlightPhase` is already set to phase P
- WHEN `sdd_compose_phase_prompt` is called for a different phase Q
- THEN it raises `PhaseAlreadyInFlightError` and does not compose a prompt
- AND `inFlightPhase` remains P

**Scenario: re-dispatching the same phase re-acquires its own lock**
- GIVEN `inFlightPhase` is set to phase P (e.g. a crashed dispatch)
- WHEN `sdd_compose_phase_prompt` is called again for the same phase P
- THEN it succeeds — a phase can always resume itself

### ADDED Requirement: `sdd_save_artifact` releases the dispatch lock

**Scenario: saving clears the lock**
- GIVEN `inFlightPhase` is set to phase P
- WHEN `sdd_save_artifact` completes for phase P
- THEN `inFlightPhase` becomes null

**Scenario: a stuck lock is visible, not silent**
- GIVEN a dispatch crashed before reaching `sdd_save_artifact`
- WHEN `sdd_status` is called
- THEN `inFlightPhase` still reports the stuck phase, so the condition is
  observable rather than a silent deadlock

**Scenario: a stuck lock can be cleared deliberately**
- GIVEN `inFlightPhase` is stuck on a crashed phase P and the next phase to
  run is Q
- WHEN an explicit clear is requested through the tool
- THEN `inFlightPhase` becomes null and Q can acquire it
- AND the clear is explicit, never automatic on timeout (a silently
  self-clearing lock would reintroduce the concurrency it exists to prevent)

---

## Capability: `sdd-prompt-composition`

### ADDED Requirement: upstream artifacts are inlined in full

**Scenario: every required upstream artifact appears whole**
- GIVEN a phase whose Dependency Graph inputs are spec and design
- WHEN the prompt is composed
- THEN both artifacts appear in full in the prompt body, not as previews,
  IDs, or summaries

**Scenario: composition never truncates or summarizes to fit**
- GIVEN upstream artifacts whose combined size exceeds the configured budget
- WHEN the prompt is composed
- THEN composition fails loud naming the artifact that exceeded it
- AND no summarized or truncated prompt is produced (§9 item 2 — silent
  substitution would break the reproducibility the inline design exists for)

### ADDED Requirement: the tool returns a fully-formed `subagentType`

**Scenario: dispatch identity is code output, not string-building**
- GIVEN a resolved `modelReference`
- WHEN the prompt is composed
- THEN the returned `subagentType` is the complete grammar string
  `model-route:v1|sdd-mr-base|<modelReference>`
- AND the orchestrator passes it verbatim, assembling nothing

**Scenario: the prompt body carries no model trigger**
- GIVEN any composed prompt
- WHEN it is inspected
- THEN it contains no appended natural-language model trigger phrase — the
  model travels only in `subagentType` (Path A)

### ADDED Requirement: mandatory skill paths are injected, resolved at compose time

**Scenario: mapped skills appear as paths under a mandatory heading**
- GIVEN a phase with entries in the static phase→skills map
- WHEN the prompt is composed
- THEN the composed prompt contains those skills' absolute paths under the
  "Skills to load before work" heading
- AND the paths are injected, not the skill contents

**Scenario: an unresolvable mapped skill fails composition**
- GIVEN a phase whose mapped skill name does not resolve to a readable path
- WHEN the prompt is composed
- THEN composition fails loud rather than emitting a prompt that silently
  omits a mandatory standard

**Scenario: a phase with no mandatory skills composes cleanly**
- GIVEN a phase whose map entry is empty (e.g. `sdd-explore`)
- WHEN the prompt is composed
- THEN no skills heading is emitted and composition succeeds

**Scenario: an unregistered testing skill resolves to none, not failure**
- GIVEN a project whose config has `testingSkill: null`
- WHEN `sdd-apply`'s prompt is composed
- THEN the testing-skill entry resolves to nothing and composition succeeds
  (§9 item 11 — a missing optional standard is `none`, not a hard failure)

### ADDED Requirement: the shared phase contract is prepended to every phase

**Scenario: the contract appears exactly once, ahead of phase content**
- GIVEN any composed phase prompt
- WHEN it is inspected
- THEN the shared executor contract (§5) appears once, before the
  phase-specific template and before the inlined artifacts

---

## Capability: `sdd-worktree-fingerprint`

Detection replacing prevention (§7.1, §7.2).

### ADDED Requirement: the fingerprint is captured before dispatch and re-checked after

**Scenario: an unchanged tree produces no report**
- GIVEN a non-mutating phase and a worktree unchanged across the dispatch
- WHEN `sdd_save_artifact` re-computes the fingerprint
- THEN `unexpectedWrites` is absent

**Scenario: a non-mutating phase that writes is reported**
- GIVEN a non-mutating phase whose dispatch modified a tracked file
- WHEN `sdd_save_artifact` re-computes the fingerprint
- THEN `unexpectedWrites` is reported

**Scenario: untracked files are covered**
- GIVEN a non-mutating phase whose dispatch created a new untracked file
- WHEN the fingerprint is re-computed
- THEN the change is detected (the fingerprint uses
  `git status --porcelain=v1 -uall`, which `git diff` alone would miss)

**Scenario: a commit during the phase is detected**
- GIVEN a non-mutating phase whose dispatch created a commit
- WHEN the fingerprint is re-computed
- THEN the change is detected via the `HEAD` sha component

**Scenario: a dirty baseline does not produce a false positive**
- GIVEN a worktree already dirty before the phase starts (normal mid-run)
- WHEN a non-mutating phase changes nothing further
- THEN `unexpectedWrites` is absent — the check is a delta against the
  compose-time snapshot, not an absolute cleanliness check

**Scenario: a mutating phase's changes are expected, not reported**
- GIVEN `sdd-apply` (declared `mutating: true`)
- WHEN it modifies source files and `sdd_save_artifact` runs
- THEN `unexpectedWrites` is absent

**Scenario: a non-git project falls back to a filesystem walk**
- GIVEN a `projectRoot` that is not a git repository
- WHEN the fingerprint is computed
- THEN it is derived from a walk recording `(relpath, size, mtime_ns)`
- AND the check still functions rather than silently degrading to nothing

### ADDED Requirement: the `mutating` flag is declared per phase, never inferred

**Scenario: the per-phase table drives the flag**
- GIVEN any phase
- WHEN `sdd_compose_phase_prompt` sets `mutating`
- THEN the value comes from the declared table: false for init, explore,
  propose, spec, design, tasks, archive; true for apply and verify

**Scenario: verify is mutating because it runs real tests**
- GIVEN `sdd-verify`
- WHEN its flag is read
- THEN `mutating` is true (test execution writes caches, coverage data —
  a test runner that wrote nothing wouldn't be exercising anything)

---

## Capability: `sdd-checkpoint`

Mid-phase resumability for apply and verify.

### ADDED Requirement: checkpoints are keyed by phase

**Scenario: verify's batch does not disturb apply's progress**
- GIVEN `checkpoints.apply.completedIds` is non-empty
- WHEN `sdd_checkpoint` declares a batch for `verify`
- THEN `checkpoints.apply.completedIds` is unchanged

### ADDED Requirement: a batch is declared before work begins

**Scenario: declaring a batch records the committed scope**
- GIVEN a phase about to start work
- WHEN it calls `sdd_checkpoint` with `totalIds`
- THEN `currentBatch.totalIds` records exactly those ids and
  `currentBatch.batchId` is set

**Scenario: an interrupted batch retains its plan with zero completions**
- GIVEN a declared batch where no item completed before the run was cut
- WHEN `sdd_status` is read
- THEN `currentBatch.totalIds` still shows the full committed plan

### ADDED Requirement: completions accumulate across batches and never reset

**Scenario: a second batch does not overwrite earlier completions**
- GIVEN `completedIds` = [s1, s2] from a previous batch
- WHEN a new batch is declared with `totalIds` = [s3, s4]
- THEN `completedIds` still contains s1 and s2
- AND `currentBatch` is replaced by the new batch

**Scenario: an item is recorded as complete on checkpoint**
- GIVEN a declared batch containing s3
- WHEN `sdd_checkpoint` is called with `completedId: s3`
- THEN `completedIds` contains s3 and `currentBatch.remainingIds` excludes it

**Scenario: resending the same completion is idempotent**
- GIVEN `completedIds` already contains s3
- WHEN `sdd_checkpoint` is called again with `completedId: s3`
- THEN the call succeeds and `completedIds` contains s3 exactly once

**Scenario: an item without a completion is treated as not done**
- GIVEN a scenario with partially written code but no checkpoint
- WHEN progress is computed
- THEN the id appears in `remainingIds` (TDD RED-start assumption)

### ADDED Requirement: retry attempts are counted server-side and capped

**Scenario: re-declaring an incomplete id increments its attempt count**
- GIVEN `attemptCounts[s5]` is 1 and s5 is not in `completedIds`
- WHEN a batch is declared that includes s5
- THEN `attemptCounts[s5]` becomes 2 — without the executor self-reporting
  a retry (which it cannot know across a restart or model switch)

**Scenario: re-declaring a completed id does not increment**
- GIVEN s1 is in `completedIds`
- WHEN a batch including s1 is declared
- THEN `attemptCounts[s1]` is unchanged

**Scenario: exceeding the cap blocks in the tool, not in the orchestrator**
- GIVEN `attemptCounts[s5]` reaches the configured cap (default 3)
- WHEN `sdd_status` is computed
- THEN `status` is `blocked` and `blockedReasons` names s5 and its attempt
  history — enforced by the same code that owns the counter

### ADDED Requirement: `sdd_checkpoint` is scoped to apply and verify

**Scenario: a checkpoint from any other phase is refused**
- GIVEN a phase other than `apply` or `verify`
- WHEN it calls `sdd_checkpoint`
- THEN the call is refused — it is the one narrow exception to "executors
  never persist directly", and the exception is bounded

### ADDED Requirement: `batchNotes` records only unanticipated deviations

**Scenario: the note is distilled off the executor's budget**
- GIVEN a completed scenario in a batch
- WHEN `batchNotes` is produced
- THEN it is generated via the semantic-utility gateway, not authored in the
  executor's own output

**Scenario: design-anticipated content is not restated**
- GIVEN a scenario implemented exactly as `design.md` specified
- WHEN the note is produced
- THEN it records nothing — notes capture only mid-batch deviations that
  design could not have anticipated

### ADDED Requirement: a mid-batch block preserves batch progress

**Scenario: blocking mid-batch does not discard completions**
- GIVEN a batch with some items already in `completedIds`
- WHEN the phase blocks on a user question mid-batch
- THEN `completedIds` is unchanged and `blockedOn` explains the current item

**Scenario: resuming continues from the blocked item**
- GIVEN a batch blocked mid-flight and an answer supplied
- WHEN the phase is re-dispatched
- THEN the answer is inlined and work continues from `remainingIds`,
  starting with the item that was blocked

### ADDED Requirement: checkpoint writes use optimistic concurrency

**Scenario: a conflicting concurrent write is retried once**
- GIVEN the stored checkpoint record changed between read and write
- WHEN `sdd_checkpoint` attempts its conditional write
- THEN it re-reads and retries once

**Scenario: a second conflict fails loud rather than losing an update**
- GIVEN the retry also conflicts
- WHEN the second attempt fails
- THEN the call raises rather than silently overwriting

---

## Capability: `sdd-entry-flow`

### ADDED Requirement: `sdd_parse_request` splits free text into its three fields

**Scenario: a request naming a model yields all three fields**
- GIVEN "Quiero crear un Hello world en java usando sdd y el modelo gemini flash 3.6 tiered"
- WHEN `sdd_parse_request` runs
- THEN `taskDescription` is the task without the SDD/model boilerplate,
  `modelPhrase` is the model phrase as the user wrote it, and
  `explicitSddMention` is true

**Scenario: a request naming no model yields a null model phrase**
- GIVEN a request that mentions SDD but no model
- WHEN `sdd_parse_request` runs
- THEN `modelPhrase` is null and `explicitSddMention` is true

**Scenario: a request with no SDD mention is reported as such**
- GIVEN a request that never mentions SDD
- WHEN `sdd_parse_request` runs
- THEN `explicitSddMention` is false

**Scenario: a mid-run gateway timeout fails loud with a human fallback**
- GIVEN the gateway does not respond within `timeoutMs`
- WHEN `sdd_parse_request` is called
- THEN it fails loud and the orchestrator asks the user for task and model
  directly
- AND no secondary provider is attempted

### ADDED Requirement: `changeName` is derived deterministically and collisions are surfaced

**Scenario: the change name is a slug of the task description**
- GIVEN `taskDescription` "Hello world en java"
- WHEN the change name is derived
- THEN it is a deterministic slug (e.g. `hello-world-java`) — the same input
  always yields the same name

**Scenario: an unambiguous existing name is reused**
- GIVEN the discovery shape lists exactly one change matching the derived name
- WHEN the run continues
- THEN that existing change is used

**Scenario: an ambiguous collision asks rather than guessing**
- GIVEN the derived name collides with more than one existing change
- WHEN the run continues
- THEN the user is asked which change to use

### ADDED Requirement: SDD is never entered by inference

**Scenario: an explicit SDD mention is required**
- GIVEN a request with `explicitSddMention: false`
- WHEN `/sdd-go` evaluates its gates
- THEN it refuses to start an SDD run
- AND size, file count, and risk never select SDD on their own

**Scenario: gates evaluate in order and fail closed**
- GIVEN `/sdd-go` invoked
- WHEN its gates run
- THEN they evaluate in order — explicit mention, preflight probe, change
  resolution, request parsing — and the first failure stops the run
- AND no later gate's side effects occur after an earlier gate failed

**Scenario: the command implements nothing itself**
- GIVEN `/sdd-go` completing its gates
- WHEN it acts
- THEN it only routes to `nextRecommended`, never editing files or
  implementing the request directly

### ADDED Requirement: the model phrase is resolved before dispatch

**Scenario: a resolvable alias proceeds**
- GIVEN `modelPhrase` matching a curated alias (e.g. "gemini flash 3.6 tiered")
- WHEN it is resolved
- THEN a canonical model reference is produced and dispatch proceeds

**Scenario: an unknown phrase becomes a question, not an abort**
- GIVEN `modelPhrase` that resolves to nothing (e.g. "gemini 3.6", which is
  not in the frozen alias table)
- WHEN resolution fails with `RouteUnknownError`
- THEN the run enters `blockedOn` with a question for the user
- AND the run is not aborted

**Scenario: an ambiguous phrase surfaces its candidates**
- GIVEN a phrase matching several canonical models
- WHEN resolution fails with `RouteAmbiguousError`
- THEN `blockedOn.question` includes the candidate list the resolver produced

**Scenario: a quarantined model takes the same path**
- GIVEN a phrase resolving to a quarantined model
- WHEN `QuarantinedModelError` is raised
- THEN it surfaces as a `blockedOn` question, not a crash

### ADDED Requirement: every SDD dispatch uses the explicit grammar

**Scenario: an unnamed model still dispatches through the grammar**
- GIVEN the user named no model
- WHEN a phase is dispatched
- THEN the configured default model is placed *inside* the grammar
- AND a bare `subagent_type` is never emitted (which would route through
  the prompt-scanning path)

### ADDED Requirement: cold start refuses with an actionable message

**Scenario: an unbootstrapped project is refused, not auto-bootstrapped**
- GIVEN a `projectRoot` where PMC has never been initialized
- WHEN `/sdd-go` runs its preflight
- THEN it refuses and names the exact command to run
- AND it does not trigger `pmc init` / `map-project` itself

### ADDED Requirement: preflight degrades except on persistence failure

**Scenario: an unreachable store refuses the run**
- GIVEN PMC's store fails the real write+read-back probe
- WHEN preflight runs
- THEN the run is refused (nothing could be persisted or resumed)

**Scenario: an unreachable gateway degrades instead of refusing**
- GIVEN the semantic-utility gateway endpoint is unreachable
- WHEN preflight runs
- THEN the run proceeds, asking the user for task and model directly, with
  `batchNotes` disabled for the run

**Scenario: unavailable codebase context degrades**
- GIVEN `pmc_get_context` is unavailable
- WHEN preflight runs
- THEN the run proceeds and phases operate with plain reads

**Scenario: the health probe performs a write-then-read-back, not a read-only ping**
- GIVEN the preflight health probe running
- WHEN it checks the store
- THEN it writes a probe record to `sdd-health/{projectRootHash}` and
  immediately reads that same key back, declaring the store healthy only if
  the written content is returned — a read-only ping would not detect a store
  that reads fine but silently drops writes (§8.2 row 3)

**Scenario: the health probe leaves exactly one record**
- GIVEN repeated `/sdd-go` invocations
- WHEN the probe writes each time
- THEN it overwrites a single fixed key `sdd-health/{projectRootHash}`
  rather than accumulating records

---

## Capability: `sdd-semantic-gateway`

### ADDED Requirement: the provider is config-driven, the key is never in config

**Scenario: config selects endpoint and model**
- GIVEN `config/sdd/semantic-gateway.json` with endpoint, model,
  `apiKeyEnvVar`, `timeoutMs`, `maxTokens`
- WHEN the gateway initializes
- THEN it issues requests against exactly those endpoint and model values

**Scenario: shipped defaults are the verified ones**
- GIVEN the default config as shipped
- WHEN it is read
- THEN endpoint is `https://open.bigmodel.cn/api/paas/v4/chat/completions`,
  model is `glm-4.7-flash`, `apiKeyEnvVar` is `BIGMODEL_API_KEY`,
  `timeoutMs` is 8000, and `maxTokens` is large enough to cover reasoning
  plus answer (512) — the budget the live probe showed is required for this
  reasoning model

**Scenario: the API key is read from the environment at call time**
- GIVEN a configured `apiKeyEnvVar`
- WHEN a request is made
- THEN the secret is read from `process.env[apiKeyEnvVar]`
- AND the key never appears in the config file, in logs, or in any persisted
  record

### ADDED Requirement: reasoning-model truncation is detected, not silently accepted

**Scenario: an empty content with non-empty reasoning is a failure**
- GIVEN a response whose `content` is empty while `reasoning_content` is
  non-empty (the observed behavior of `glm-4.7-flash` under a low token
  budget)
- WHEN the gateway processes it
- THEN it is treated as truncation and retried with a larger budget
- AND it is never returned as a valid empty result

**Scenario: a timeout fails loud rather than hanging**
- GIVEN an endpoint that does not respond within `timeoutMs`
- WHEN the call is made
- THEN it aborts and reports the timeout

**Scenario: `batchNotes` failure never blocks a batch**
- GIVEN a `batchNotes` distillation call that fails or times out
- WHEN the phase continues
- THEN the note is empty and the batch proceeds — it is an optimization,
  never load-bearing for correctness

---

## Capability: `sdd-phase-execution` (executor contract)

### ADDED Requirement: executors persist nothing except checkpoints

**Scenario: the artifact is returned, not written**
- GIVEN a phase that produced its artifact
- WHEN it finishes
- THEN it emits a fenced `SDD_ARTIFACT:` block and the orchestrator persists
  it via `sdd_save_artifact`
- AND the executor calls no persistence tool other than `sdd_checkpoint`

**Scenario: the final output is text with the contract fields last**
- GIVEN any phase completion
- WHEN the final message is inspected
- THEN it is text (not a tool call), with the `SDD_ARTIFACT:` block first
  and `status`, `executive_summary`, `artifacts`, `next_recommended`,
  `risks`, `skill_resolution` last

**Scenario: a blocked phase populates `blockedOn` with a question and a summary**
- GIVEN a phase that ends with `status: blocked`
- WHEN its output is inspected
- THEN `blockedOn.question` and `blockedOn.progressSummary` are both present
  and non-empty
- AND the resume dispatch inlines `progressSummary` into the composed prompt

**Scenario: `skill_resolution` carries only the two defined values**
- GIVEN a phase that was given mandatory skill paths
- WHEN it reports
- THEN `skill_resolution` is exactly `paths-injected` or `not-read`
- AND any other value is rejected as a contract violation

**Scenario: a `not-read` resolution is a Gatekeeper failure**
- GIVEN a phase reporting `skill_resolution: not-read`
- WHEN the orchestrator evaluates the result
- THEN it is treated as a failed gate, not merely recorded

### ADDED Requirement: executors query the artifact store never, codebase context freely

**Scenario: the artifact store is not queried by the executor**
- GIVEN a phase with inlined upstream artifacts
- WHEN it executes
- THEN its recorded tool-call log contains no call to the SDD artifact store

**Scenario: `pmc_get_context` is available to every phase**
- GIVEN any phase, including non-mutating ones
- WHEN it needs codebase structure
- THEN `pmc_get_context` is available (read-only over source structure, a
  different capability from the artifact store)

**Scenario: executors never call an interactive tool**
- GIVEN a phase needing user input
- WHEN it ends its turn
- THEN its tool-call log contains no interactive/question tool call
- AND the orchestrator relays `blockedOn.question` verbatim through its own
  question tool

### ADDED Requirement: phase templates carry their declared Hard Rules

These are assertable against composed-prompt text without running a phase.

**Scenario: `sdd-tasks` is instructed to emit the forecast lines verbatim**
- GIVEN a composed `sdd-tasks` prompt
- WHEN it is inspected
- THEN it instructs the executor to end with `Decision needed before apply:
  Yes|No`, `Chained PRs recommended: Yes|No`, and `1000-line budget risk:
  Low|Medium|High`

**Scenario: `sdd-tasks` carries the one-task-per-scenario Hard Rule**
- GIVEN a composed `sdd-tasks` prompt
- WHEN it is inspected
- THEN it states that each task maps to exactly one spec scenario and must
  be independently RED→GREEN testable

**Scenario: `sdd-design` carries the per-scenario signature Hard Rule**
- GIVEN a composed `sdd-design` prompt
- WHEN it is inspected
- THEN it requires signature, inputs/outputs and error behavior per
  scenario, precise enough for any later executor on any model

**Scenario: `sdd-apply` is told not to edit tasks.md**
- GIVEN a composed `sdd-apply` prompt
- WHEN it is inspected
- THEN it states that checkpoints are the tick marks and that no tasks.md
  edit is to be attempted

**Scenario: `sdd-explore` is told to recommend decomposition on oversized scope**
- GIVEN a composed `sdd-explore` prompt
- WHEN it is inspected
- THEN it instructs the executor to recommend decomposition when the
  request spans multiple independent subsystems

**Scenario: `sdd-propose` is told to ask 3–5 questions only on real ambiguity**
- GIVEN a composed `sdd-propose` prompt
- WHEN it is inspected
- THEN it instructs the executor to ask 3–5 product questions when the task
  description leaves genuine ambiguity, and to proceed otherwise

### ADDED Requirement: the Gatekeeper routes failures, not just reports them

The Gatekeeper is the orchestrator's check on every phase result (design §1,
§9 item 3). Relocated here from `sdd-routing`, where it had no business
belonging — it concerns phase-result evaluation, not dependency/nextRecommended
derivation.

**Scenario: unexpected writes are a Gatekeeper failure**
- GIVEN `sdd_save_artifact` returned `unexpectedWrites` for a non-mutating phase
- WHEN the orchestrator evaluates the phase result
- THEN it is treated as a failed gate, entering the escalate-don't-loop path
  (one corrective re-run, then stop and surface), not merely logged

**Scenario: the Gatekeeper validator runs on the configured default model**
- GIVEN a high-risk phase (`sdd-design` or `sdd-apply`) needing fresh-context validation
- WHEN the validator is dispatched
- THEN it uses the configured default model, dispatched through the same
  explicit grammar — not the phase's own model (which would correlate
  reviewer and author blind spots) and not a special orchestrator-model path

(The `not-read` skill-resolution-is-a-Gatekeeper-failure scenario lives
under the `skill_resolution` requirement above, not duplicated here.)

---

## MODIFIED Capability: `deterministic-model-routing`

### MODIFIED Requirement: fleet cap

Previously 8 default / 16 hard max.

**Scenario: the hard maximum is 24**
- GIVEN a `routes.json` declaring 25 routes
- WHEN it is decoded
- THEN it is rejected outright even with a committed `sizeException`
- AND 24 routes with a `sizeException` are accepted

**VERIFY-ONLY — already implemented.** This is green in the working tree
(TDD, verified in source at `disk-agent-generator.ts:74`). `sdd-tasks` must
not schedule a RED→GREEN cycle for it; it needs a verification task only.

---

## Out of scope (explicitly not specified here)

- Preventing re-delegation via `permission.task` — proven non-functional
  (§7.1); the generated blocks are cosmetic.
- Permission tiers of any shape — abandoned after the spike.
- The `sizeException` nesting bug and the `foreign-agent-scan` early-return
  — real, confirmed, and tracked as separate repo issues; neither is
  load-bearing for this design.
- Detecting writes to git-ignored paths, outside the project root, or by a
  mutating phase — declared blind spots of the fingerprint (§7.2), not
  requirements.
- **`sdd-onboard`** — the design defines it as running inline in the
  orchestrator, never delegated (§6), so it has no MCP-tool surface and no
  dispatch behavior to specify. Deliberately omitted, not overlooked.
- **Engram / `artifactStore` selection** — removed from the design entirely
  (§8); there is no dual-backend behavior to specify. Listed here so the
  absence reads as a decision rather than a gap.

---

## Verification record

Verified against design revision 6 by an independent pass
(`sdd-verify`, fresh context). Result: **fidelity clean** — zero scenarios
contradicting, distorting, or inventing behavior, and every concrete value
(grammar string, cap 24, error names, attempt cap, key shapes, fingerprint
command, alias examples) confirmed exact against the design and against
source. Five CRITICAL coverage gaps were reported and are closed in this
revision:

| Gap | Closed by |
|---|---|
| Routing/dependency computation and the archive no-override gate | new capability `sdd-routing` |
| The entire init round (2 of 7 MCP tools uncovered) | new capability `sdd-init-round` |
| `changeName` derivation and collision handling | `sdd-entry-flow` |
| Read-back-after-write durability | `sdd-status-store` |
| `sdd_parse_request` behavior and its mid-run degraded path | `sdd-entry-flow` |

Warnings also closed: Gatekeeper routing and validator model, stuck-lock
recovery for a different phase, §6 phase-body Hard Rules as composed-prompt
assertions, `sdd_checkpoint` scoping, `batchNotes` provenance,
checkpoint/`blockedOn` coexistence, executors never calling interactive
tools, `pmc_get_context` degradation, `/sdd-go` gate ordering, and the four
scenarios that were not objectively assertable (restated). Suggestions
applied: citation corrected, gateway defaults pinned, namespace shapes
pinned, cap marked verify-only, and the design's inherited inaccuracy about
`nextRecommended` representability flagged.

### Post-verify closure pass (adversarial, fresh context)

A second independent pass audited the two capabilities written *after* the
verify (`sdd-routing`, `sdd-init-round`), the remaining non-assertable
scenarios, and the design's §9.13 inaccuracy (which the verify flagged but
only the SPEC and §4 had corrected — §9.13 still carried the overbroad "every
value" phrasing). All findings closed in this revision:

| Finding | Closure |
|---|---|
| `sdd-routing`: no derivation scenarios for `explore`, `propose`, `apply` (design-required rows with no behavior pinned) | Scenarios added; the entry phase is `ready` with no upstream, `propose` blocked-until-explore-done, `apply` ready-once-tasks-done |
| `sdd-routing`: the wire from attempt-cap → `nextRecommended: resolve-blockers` was never asserted end-to-end | New scenario asserts both change together in one status computation |
| `sdd-routing`: "earliest ready phase" non-assertable (spec ∥ design both ready, no tiebreak) | Rewritten to pin `spec` as the winner with graph-order tiebreak stated; linear order enumerated |
| `sdd-routing`: `∥` notation invented (not in design, violates SPEC's own fidelity rules) | Restated as prose: spec and design are parallel (both unblocked by propose), tasks fans-in both |
| `sdd-routing`: Gatekeeper scenarios misplaced (concern phase-result evaluation, not routing) | Relocated to `sdd-phase-execution` |
| `sdd-init-round`: design's explicit "never guess" constraint had no scenario | New scenario: undetectable test command recorded as unknown, not defaulted |
| `sdd-init-round`: `testingSkill: null` write case missing (asymmetric with compose side) | New scenario: key present with value `null` when no skill registered |
| `sdd-init-round`: detect→questions→save ordering not enforceable | New scenario: save before detection refused |
| `sdd-init-round`: "merged config" non-assertable (precedence undefined) | Rewritten: user answers win over detection on conflict, detected facts fill the rest |
| `sdd-init-round`: capability title claimed "preflight" but preflight lives in `sdd-entry-flow` | Title/scope corrected; boundary stated |
| `sdd-entry-flow`: health probe write+read-back under-specified | New scenario: probe writes then reads back the same key, healthy only on match |
| Design §9.13: still said "every value nextRecommended can return is representable" (contradicted corrected §4) | Design corrected to "every phase-valued recommendation" with cross-ref to §4 |
