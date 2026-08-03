# SDD Phase Agents for sdd-plugin2 — adapted from gentle-ai

Status: DRAFT — revision 6, after a fourth independent validation pass.
§7 (permission tiers) went through two
independent validation passes and a blocking empirical spike, and was
**abandoned**: OpenCode's `permission` deny is bypassable via `pty_*`
tools, spontaneously and without an audit trail. It is replaced by
detection + prompt-level limits (§7.1, §7.2), which removes the fleet
multiplication the tier design required. Semantic-utility gateway default
is GLM-4.7-Flash with egress explicitly accepted (§8.1); mandatory
per-phase skills are injected as paths with `skill_resolution` retained
(§5.1). `HARD_MAX_ROUTES` is **24** (implemented, verified in source).

The third pass found the tier vocabulary had survived the §7 abandonment as
live normative text in §2/§3/§5/§6 — removed here — and that §7.2's
detection guardrail was both unenforceable (prose the orchestrator could
skip) and blind in ways the document didn't admit. It is now carried by
`sdd_compose_phase_prompt` + `sdd_save_artifact` in deterministic code, with
its blind spots stated.

**The fourth pass found three issues the first three missed**, all now
corrected in this revision: (1) the foreign-agent vector description named
the wrong mechanism (it described filename matching in the detector, but
the detector reads frontmatter — the real gap is the
`workspace-owned-candidate` early-return that assumes the whole workspace
dir is owned); (2) §9.12 justified a small concurrency exposure by
asserting "dispatch is serialized" as a premise, but that serialization
was prose the orchestrator was expected to honor — the same failure mode
§7.2 says guarantees must not depend on, so it is now enforced
structurally via an `inFlightPhase` dispatch lock (§4, §9.12); (3) the
`mutating` flag was never declared per phase, leaving `sdd-verify` — which
runs real tests — in an undefined state between mutating and non-mutating;
the per-phase table is now explicit in §7.2, with verify as `mutating:
true` and the protection gap stated honestly.

**§9 no longer lists open items — every one is resolved** with a reasoned
default and its rationale, so they can be argued with rather than
rediscovered. Four of those resolutions are judgment calls with real
tradeoffs (artifact size cap, cold-start behavior, Gatekeeper validator
model, degraded-mode policy) and are flagged as such.

## 1. Why this differs from gentle-ai

gentle-ai's OpenCode integration statically generates **11 agents per named
profile** (1 orchestrator + 10 phase sub-agents), one full agent set per
model. That model doesn't fit here:

- `disk-agent-generator.ts` caps the routed-agent fleet (default 8, hard max
  24 as of this change — it was 16 when this was written), keyed **by
  canonical model**, not by phase. Multiplying by 10 phases is not an option.
- gentle-ai's persistence story is OpenSpec-first; Engram is a secondary
  branch each phase file hand-codes ("in engram mode do X, in openspec mode
  do Y"), and its native status dispatcher is openspec-only — for Engram it
  falls back to the LLM recomputing status from raw memory search. PMC has no
  representation at all.
- Retrieval is a mandated two-call LLM dance (`mem_search` → `mem_get_observation`)
  per artifact, and boilerplate (orchestrator gate, executor override,
  backend branching) is repeated verbatim across 10 files.

**What we keep from gentle-ai, unchanged:** the Result Contract (including
`skill_resolution` — see §5), the Dependency Graph, the Gatekeeper's
cost-aware inline-vs-fresh-context split, sub-agent launch dedup, and the
anti-heuristic that only an explicit request (never file-count/risk)
selects SDD.

**What changes:**

- **Identity vs. content are split.** `subagent_type` only ever selects a
  *model* (via the existing `ModelRouteTaskHook` explicit-grammar path,
  §7). The *phase* is never an agent identity; it's prompt content,
  assembled server-side.
- **One MCP tool surface, not ten skill files with mode-branching prose.**
  `sdd-plugin2` exposes a small MCP server. All PMC access, artifact
  retrieval, and prompt assembly happens in that deterministic code, not in
  LLM-authored prose repeated per phase.
- **PMC is the sole persistence + local-model backend — Engram is out of
  scope entirely** (§8). No `artifactStore` choice, no dual-backend code
  path; this removes a whole abstraction we'd otherwise have had to build
  and maintain for no real benefit to this project specifically.
- **Preflight + init are merged into one persisted round.** Asked once per
  project (not once per session), stored via the MCP tool, re-asked only
  when missing or when the new request conflicts with what's stored (e.g. a
  different model than last time).
- **Upstream artifacts are inlined at compose time**, not re-fetched by the
  executor phase — zero retrieval round-trips per phase.

## 2. MCP tool surface (all deterministic, non-LLM code)

| Tool | Input | Output | Notes |
|---|---|---|---|
| `sdd_parse_request` | `projectRoot`, raw free text | `{ taskDescription, modelPhrase\|null, explicitSddMention: bool }` | Goes through our own semantic-utility gateway (§8 — config-driven, not hardcoded to one provider), with an explicit timeout and a defined degraded-mode fallback. Cheap, not free — default is a low-cost cloud model, not local inference. |
| `sdd_status` | `projectRoot` (explicit, canonicalized — never ambient/cwd-inferred, §8), optional `changeName` | the unified status object (§4) — or, when `changeName` is omitted, the **discovery shape**: `{ projectRoot, initialized: bool, changes: [{changeName, nextRecommended}] }` | Reads PMC's `agent-memory-mcp` store directly via its MCP tools (never by parsing `pmc` CLI text output). The discovery shape is what makes `nextRecommended: select-change` and the §3 collision check answerable; the full shape requires a `changeName`. |
| `sdd_init_questions` | `projectRoot` | question list (text) | Returns only what could not be inferred. Detection of stack/testing/TDD is *not* done here — it's the `sdd-init` phase's job (§6); this tool serves the residual questions that detection couldn't answer. No `artifactStore` question — always `pmc`. |
| `sdd_save_config` | `projectRoot`, project config answers | `sdd-init/{projectRootHash}` persisted | Single backend (PMC), namespaced by a canonicalized project-root hash, not a human-typed project name (§8). |
| `sdd_compose_phase_prompt` | `projectRoot`, `phase`, `changeName`, `modelReference` | `{ prompt, subagentType, mutating, worktreeFingerprint }` | Reads the phase template (§5), inlines every required upstream artifact in full (no previews), and resolves the phase's **mandatory skill paths** from the project registry (§5.1). Returns the **fully-formed `subagentType`** (`model-route:v1|sdd-mr-base|<modelReference>`) rather than parts the orchestrator assembles by hand, so dispatch identity is deterministic code output, not LLM string-building. `mutating` says whether this phase is allowed to change the worktree (per-phase table in §7.2); `worktreeFingerprint` is the pre-dispatch snapshot §7.2 checks against. **Acquires the dispatch lock**: sets `inFlightPhase` (§4) to this phase and refuses with `PhaseAlreadyInFlightError` if another phase is already in flight — serialization lives in this tool, not in an instruction the orchestrator may skip (§9.12). |
| `sdd_save_artifact` | `projectRoot`, `phase`, `changeName`, content, `worktreeFingerprint` | `{ ok, unexpectedWrites? }` | Writes to PMC, then **reads back to verify the write actually landed** (§8 — PMC's own writes aren't guaranteed atomic). This is a *durability* check only: it proves bytes persisted, not that the content is correct; the Gatekeeper's own checks (no hallucinated paths, no drift) are separate and still run. It also **re-computes the worktree fingerprint and compares it to the one issued at compose time** — for a non-mutating phase, a changed fingerprint is reported as `unexpectedWrites` (§7.2). This is what makes the detection guardrail enforceable in code rather than a prose instruction the orchestrator may skip. **Releases the dispatch lock**: clears `inFlightPhase` (§4), so the next `sdd_compose_phase_prompt` can acquire it. A phase whose dispatch crashed without reaching this tool leaves `inFlightPhase` set — resuming requires an explicit clear via the tool (re-dispatching the same phase re-acquires its own lock), which `sdd_status` surfaces so a stuck lock is visible, not silent. |
| `sdd_checkpoint` | `projectRoot`, `phase`, `changeName`, `batchId`, and either `{ totalIds }` (batch declaration) or `{ completedId, note? }` (item completion) | confirmation | The one narrow exception to "executor never persists directly" — scoped to `apply` and `verify` only (§4, §6). `note` is distilled via the same semantic-utility gateway (§8), not authored by the executor. Idempotent: safe to resend the same `completedId`. |

Every tool takes `projectRoot` explicitly and none of them infer it
ambiently — see the guardrail principle in §8.

The orchestrator's job per phase is: call `sdd_compose_phase_prompt` → call
`task()` with the `subagentType` and `prompt` it returned, verbatim → run
the Gatekeeper check on the result → call `sdd_save_artifact` with the
returned `SDD_ARTIFACT:` block **and the `worktreeFingerprint` from the
compose call**. That's the entire loop. Both the dispatch identity and the
write-detection check are carried by tool output, not assembled by the
orchestrator from prose.

## 3. Entry flow (the "one-liner" path)

```
user: "Quiero crear un Hello world en java usando sdd y el modelo
       gemini flash 3.6 tiered"
  -> /sdd-go <text>  (explicit command; also the natural-language equivalent
     "usando sdd" / "con sdd" is recognized as the same explicit-request
     gate gentle-ai already requires — never file-count/risk-based)
  -> sdd_parse_request(text)            [semantic-utility gateway, §8.1 — cheap, not free]
       => { taskDescription: "Hello world en java",
            modelPhrase: "gemini flash 3.6 tiered", explicitSddMention: true }
       [modelPhrase is the user's own words and is NOT yet a route. It must
        survive ModelRouteResolver (exact canonical -> curated alias table ->
        unique normalized). If it doesn't, that is a blockedOn question to
        the user listing candidates — never an aborted run. See §3.1.]
  -> sdd_status(projectRoot)            [discovery shape — no changeName yet]
       => { initialized: false, changes: [] }
  -> dispatch sdd-init  [detects stack/conventions/testing/TDD from the real
       project — this is LLM work, not a deterministic tool]
  -> sdd_init_questions(projectRoot)    [the residual questions detection
       could NOT answer; orchestrator asks the user, never invents them]
  -> user answers -> sdd_save_config(...)   [merged preflight+init, one round,
       persisted at sdd-init/{projectRootHash}]
  -> changeName := slug(taskDescription)    [deterministic, e.g. "hello-world-java";
       collision is visible in the discovery shape's `changes` list and
       resolved the same way gentle-ai's Change Selection rule does: exact
       name if unambiguous, otherwise ask]
  -> sdd_compose_phase_prompt("sdd-explore", changeName, modelReference)
       => { prompt, subagentType: "model-route:v1|sdd-mr-base|<ref>",
            mutating: false, worktreeFingerprint: "<snapshot>" }
  -> task(subagent_type: <subagentType verbatim>, prompt: <prompt verbatim>)
       [ModelRouteTaskHook Path A (explicit grammar). `base` is the fixed
        literal the fleet already uses; `reference` carries the model.
        The prompt is never scanned for natural triggers on this path —
        which is what keeps an ordinary "usando" inside an inlined
        artifact from failing the dispatch closed.]
  -> Gatekeeper checks result
  -> sdd_save_artifact("explore", ..., worktreeFingerprint)
       [also reports unexpectedWrites for a non-mutating phase, §7.2]
  -> repeat for propose/spec/design/tasks/apply/verify/archive per
     Dependency Graph + nextRecommended from sdd_status
```

**Every SDD dispatch uses the explicit grammar, without exception.** If the
user named no model, the orchestrator supplies the project's configured
default *inside* the grammar rather than emitting a bare `subagent_type`.
This matters: a bare `subagent_type` does **not** mean "no routing" — it
sends the hook down Path B, which scans the prompt for natural-language
triggers. Since composed prompts inline Spanish artifacts, that is the
hazardous path, not the safe one.

### 3.1 When the model phrase doesn't resolve

`modelPhrase` comes back in the user's own words and is not yet a route.
`ModelRouteResolver` accepts an exact canonical id, then a curated alias
from the frozen table, then a unique normalized match — and otherwise
fails loud with `RouteUnknownError` or `RouteAmbiguousError` (it never
guesses).

Those failures are **not** run-ending. They are a `blockedOn` question
(§4): the orchestrator relays the failure to the user with the candidate
list the resolver produced, gets an answer, and re-dispatches. Same
mechanism as any other blocking question — no new machinery.

This matters more than it looks: the alias table is deliberately small and
frozen, so ordinary phrasing misses it routinely. "gemini 3.6" is *not* in
it (the entry is `gemini flash 3.6 tiered`), which is why the walkthrough
above uses the phrase that actually resolves. A design that treated a
resolver miss as a hard failure would abort on the most common user input.
The same path covers `QuarantinedModelError` — a quarantined model is a
question for the user, not a crash.

If `explicitSddMention` is false, `/sdd-go` still requires it explicitly in
the command's own contract — natural-language requests without any SDD
mention never reach this flow at all (unchanged from gentle-ai's anti-heuristic).

## 4. Unified status schema (`sdd_status` output)

Same frozen shape gentle-ai defines, minus the OpenSpec-only fields, computed
identically regardless of backend:

```yaml
changeName: string
projectRoot: string           # explicit, canonicalized (realpath) — PMC is never trusted to infer this (§8)
status: ok | blocked          # `blocked` iff blockedReasons is non-empty or blockedOn is present
artifacts:                      # one blob per artifact in PMC, so a blob either
                                # exists or it doesn't — no `partial` (§9.13)
  explore: missing | done
  proposal: missing | done
  spec: missing | done
  design: missing | done
  tasks: missing | done
  verifyReport: missing | done
  archiveReport: missing | done
  applyProgress: missing | partial | done   # the one genuinely 3-state artifact,
                                # and now COMPUTED, not asserted:
                                # done iff checkpoints.apply.completedIds ⊇ allIds
dependencies:                   # a row for every PHASE-valued nextRecommended.
                                # `init`, `select-change` and `resolve-blockers`
                                # are not phases and have no row.
  explore: blocked | ready | all_done
  propose: blocked | ready | all_done
  spec: blocked | ready | all_done
  design: blocked | ready | all_done
  tasks: blocked | ready | all_done
  apply: blocked | ready | all_done
  verify: blocked | ready | all_done
  archive: blocked | ready | all_done
nextRecommended: init | explore | propose | spec | design | tasks | apply |
                  verify | archive | resolve-blockers | select-change
inFlightPhase: string | null     # the phase currently dispatched and not yet
                # saved. Set by sdd_compose_phase_prompt (acquires the
                # dispatch lock), cleared by sdd_save_artifact (releases it).
                # When non-null, sdd_compose_phase_prompt for a DIFFERENT
                # phase refuses with PhaseAlreadyInFlightError (§9.12) —
                # dispatch serialization is enforced in code, not in prose
                # the orchestrator may skip. A stuck lock (phase crashed
                # before saving) is visible here so it can be cleared
                # deliberately, never silently.
blockedReasons: []
allIds: []                      # every scenario id in tasks.md — the authoritative
                                # total. Neither phase's checkpoint defines it;
                                # both measure progress against it.
checkpoints:                    # keyed BY PHASE — apply and verify each keep their
                                # own, over the same id axis, and never overwrite
                                # one another (a verify CRITICAL that sends work back
                                # to apply must not erase apply's progress)
  apply:
    completedIds: []            # CUMULATIVE across every batch of this phase
    attemptCounts: {}           # id -> times declared in a batch without completing
    currentBatch:               # the batch in flight; replaced, not merged
      batchId: string
      totalIds: []              # scenario ids the executor committed to THIS run
      remainingIds: []          # derived: currentBatch.totalIds - completedIds
      batchNotes: string        # deviations from design.md discovered mid-batch only
  verify:
    # same shape
blockedOn:                      # present only when status is blocked on user input
  phase: string
  question: string              # relayed verbatim by the orchestrator's own `question` tool
  progressSummary: string       # the phase's own executive_summary — resumable-quality
```

`allIds` at the top level is what makes phase completion computable:
`applyProgress` is `done` when `checkpoints.apply.completedIds ⊇ allIds`,
`partial` otherwise. Deriving it from `currentBatch` alone would be wrong —
an abandoned batch's ids that a later, smaller batch doesn't re-declare
would silently vanish from `remainingIds`, reading "nothing left" while
scenarios remain unimplemented.

The **discovery shape** (`sdd_status` without a `changeName`) carries its
own `nextRecommended`, restricted to the answers that are meaningful before
a change is selected:

```yaml
projectRoot: string
initialized: bool
changes: [{ changeName, nextRecommended }]
nextRecommended: init | select-change | sdd-new
```

Without this, `init` and `select-change` would be unreachable — they are by
definition pre-`changeName` answers, but the full shape requires a
`changeName` to exist.

The orchestrator routes strictly on `nextRecommended` and `blockedReasons`,
same discipline as gentle-ai's Native SDD Dispatcher Guard — simplified
further here, since there's only one backend (PMC) to compute this from,
not an OpenSpec/Engram split requiring a backend-specific escape hatch.

### Checkpoint mechanics (apply / verify only)

Both `apply` and `verify` decompose their work along the **same axis**:
one scenario from `spec.md` = one task in `tasks.md` = one checkpoint unit
(see the `sdd-tasks` Hard Rule in §6 — this axis must never fork between
the two phases).

1. Before writing any code (or running any check, for `verify`), the
   executor decides its own batch scope for this run and calls
   `sdd_checkpoint` with `totalIds` — the full list it's committing to.
   Batch size is the executor's call (it can size to actual complexity),
   not a fixed number picked by the orchestrator.
2. After each item genuinely passes (test green for `apply`; check
   complete for `verify`), the executor calls `sdd_checkpoint` again with
   `completedId`.
3. **Batches accumulate; they never overwrite.** A phase like `apply`
   normally runs across several dispatches ("the next unchecked
   scenarios"), so a second batch declaration must not erase the first
   batch's progress. `completedIds` is therefore **cumulative for the
   whole phase** and only ever grows; a batch declaration replaces
   `currentBatch` alone. This is the same read-merge-write discipline the
   project already requires of `apply-progress` generally — the checkpoint
   inherits it rather than inventing a parallel rule.
4. On a batch declaration, `sdd_checkpoint` increments `attemptCounts[id]`
   for every declared id **not already in `completedIds`** — that is what
   makes the retry budget computable server-side without the executor
   having to self-report "this is a retry" (which it has no reliable way
   to know across a restart or a model switch).
5. If the run is interrupted (rate limit, restart, deliberate model
   switch) before the batch finishes, `sdd_status.checkpoint` still shows
   the full committed plan even if zero items landed — nothing is lost or
   needs re-deriving. Resuming reads `remainingIds` and dispatches exactly
   there, on whatever model is requested now. An item not in
   `completedIds` is always treated as not-done, even if partial code
   exists (matches the TDD RED-start assumption).
6. `batchNotes` is not a reasoning transcript. `design.md` already carries
   the per-scenario signature/contract (§6 strengthens this), and that's
   inlined into every dispatch by `sdd_compose_phase_prompt` regardless of
   restart — so `batchNotes` only needs to capture *deviations discovered
   mid-batch that design.md couldn't have anticipated* (e.g. a shared
   error type invented while implementing an earlier item in the same
   batch, that later items must stay consistent with). The
   semantic-utility gateway (§8.1) distills it after each completed item,
   off the executor's own token budget.
7. **Retry budget (new — not present in gentle-ai, needed because our
   checkpoint makes resuming an item cheap enough to loop on forever if
   unbounded).** Once `attemptCounts[id]` (step 4) passes a fixed cap
   (default 3, matching the Gatekeeper's own one-retry-then-stop
   discipline), **`sdd_status` itself** returns `status: blocked` with
   `blockedReasons` naming the stuck id and its attempt history. The cap
   is enforced in the same deterministic code that owns the counter — not
   by the orchestrator noticing a number and choosing to stop, which
   would reintroduce exactly the LLM-discretion problem that moving
   `attemptCounts` server-side (step 4) was meant to remove.

### Blocking questions mid-phase

Phase executors never call an interactive tool themselves — they are
dispatched, non-interactive subagents with no live turn with the user;
only the orchestrator (the primary agent) has that. This is exactly
gentle-ai's own split too: its "Lossless Blocking Prompts" handling lives
in `sdd-orchestrator.md`, not in any phase `SKILL.md` — phase executors
there are equally bound by "final output must be text, not a tool call."

So when a phase needs user input mid-way (`sdd-propose`'s clarifying
questions being genuinely unresolvable from context, say), it ends its
turn early with `status: blocked` and a `blockedOn` block (§4) instead of
trying to call `question` itself. The orchestrator relays `blockedOn.question`
to the user via its own `question` tool, and on an answer, re-dispatches
the *same phase* (not a checkpoint batch — most phases are single-document,
one-shot; only apply/verify have item-level batches) via
`sdd_compose_phase_prompt`, inlining both the user's answer and
`blockedOn.progressSummary`.

That summary costs nothing extra to produce: every phase already must
return `executive_summary` as part of the Result Contract, blocked or not
— the only addition is a Hard Rule that a *blocked* summary must itself be
resumable-quality (enough for a fresh dispatch, possibly on a different
model, to continue without re-deriving what was already reasoned out). No
local-model distillation call needed here, unlike `batchNotes` — it's the
executor's own required output, not a separate derived artifact.

`checkpoint` and `blockedOn` are not mutually exclusive: if `apply` or
`verify` hits a genuine blocking question mid-batch, `checkpoint` keeps
whatever `completedIds` already landed (untouched — the batch isn't
abandoned) while `blockedOn` explains why the *current* item stopped.
Resuming does both at once: the user's answer is inlined, and the executor
continues from `remainingIds` starting with the item that was blocked.

## 5. Shared phase contract (replaces `sdd-phase-common.md`)

Not repeated per phase file — lives once, referenced by the compose tool,
prepended automatically to every composed prompt:

> You are the executor for this single SDD phase. Do not launch sub-agents,
> do not call `task`/`delegate`. Every SDD artifact you need (spec, design,
> tasks, prior progress) is already inlined below — do not query the SDD
> artifact store yourself, under any tool name. `pmc_get_context` for
> codebase navigation is available and encouraged where relevant (it's
> read-only over source structure, not the artifact store — same as the
> `pmc get-context` discipline every coding agent in this project already
> follows).
>
> **Skills to load before work** (listed below by path): these are
> mandatory for this phase, not suggestions. Read every one of them
> before you start, and follow them. If a path does not resolve, do not
> proceed silently — say so in `skill_resolution`.
>
> You do not save your own artifact: the orchestrator persists it for you
> via `sdd_save_artifact`. The single exception is `sdd_checkpoint`, which
> you MUST call yourself if this phase's instructions below tell you to —
> no other persistence tool is ever yours to call.
>
> Your final output must be text, not a tool call, laid out in exactly
> this order:
>
> 1. the fenced `SDD_ARTIFACT:` block containing your artifact content;
> 2. then, as the last thing in the message, the Result Contract fields:
>    `status`, `executive_summary`, `artifacts`, `next_recommended`,
>    `risks`, `skill_resolution`.

This collapses gentle-ai's "Artifact Retrieval / Artifact Persistence /
Return Envelope" sections (each with its own mem_search choreography) into
one short block, because the compose tool already did the artifact
retrieval and the orchestrator already owns persistence. What's explicitly
*not* collapsed away is codebase navigation (`pmc_get_context`) — that's a
different PMC capability (read-only over source structure, not SDD state)
and stays available precisely because restricting it would contradict this
project's own established workflow discipline.

### 5.1 Mandatory skills (static per-phase map)

Phase executors do receive this project's standards, delivered the way
this project already mandates for any delegation: **paths, not generated
summaries**, so the skill author's full intent survives instead of being
compressed by whoever composed the prompt.

The map is **static and per-phase** — `phase → skill names`, resolved to
absolute paths against the project's skill registry at compose time. Two
properties make it work:

- **It contains only what is mandatory for that phase**, never "this might
  be useful." That is what lets the shared contract state the read as a
  hard requirement rather than a suggestion — and it's what keeps an
  executor from quietly skipping it as optional noise.
- **It's static, so it's deterministic** — consistent with every other
  tool in §2 being non-LLM code. No semantic matching, no per-run
  variance, no LLM judgment about which skills apply.

Illustrative, not authoritative (the real map is whatever the project's
registry defines): `sdd-tasks` requires the chained-PR and work-unit-commit
standards, because §6 has it emit the chained-PR/1000-line forecast and
those standards define what that forecast means; `sdd-apply` requires the
project's testing and commit standards; planning phases that produce no
code require correspondingly less.

**Resolution failure is never silent — and is caught before dispatch.**
Because resolution happens in `sdd_compose_phase_prompt` (deterministic
code) rather than in the orchestrator's context, a mapped skill name that
doesn't resolve to a readable path is detectable at compose time, and
compose fails loud rather than emitting a prompt that silently omits a
mandatory standard.

`skill_resolution` is therefore kept but **re-scoped**: gentle-ai's
four-value vocabulary (`paths-injected` / `fallback-registry` /
`fallback-path` / `none`) describes *its* architecture, where the
orchestrator resolves skills and can lose its cache to compaction. Two of
those values are unreachable here. The values that mean something in this
design are:

- `paths-injected` — paths were supplied and the executor read them.
- `not-read` — paths were supplied and the executor did **not** read them.

That second value is the one worth having: it's the executor self-reporting
non-compliance with a mandatory read, which is a Gatekeeper failure (§1),
not a cosmetic detail.

Cost note: paths cost ~10 tokens each and the content is read lazily by the
executor, inside its own context, only when it acts on them. Inlining full
skill *content* was considered and rejected — it would be re-sent on every
checkpoint resume (§4), multiplying a cost the design already pays for
spec+design+tasks, for material that is conditionally relevant rather than
strictly required.

## 6. Phase prompt bodies

Each phase template below is what `sdd_compose_phase_prompt` fills in *after*
the shared contract (§5) and *before* the inlined upstream artifacts and
task context. Kept intentionally short — no backend branching, no retrieval
instructions, no repeated gate boilerplate.

### sdd-init
Detect stack, conventions, testing capability, and strict-TDD support from
the actual project files (never guess). Report what you could detect, and
list separately what genuinely could not be inferred — the orchestrator
asks the user those (via `sdd_init_questions`) and persists the merged
result; you never ask the user directly and never persist the config
yourself. Your artifact is the detected half: stack, testing command,
strict-TDD support, conventions. There is no `artifactStore` question —
persistence is always PMC (§8).

### sdd-explore
Investigate the codebase/idea and compare approaches. No edits. If the
request scope spans multiple independent subsystems, say so and recommend
decomposition instead of proceeding. Output: findings + open questions, no
proposal yet.

### sdd-propose
Turn the exploration (if any) and the task description into `proposal.md`:
intent, scope, approach, explicit non-goals. Ask the product/business
clarifying questions (3–5) if the task description leaves real ambiguity;
otherwise proceed.

### sdd-spec
Write delta requirements/scenarios (ADDED/MODIFIED/REMOVED/RENAMED) strictly
within the proposal's scope. Do not invent requirements the proposal didn't
imply.

### sdd-design
Architecture, data flow, concrete file changes, and rationale, answering the
proposal directly. Flag any targeted pre-existing-code cleanup the change
requires; no unrelated refactors. **Hard Rule:** for every scenario, specify
its function signature, inputs/outputs, and error behavior precisely enough
that an executor implementing it later — on any model, in any run — needs no
additional context beyond this document.

### sdd-tasks
Break spec + design into an ordered, actionable task list. **Hard Rule:**
each task must map to exactly one scenario from spec.md and must be
independently RED→GREEN testable in isolation. Never split one scenario
across multiple tasks; never bundle multiple independently-testable
scenarios into one task. If a scenario is too coarse to implement as a
single testable unit, that's a signal to revisit spec granularity, not to
invent an ad-hoc task split. End with the Review Workload Forecast lines
verbatim: `Decision needed before apply: Yes|No`, `Chained PRs recommended:
Yes|No`, `1000-line budget risk: Low|Medium|High`.

The budget is **1000 changed lines** (raised from gentle-ai's inherited 400).
The number appears inside the verbatim line, so it is a three-way contract:
this section, the SPEC scenario that asserts the composed prompt carries it,
and the tasks artifact that emits it. Changing it means changing all three
together or they contradict.

### sdd-apply
Implement the next unimplemented scenarios, following spec/design exactly.
Decide your own batch scope for this run and declare it via `sdd_checkpoint`
(`totalIds`) before writing any code; call `sdd_checkpoint` again
(`completedId`) immediately after each scenario's test goes green — never
batch checkpoints up for the end. Follow strict TDD if the project's config
says so.

Do **not** try to edit tasks.md to tick items off: with PMC as the sole
store there is no tasks.md on disk, checkbox state is derived from
`checkpoints.apply.completedIds` (§4), and §5 forbids you calling any
persistence tool other than `sdd_checkpoint`. Your checkpoints *are* the
tick marks.

### sdd-verify
Independent verification: source inspection plus real test execution,
scenario by scenario. Declare your batch via `sdd_checkpoint` before
starting, and checkpoint after each scenario is verified — same discipline
as apply. Report CRITICAL / WARNING / SUGGESTION against spec + tasks, not
against your own implementation preferences. A contradiction escalates; do
not start another fix loop yourself.

### sdd-archive
Produce the archive report: the change's delta spec reconciled into a
consolidated statement of the capability's current behavior, plus a
closing summary. Requires `verify-report` clean (no unresolved CRITICAL)
and no unchecked tasks — no override.

Note this phase **authors**, it does not write: with PMC as the only store
(§8) there is no `openspec/specs/` tree to edit, so "merging into the main
spec record" means emitting the consolidated spec as this phase's artifact,
which the orchestrator persists at `sdd/{projectRootHash}/specs/{capability}`
via `sdd_save_artifact`. The phase never needs to touch the filesystem to
do its job — so it is one of the non-mutating phases whose worktree
fingerprint must not change (§7.2).

### sdd-onboard
Runs inline in the orchestrator (not delegated) — guided walkthrough of one
full cycle on the user's real codebase, pausing for confirmation at each
phase regardless of execution mode.

## 7. Permission enforcement — attempted, then abandoned

**Outcome first:** the tiered-permission design in this section was tested
and **does not work** — OpenCode's `permission` deny is bypassable via
`pty_*` tools, spontaneously, with no audit trail (§7.1). What ships
instead is detection plus prompt-level limits (§7.2). The reasoning that
led here is kept because it documents two mechanisms (the `baseTemplate`
axis, Path A dispatch) that remain correct and reusable.

Trusting the phase prompt alone to say "you're read-only this run" is not
enough — this codebase never trusts prompt text as a security boundary
(`ModelRouteTaskHook`: "the prompt is data... the canonical identity
controls every gate"). Two options were ruled out first:

- **Runtime/on-the-fly agent generation** (materialize a fresh, permission-
  scoped agent file the moment a dispatch needs one) is explicitly
  forbidden by a standing decision in this repo
  (`architecture/model-routing-boot-attestation-decision`, superseding
  `plan/config-hook-fleet-agents`): a runtime hook must not
  register/generate agents or bypass `DiskAgentGenerator` + boot manager +
  health/version + live readback + canary + signed attestation. An agent
  materialized mid-session would skip canary and attestation entirely.
- **A capability-marker + enforcement hook** (mirroring `ModelRouteTaskHook`
  but for tools instead of models) would work but adds a second parallel
  hook and marker grammar for something the existing pre-start pipeline can
  already provide directly.

**Resolution: the tier rides on `baseTemplate`, an axis the fleet already
has.** An earlier revision of this section proposed keying the fleet by
`(model, tier)` with `tools` grants in the agent file. An independent
validation pass against the real code found that version unimplementable —
it would have required changing `routes.json`'s schema, its decoder's
dedupe rule, `ManifestRouteEntry`, `hashHostName`, the hook's manifest
lookup, the renderer, *and* the readback comparator, i.e. exactly the
pipeline this section claims to leave intact, plus it blew the fleet cap
(13 current routes × 3 tiers = 39 vs. `HARD_MAX_ROUTES = 16`). What
follows replaces it, and is grounded in three facts verified in the source:

1. **`permission` is already emitted and is readback-safe.**
   `buildCanonicalRoutedAgentDefinition` already emits
   `permission: { task: { '*': deny } }`, and `compareResolvedAgentDefinition`
   only diffs `mode`/`hidden`/`model`/`description` — `permission` sits in
   `allowedKeys` and is never compared, whereas `tools` *is* in the
   diff-producing list. So expressing a tier as **`permission`** extends a
   field the pipeline already writes and tolerates; expressing it as
   `tools` would trip `ROUTED_AGENT_DEFINITION_MISMATCH`. This is why the
   old draft's "real `tools` grants" was wrong.
2. **The fleet already supports several hosts per model, distinguished by
   `baseTemplate`.** `hashHostName` mixes `baseTemplate` with the canonical
   id, so two entries for the same model under different templates already
   produce different, collision-safe host names.
3. **The declared grammar already carries that axis.**
   `model-route:v1|<base>|<reference>` — `parseModelRouteGrammar` yields
   `{ base, reference }`. There is no need to invent a second marker
   grammar (the objection that killed the capability-marker option): the
   tier *is* `base`.

That reasoning was sound, and it is preserved above because the
`baseTemplate` axis remains the right mechanism *if* tiers are ever
revived. **But the premise underneath it failed empirically, so the tier
system is abandoned.** See §7.1 for the evidence and §7.2 for what
replaces it.

### 7.1 The spike, and why tiers were abandoned

The premise was tested before anything was built, and the fallback was
agreed *before* the result was known, so the outcome couldn't rationalize
the decision. Full notes:
`docs/plans/2026-08-01-permission-enforcement-spike-notes.md`. Run against
OpenCode **1.18.11** (the installed binary; the repo pins 1.18.9 — a
caveat on the result's transferability).

Two observables were measured separately, because "the key survives
parsing" and "the key is enforced" are different questions:

**Observable 1 — survives parsing: YES.** Unlike `permission.task` (which
an earlier spike found stripped entirely), both `edit: deny` and
`bash: deny` survive. `GET /agent` showed explicit
`{"permission":"edit","pattern":"*","action":"deny"}` entries layered after
the global defaults.

**Observable 2 — actually enforced: PARTIALLY, AND BYPASSABLE.** Deny does
remove the named tools from the agent's toolset (a control agent exposed
18 tools including `bash`/`edit`/`write`; the denied agent exposed 15,
missing exactly those three). **But `pty_spawn` / `pty_write` / `pty_read`
remain available and are never checked by the permission engine.** A
denied agent, asked only to "write a file and run a bash command" — with
no instruction to circumvent anything — silently used a PTY tool and
created the file on disk, with zero `evaluated permission=` lines in the
server log, versus the control run where every call logged an explicit
allow decision.

That last detail is what settles it. The bypass isn't adversarial; it's
the **ordinary fallback path a model takes when its usual tool is
missing**. So the restriction doesn't prevent the write — it reroutes it
through a channel that leaves *no permission audit trail at all*. That is
arguably worse than not restricting, because it buys a false sense of
enforcement.

Chasing this further would mean maintaining a denylist of escape hatches
(`pty_*` today, whatever exists tomorrow), and `pty` isn't even
expressible: the SDK's `permission` type has no such key. That's an
unwinnable game for a guardrail whose actual threat model is model error.

### 7.2 What replaces it: detection, not prevention

Per the pre-agreed fallback:

- **Prompt-level limits.** Each phase template states its own boundary
  explicitly — `sdd-explore` is told it must not modify files, and so on.
  Weak on its own, which is why it is not on its own.
- **Fingerprint detection, enforced in code.** `sdd_compose_phase_prompt`
  captures a worktree fingerprint before dispatch and returns it along with
  a `mutating` flag; `sdd_save_artifact` re-computes it and reports
  `unexpectedWrites` when a non-mutating phase changed the tree (§2). The
  orchestrator treats that as a **Gatekeeper failure**, routing it through
  the same escalate-don't-loop path as any other failed gate.

Putting the check inside the two tools that already run on every phase is
deliberate. An earlier draft told the orchestrator to "run `git status`
after read-only phases" — but §2's whole principle is that guarantees live
in deterministic code, and that draft made the design's *only* remaining
safety property depend on an LLM remembering a prose instruction. Now it
can't be skipped.

**The `mutating` flag is declared per phase, not inferred.** This is the
table `sdd_compose_phase_prompt` reads to set the flag it returns —
deterministic, no LLM judgment about whether a given run should be allowed
to write:

| Phase | `mutating` | Why |
|---|---|---|
| `sdd-init` | false | detects, never writes project files |
| `sdd-explore` | false | investigation only, no edits |
| `sdd-propose` | false | produces an artifact via the Result Contract |
| `sdd-spec` | false | same |
| `sdd-design` | false | same |
| `sdd-tasks` | false | same |
| `sdd-apply` | true | implements scenarios — writes source code by definition |
| `sdd-verify` | true | runs real tests (§6), which write build/test artifacts (`__pycache__`, caches, coverage data) |
| `sdd-archive` | false | authors a consolidated artifact, never touches the filesystem (§6) |

`sdd-verify` is the one that needs saying out loud. Running tests is
inherently mutator of the worktree — a test runner that wrote nothing
wouldn't be exercising anything — so verify is `mutating: true`. That
means the fingerprint detection does **not** protect against a verify
executor that edits source code to make tests pass: a mutating phase's
changed fingerprint is expected, not reported. The protection there is the
Gatekeeper (which reviews verify's report against spec + tasks) and verify's
own discipline (§6: "Report CRITICAL / WARNING / SUGGESTION against spec +
tasks, not against your own implementation preferences. A contradiction
escalates; do not start another fix loop yourself"). This is a weaker
guarantee than detection, and it is chosen over the alternative — a
maintained exclusion list of test-cache patterns (`__pycache__`, etc.) that
verify's fingerprint would ignore — because that list is the same shape as
the `pty_*` denylist §7.1 rejected: a forever-incomplete catalog of
exceptions, this time for detection rather than prevention. An executor
that renames a source file looks the same to a filter-based fingerprint as
one that writes a cache directory; only the Gatekeeper distinguishes them.

**What this does not see — stated plainly rather than implied.** The
fingerprint is computed over the worktree, so it is blind to:

- **Anything git ignores.** In this repo that includes `.opencode/` (the
  routed-agent fleet, manifest, lock, journal), `.planning/` (PMC's own
  state), `dist/`, `node_modules/`. A phase that writes there is invisible
  to this check. Worth being explicit because `.opencode/` is exactly where
  the deferred foreign-agent shadow-file vector lives — that item is closed
  as "not load-bearing for this design," and this guardrail does not cover
  it either. Two limitations that lean on each other should be visible, not
  each pointing at the other.
- **Writes outside the project root.** The spike's own bypass is
  `pty_spawn` — an arbitrary shell. A `cd ..` or a write to `$HOME` is
  model error (the stated threat model) and is not observed.
- **A non-git target project.** The fingerprint needs a fallback there
  (e.g. an mtime/size walk of the project root) or the check silently
  degrades to nothing.

The fingerprint must also be a **snapshot diff, not an absolute state
check**: during a real run the tree is dirty by construction (`apply` ran
two phases ago), so only the delta between compose-time and save-time is
meaningful. And it must cover untracked files, which `git diff` alone does
not show.

This is a weaker guarantee than a real sandbox and is chosen deliberately:
the realistic risk is a confused model "helpfully" editing something, and a
fingerprint delta catches that immediately and cheaply. Prevention would be
worth its cost against a genuinely untrusted model; against model error,
detection is proportionate — provided its blind spots are known rather than
assumed away.

What this buys back, beyond simplicity: **no fleet multiplication**. The
fleet stays keyed by model alone — one host per model, `baseTemplate`
unchanged, no `base` plumbing, Path B untouched, no tier vocabulary to
validate, and no doubling of the sequential boot canaries. Every "required
code change" the tier design implied is now unnecessary.

`HARD_MAX_ROUTES` was briefly raised to 64 for the tiered design and is
now **24** — sized for ~20 connected models at one host per model, plus
slack. Lowering it also narrows the preexisting `sizeException` bypass
window back down.

One thing from the tier design is worth keeping regardless: **dispatch via
Path A** (`model-route:v1|<base>|<model>`) rather than Path B. When the
grammar matches, `parseModelRouteGrammar` runs first and the prompt is
never scanned for natural-language triggers.

To be precise about what that avoids — the hazard is **failing closed**,
not misrouting. `parseNaturalModelIntent` takes everything from the trigger
to end-of-input as the reference, so a long composed prompt containing
"usando" yields `BYTE_LIMIT_EXCEEDED` (malformed), and two occurrences
yield ambiguous; both refuse to dispatch. The dispatch doesn't go to the
wrong model, it doesn't go at all — and it can't be repaired without
rewriting already-persisted artifacts. Path A makes that structurally
impossible. The benefit is real and independent of permissions; it just
isn't a misrouting risk.

## 8. PMC as sole persistence + local-model backend

**Decision:** `sdd-plugin2` depends on PMC hard, not optionally. Engram is
dropped from the design entirely — `artifactStore` stops being a choice.
Advantages: collapses the dual-backend abstraction we'd otherwise maintain
for no benefit specific to this project, removes one question from
`sdd_init_questions`, and gives the semantic-utility gateway (§8.1) a
proven default to point at instead of inventing one from scratch.

### 8.1 Semantic-utility gateway default: GLM-4.7-Flash

`sdd_parse_request` and `batchNotes` distillation are not free — the
earlier framing of "local Gemma, ~free" assumed Ollama; the actual default
we're adopting is a cheap **cloud** model, following existing precedent in
this ecosystem rather than inventing an integration from scratch:
`memory-context`'s own
`tools/project-memory-context/cli/name-communities.mjs` already calls the
GLM Flash family (BigModel/Zhipu, OpenAI-compatible `/chat/completions`
shape) for a different semantic task (community naming), with its key read
from `BIGMODEL_API_KEY` at call time — never hardcoded, per
`openspec/specs/community-naming/spec.md:37` in that repo.

We inherit that integration shape but pin a **newer model than the
reference**: `name-communities.mjs` currently pins `glm-4-flash`; this
design specifies `glm-4.7-flash`. That divergence is deliberate and has
since been validated against the live endpoint (see below) — the endpoint,
auth scheme, and payload shape are unchanged, only the model id.

The gateway stays the same abstraction described below (call-site code
never talks to a provider directly), so the model id is config, not a
commitment. Config, not code, picks the provider — a JSON file (exact
path/name TBD at implementation time, following this repo's existing
`config/model-routing/routes.json` convention) holding:

```json
{
  "endpoint": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  "model": "glm-4.7-flash",
  "apiKeyEnvVar": "BIGMODEL_API_KEY",
  "timeoutMs": 8000,
  "maxTokens": 512
}
```

**Verified live**, not assumed: a probe against this exact endpoint and
model id returned HTTP 200 with `"model":"glm-4.7-flash"` echoed back.

That probe also surfaced a gotcha worth designing around: **`glm-4.7-flash`
is a reasoning model.** With `max_tokens: 5` it spent all five tokens on
`reasoning_content` and returned an empty `content`. So the gateway must
budget `maxTokens` generously enough to cover reasoning *plus* the answer,
and must treat an empty `content` with a non-empty `reasoning_content` as
a truncation failure rather than as a valid empty result — otherwise
`sdd_parse_request` would silently return nothing and `batchNotes` would
silently produce empty notes. (Open item 5 covers the fallback provider for
when the endpoint is unreachable; this is the distinct case where it
answers but the answer is empty.)

**Data egress — reviewed and accepted.** This gateway sends data to a
third-party endpoint, and that is an accepted property of the design, not
an oversight. What leaves the machine:

- `sdd_parse_request`: the user's raw request text (typically one sentence).
- `batchNotes` distillation: the diff and test output of each completed
  scenario — i.e. **source code from the user's project**.

The decision to accept this was made explicitly with that second item in
view. Anyone adopting this design in a context where source code may not
leave the machine must change the gateway's config (§8.1 makes the
provider swappable precisely so this is a config decision, not a fork) or
disable `batchNotes`, which is an optimization and never load-bearing for
correctness (§4).

**Hard Rule, non-negotiable:** the API key is never read from this JSON
file, never hardcoded anywhere in `sdd-plugin2`, and never logged or
persisted to PMC/memory — only `apiKeyEnvVar` (the *name* of an
environment variable) lives in config; the actual secret is read from
`process.env[apiKeyEnvVar]` at call time, same discipline
`name-communities.mjs` already follows. Swapping to a different
OpenAI-compatible provider (including pointing back at a local Ollama
instance, if that's ever preferred) is an edit to this JSON file, not a
code change — this is exactly the swappable-gateway property §8.2 already
required, just with a concrete default now instead of a placeholder.

### 8.2 PMC reliability mitigations (audited)

This decision was audited against PMC's actual source
(`C:\Users\aabad\documents\code\ia\memory-context`), because a hard
dependency inherits PMC's own reliability gaps — those are now catalogued
in that repo's own `riesgos.md` for the PMC side to work independently.
The subset that changes **our** design (mitigations we own, since we can't
wait on PMC's own fixes):

**Guardrail principle:** every mitigation below is defense-in-depth we'd
want to keep regardless of PMC's internal state — none of them assumes a
specific bug stays broken forever, and none of them needs to be *removed*
if/when PMC fixes the underlying issue on its own timeline. That's the bar
each row was written to: "does this still make sense, unchanged, the day
PMC fixes this?" If a mitigation only made sense while the bug existed, it
was rewritten as an abstraction we own instead (see the gateway row — this
is the one that needed correcting against that bar).

| PMC risk (confirmed by source audit) | Mitigation in sdd-plugin2 | Still valid after PMC fixes it? |
|---|---|---|
| No explicit "active project" parameter anywhere in the PMC CLI or `pmc-query` MCP server — confirmed root cause of the `pmc doctor` cross-project bug we hit manually (`checkMemoryDbPath` reads `MEMORY_DB_PATH` without cross-checking cwd/project) | Every one of our MCP tools passes an explicit, `realpath`-canonicalized `projectRoot` on every call — we never rely on PMC's ambient/last-used project state. Every topic key we write is namespaced by a hash of that canonical root (`sdd-init/{projectRootHash}`, `sdd/{projectRootHash}/{changeName}/...`), layered **on top of** whatever project-scoping `agent-memory-mcp` does internally, not instead of it. | Yes — if PMC adds native project-scoping later, our explicit param and our own namespace prefix become redundant, never conflicting: we'd just be passing correct data to a now-also-correct API. |
| `pmc doctor` checks installation mechanics, not real capability — confirmed false negative/positive (e.g. `agent-memory-mcp` flagged "not installed" while reachable via MCP anyway) | We never consume `pmc doctor`'s exit code or parse its text at all, as a permanent architectural choice — not a workaround for today's false negatives. Our own preflight health probe does its own real round-trips: an actual write+read-back against `agent-memory-mcp`, and a direct ping of the semantic-utility gateway's configured endpoint (§8.1). | Yes — independent of whether `pmc doctor` ever gets fixed, since we were never depending on it in the first place. |
| TOCTOU race in `SyncLock.acquire`; non-atomic writes in `file-hash-store.mjs` (lost updates under concurrent `refresh-context`) | `sdd_save_artifact`/`sdd_checkpoint` always **read back after writing** to confirm the write landed. **Honest framing: this is a durability check, not concurrency control.** It proves our bytes were there at time T; it does not stop a concurrent writer clobbering them at T+1. That gap is real for `sdd_checkpoint` specifically — it's a read-modify-write over a cumulative `completedIds` list, called often, and PMC's own background enrichment runs concurrently by default. Idempotency on `completedId` does not save this: re-sending a *different* id after a lost update still loses the first. Genuine mitigation would need PMC-side atomicity or our own lock (a lock
over the *checkpoint key* coordinating with PMC's concurrent enrichment —
distinct from the dispatch lock added in §9.12, which serializes SDD phase
dispatches only and does not touch PMC's own writers). | Yes, under that weaker reading — read-after-write stays worth doing against any store. But it should not be counted as closing the concurrency risk, and this row previously overclaimed that it did. |
| No default timeout in `local-model-provider.mjs`; PMC's own enrichment is sequential with no fallback if its backend is down; fallback chain assumes a second provider is configured without verifying | We own a small internal **semantic-utility gateway** (§8.1) — `sdd_parse_request` and the `batchNotes` distillation call *through it*, never directly against a hardcoded provider call, and never through PMC's own enrichment fallback chain. Config (not code) picks the provider, with our own explicit timeout and a defined degraded path (a secondary provider for `sdd_parse_request` — open item 4; empty/skipped note for `batchNotes`, which is an optimization, not load-bearing correctness). | Yes, by construction — the calling code (`sdd_parse_request`, `batchNotes`) only ever talks to our gateway interface. If PMC's enrichment pipeline later gets a verified timeout/fallback story, swapping the gateway's config to route through PMC instead is a one-line edit, not a redesign. This is the row that was originally written as a permanent "bypass PMC" decision — corrected to an owned, config-driven abstraction instead. |
| No versioned/JSON output schema for `pmc doctor`/`get-context`; text meant for humans, not programmatic parsing | We never parse `pmc` CLI text output — every read/write goes through `agent-memory-mcp`'s MCP tools directly (structured JSON in/out). This was already the plan for unrelated reasons (§2); the audit just confirms it's also the safe choice here. | Yes — this is a choice of integration layer (store-level, not CLI-level), independent of whether the CLI's text output ever becomes versioned/parseable. |

## 9. Resolutions

Every open item is resolved below. These are reasoned defaults, not
research results — each is a judgment call that can be overridden, and the
reasoning is given so it can be argued with rather than just accepted.

**1. `/sdd-go` contract.** Gates, in order, all fail-closed:
(a) `explicitSddMention` must be true — an SDD run is never inferred;
(b) preflight health probe passes or degrades per item 5;
(c) `sdd_status` discovery shape resolves the change (or creates one);
(d) `sdd_parse_request` runs *before* any dispatch, so a resolver miss
becomes a question (§3.1) rather than a failed dispatch. The command never
implements anything itself; it only routes to `nextRecommended`.

**2. Artifact size cap: hard limit, explicit failure, no auto-summarization.**
`sdd_compose_phase_prompt` fails loud when the composed prompt exceeds a
configured budget, naming which artifact blew it. Auto-summarizing would
silently change what the phase sees, which breaks the reproducibility
property the whole inline-everything design exists for — a phase that
"succeeded" against a summary it didn't know was a summary is worse than a
phase that refused to start. A blown budget is a signal the change is too
big and should be split, which is information the user wants.

**3. Gatekeeper validator runs on the configured default model, dispatched
through the same explicit grammar.** Not the phase's model: independence is
the point of a fresh-context check, and reusing the phase's model
correlates the reviewer's blind spots with the author's. Not "the
orchestrator's own model" as a special case either — that would be the one
dispatch in the design that bypasses the routing pipeline.

**4. No secondary provider for `sdd_parse_request`.** On timeout it fails
loud and the orchestrator asks the user directly for task + model — a
two-field question a human answers in seconds. Wiring a second cloud
provider doubles the config surface, the key handling, and the failure
modes of a step whose human fallback is trivial. (Distinct from the
empty-`content` truncation case, §8.1, which is a retry with a larger
`maxTokens`, not a provider switch.)

**5. Preflight degrades; it never hard-refuses.** Per capability:
PMC store unreachable → **refuse** (nothing can be persisted, so nothing
can be resumed); gateway unreachable → **degrade**, ask the user for
task + model directly and skip `batchNotes` for the run; `pmc_get_context`
unavailable → **degrade**, phases still work with plain reads. Only the
persistence layer is load-bearing enough to stop on.

**6. Config path: `config/sdd/semantic-gateway.json`**, mirroring the
existing `config/model-routing/routes.json` convention.

**7. Cold start refuses with an actionable message; it never
auto-bootstraps.** `pmc init` / `map-project --all` are heavyweight, write
outside the SDD namespace, and can take a long time on a large repo —
silently triggering that from inside a "write me a hello world" request is
a surprise with real cost. The message names the exact command to run.

**8. `QuarantinedModelError` → resolved in §3.1**, same `blockedOn` path as
any other resolver failure. A quarantined model is a question for the
user, not a crash.

**9. Phase→skills map — §9.1 below.** Proposed, still worth your review,
but it is written rather than deferred.

**10. Worktree fingerprint.** In a git repo: hash of
`git status --porcelain=v1 -uall` output (which covers tracked
modifications *and* untracked files, closing the `git diff` gap noted in
§7.2), plus the `HEAD` sha to catch commits. Outside a git repo: a walk of
the project root recording `(relpath, size, mtime_ns)`, hashed. Ignored
paths are out of scope in both cases — stated as a known limit in §7.2,
not silently absent.

**11. Testing skill resolution: by config key, not by stack sniffing at
compose time.** `sdd-init` writes a `testingSkill` field into the project
config (§2 `sdd_save_config`); §9.1's `apply`/`verify` rows reference *that
key*, not a name they derive. So the map stays static — it maps to a key
whose value was decided once, at init, and persisted. If no testing skill
is registered, the value is `null` and those rows resolve to nothing: a
missing optional standard is `none`, not a hard failure, because plenty of
projects have no registered testing skill and SDD must still run there.

**12. `sdd_checkpoint` uses optimistic concurrency, and dispatch
serialization is enforced structurally.** Read the current record with its
version, apply the change, write conditional on the version being
unchanged; on conflict, re-read and retry once; on a second conflict, fail
loud rather than silently losing an update. This is the one write in the
design that is a read-modify-write over a cumulative list, so it's the one
that needs it.

An earlier revision of this item justified the small exposure by asserting
"dispatch is serialized (one phase in flight)" as a premise — but that
serialization was prose the orchestrator was expected to honor, which is
exactly the failure mode §7.2 says guarantees must not depend on. **It is
now enforced in code**: `sdd_compose_phase_prompt` acquires a dispatch lock
(`inFlightPhase`, §4) and refuses with `PhaseAlreadyInFlightError` if
another phase is in flight; `sdd_save_artifact` releases it. Two
concurrent `task()` calls from an orchestrator that forgot to wait would
not both proceed — the second hits a structural refusal, not a hoped-for
convention. (The optimistic concurrency above is still kept as
defense-in-depth, because the lock does not stop PMC's own background
enrichment, which writes different keys concurrently by default — §8.2
names that as the realistic contender, and read-after-write there remains a
durability check, not concurrency control.)

**13. `partial` is dropped for stored artifacts.** With one blob per
artifact, a blob either exists or it doesn't: `missing | done`, uniformly,
for `explore`/`proposal`/`spec`/`design`/`tasks`/`verifyReport`/
`archiveReport`. `applyProgress` keeps three states because it genuinely
has them, and they are now *computable* rather than asserted:
`done` iff `checkpoints.apply.completedIds ⊇ allIds`, `partial` if
non-empty but not covering, `missing` if empty. `dependencies` gains rows
for `explore` and `propose` so every *phase-valued* recommendation is
representable. (`init`, `select-change` and `resolve-blockers` are not
phases and have no dependency row — §4 states this explicitly; the earlier
"every value" phrasing here was overbroad and is corrected to match.)

**14. Store the canonical path alongside the hash, and normalize it.** The
key stays `hash(...)` — that's what gives cheap, collision-safe namespacing
— but each record also carries the human-readable canonical path, so a
moved project's history is findable rather than orphaned, and a future
rebind is a data migration rather than an archaeology exercise. Windows
normalization is explicit: resolve short (8.3) names, lowercase the drive
letter, and casefold, so one directory yields one hash.

**15. The health probe writes to a single fixed, overwritten key**
(`sdd-health/{projectRootHash}`), not an accumulating log — one record per
project, replaced on each probe. It stays a real write because a read-only
liveness check wouldn't detect the failure mode we actually care about (a
store that reads fine but silently drops writes, §8.2), but it leaves
exactly one record behind instead of junk per invocation.

### Closed items (kept for the record)

- **Fleet cap.** Resolved: `HARD_MAX_ROUTES` 16 → 24, implemented with
  TDD. Sized for ~20 connected models at one host per model, plus slack.
  It was briefly raised to 64 for the tiered design and lowered again once
  tiers were abandoned (§7.2). `FLEET_DEFAULT_CAP` stays at 8.
- **`permission` readback comparison.** Moot — nothing in the shipping
  design depends on `permission` for enforcement any more (§7.1).
- **Foreign-agent contamination.** The narrow question (does the
  provenance guard still hold when one model maps to several tiered
  hosts?) is moot for the same reason: one host per model again. The
  *general* concern is real but predates and outlives this design — a
  validation pass identified a concrete vector in `foreign-agent-scan.ts`,
  and an independent fourth-pass audit corrected its mechanism. The
  detector (`scanForForeignAgentDefinitions`) **does** read frontmatter
  `name` and is not fooled by a prefixed name hiding behind a non-prefixed
  filename. The actual vector is narrow in scope but precise in effect:
  `checkName` only runs its ownership logic for files whose resolved name
  already starts with the reserved prefix (`foreign-agent-scan.ts:51` gates
  the whole body), and for those it early-returns on `ownership:
  "workspace-owned-candidate"` (`foreign-agent-scan.ts:66-68`) — which the
  workspace's own `.opencode/agent(s)/` directory carries
  (`foreign-agent-sources.ts:43-44`). So *any file using the reserved
  prefix* in that directory escapes reporting as
  `foreign-reserved-definition` (it is only checked if it also appears in
  `ownedMap`, which a shadow file does not). Files not using the prefix
  were never going to be reported regardless, so the early-return doesn't
  widen the vector for them — but it does silently swallow exactly the
  shadow-file case (a prefixed name) that the detector exists to catch. **Tracked as a separate repo
  issue, not as a blocker here**, since this design no longer makes it
  load-bearing — though note §7.2's detection can't see `.opencode/`
  either, so neither mechanism covers it.
- **Unrouted-dispatch fallback.** Resolved by construction: SDD dispatch
  always emits the explicit grammar (Path A). When the user names no
  model, the orchestrator supplies the configured default *inside* the
  grammar rather than falling through to a bare `subagent_type` — so
  Path B never runs for an SDD phase, which also closes the misroute
  hazard where a lone "usando" in an inlined artifact could resolve as a
  model reference.
- **`glm-4.7-flash` validity.** Verified live against the real endpoint
  (HTTP 200, model id echoed). See §8.1 for the reasoning-model gotcha the
  probe surfaced.
- **`sizeException` bypass.** Real, confirmed by direct reading: the
  requirement is nested under `routes.length > declaredCap`, so declaring
  a high `cap` skips it. **Not this design's problem** — it's a
  preexisting generator bug, and with tiers gone this design no longer
  pushes route counts anywhere near the boundary. Tracked as a separate
  repo issue; the product question is whether declaring a cap should count
  as the exception.
- **Re-validation of §7.** Superseded: §7's tier design was abandoned
  outright after the spike, and a full-document adversarial pass now
  covers what replaced it.
- **Data egress.** Resolved: accepted as designed, documented in §8.1.

### 9.1 Proposed phase→skills map (for review)

Only what is genuinely mandatory, per §5.1. Empty is a valid answer for a
phase — padding this table would defeat the "mandatory means mandatory"
property that lets the contract demand the read.

| Phase | Mandatory skills |
|---|---|
| `sdd-init` | — |
| `sdd-explore` | — |
| `sdd-propose` | — |
| `sdd-spec` | — |
| `sdd-design` | — |
| `sdd-tasks` | `work-unit-commits`, `chained-pr` |
| `sdd-apply` | `work-unit-commits`, plus the project's testing skill when one is registered (e.g. `go-testing`, `playwright-best-practices`) — resolved from the registry by detected stack, not hardcoded |
| `sdd-verify` | the project's testing skill, same resolution |
| `sdd-archive` | — |

Rationale for the shape: planning phases produce prose, and this project's
registry has no mandatory standard governing prose that a phase would fail
review for ignoring. `sdd-tasks` gets the two PR-shaping skills because §6
already has it emit the chained-PR and 1000-line forecast lines, and those
skills define what that forecast means — without them the phase is
guessing at its own output format. `apply`/`verify` get the testing skill
because they are the phases that write and run tests.
