# Fresh Strict-TDD Verification — SDD Phase Agents

**Target:** `d10b2928799ac9fe2161a2eb8fb12371c4909294` on `feat/sdd-phase-agents`  
**Date:** 2026-08-03  
**Mode:** full scope · feature-branch-chain · hybrid persistence · Strict TDD  
**Method:** independent source inspection and live execution; no production or test file was modified.

> **This report supersedes `2026-08-02-sdd-phase-agents-VERIFY.md`.** That
> document and remediation brief #2418 were treated only as hypotheses. In
> particular, its former C-2/C-3/C-4 findings are re-evaluated below; its claim
> that the MCP surface was absent is no longer true, but the newly present tool
> surface does not satisfy several required runtime contracts.

## Verdict: FAIL — not archivable

All 14 required `tests/sdd-*.test.ts` suites, strict typecheck, persistence
suite, and build passed. Those are necessary but not sufficient evidence:
Strict TDD evidence for the 131 tasks is absent, and source inspection shows
that the live seven-tool surface bypasses or fails to wire several load-bearing
requirements (persistent lock/status, artifact retrieval/fingerprint, and
atomic checkpoint concurrency).

## Tree and command evidence

| Command | Exit | Evidence |
|---|---:|---|
| `pmc get-context d10b292... compact` | 0 | Required context lookup completed before source inspection. |
| `git rev-parse HEAD` / branch check | 0 | HEAD is exact target; branch is `feat/sdd-phase-agents`. |
| 14 individually invoked `npx tsx tests/sdd-*.test.ts` suites | 0 | Every named suite passed: identity, keys, artifact store, status, discovery, routing, lock, gateway, init, prompt, fingerprint, checkpoint, entry flow, executor contract. |
| `npx tsx tests/sqlite-mcp-tool-client.test.ts` | 0 | Six SQLite bridge checks passed, including sequential stale-version rejection. |
| `npm run test:typecheck:strict` | 0 | Target and all registered test sources typecheck. |
| `npm run test:persistence` | 0 | 30/30 declared persistence gates passed. |
| `npm run build` | 0 | `tsc` and `tsup` succeeded. |
| `npx tsx tests/model-route-disk-generator.test.ts` | 0 | MR-1 cap assertions passed. |
| `npm run test:model-routes` | 1 | Separated known unrelated CLI-test environmental failure; see below. |

The verification began and ended with the same pre-existing dirty files:
`.codex/config.toml`, `.gitignore`, `AGENTS.md`, `config/model-routing/routes.json`,
`package.json`, four non-SDD `src/` files, `tests/model-route-disk-generator.test.ts`,
and the listed untracked user files. This report is the only verification
artifact added.

## Task and Strict-TDD completeness

| Check | Result | Evidence |
|---|---|---|
| Task checklist | 131/131 checked; 0 unchecked | `TASKS.md` checkbox count. |
| One task per scenario planning axis | Present in tasks/design | 131 task ids; task text documents the later RT-17/RT-18 addition. |
| TDD Cycle Evidence / target apply-progress | **FAIL** | No `sdd-phase-agents` apply-progress artifact or `TDD Cycle Evidence` table exists in `docs/` or `openspec/`. The only discovered apply-progress belongs to `model-control-center-tui`. |
| RED evidence | **UNVERIFIED** | Per-task red state is not recorded. |
| GREEN evidence | Partial | Current suites pass, but that cannot prove every task's reported RED→GREEN cycle. |
| Safety-net evidence | **UNVERIFIED** | No target apply-progress records prior-suite results or new-vs-modified files. |

Strict-TDD compliance is therefore **0/131 tasks evidenced**, despite all
checkboxes being checked. Under Strict TDD this is a CRITICAL process failure,
not a warnings-only documentation gap.

## Requirement / scenario compliance matrix

`PASS (unit)` means a current unit/runtime suite covers the implementation
function. It does **not** claim that the corresponding MCP-tool scenario is
live unless the tool wiring was also verified.

| Capability / task ids | Runtime evidence | Source / integration result |
|---|---|---|
| Project identity — PI-1..PI-4 | `sdd-project-identity` passed (including Windows variants and junction) | PASS (unit). |
| Store shapes / keys — SS-1..SS-4, SS-7, SS-9..SS-12 | status, keys, artifact-store suites passed | PARTIAL: pure functions and fake-MCP adapter pass; actual bootstrap backend violates SS-8 and status tool omits discovery/real state. |
| Discovery — SS-5..SS-6 | `sdd-discovery-status` passed | FAIL (tool): `sdd_status` requires `changeName` and `allIds`; it has no discovery branch. |
| Routing — RT-1..RT-18 | `sdd-routing` passed | PASS (unit); tool relies on caller-supplied `verifyReportHasUnresolvedCritical`, not the stored report. |
| Dispatch lock — DL-1..DL-6 | `sdd-dispatch-lock` passed | FAIL (runtime): lock is caller-held only; status hardcodes `inFlightPhase: null`; no persisted/atomic lock or explicit clear tool exists. |
| Semantic gateway — SG-1..SG-6 | `sdd-semantic-gateway` passed, including truncation throw and abort-signal test | PASS (unit). `sdd_parse_request` tool does not inject this gateway or timeout path. |
| Init round — IR-1..IR-12 | `sdd-init-round` passed | PARTIAL: pure detection/config code passes; tool receives caller-provided file contents and lacks required project-root contract. |
| Prompt composition — PC-1..PC-9 | `sdd-prompt-composition` passed | FAIL (runtime): tool accepts caller-provided artifacts/config, does not retrieve them from PMC, has no project/change key, and bootstrap injects no skill resolver. |
| Worktree fingerprint — WF-1..WF-9 | `sdd-worktree-fingerprint` passed, including fake `git status --porcelain=v1 -uall` and probe-failure case | FAIL (runtime): no tool captures/returns a fingerprint or recomputes it during save. |
| Checkpoints — CP-1..CP-17 | `sdd-checkpoint-use-case` passed | FAIL (production concurrency): fake-store OCC/read-back tests pass, but SQLite uses check-then-upsert without a transaction or conditional update. |
| Entry flow — EF-1..EF-21 | `sdd-entry-flow` passed | PARTIAL: `runSddGo` is unit-only; tool calls only the parser default and does not supply gateway timeout/preflight/routing flow. |
| Executor / Gatekeeper — PE-1..PE-16 | `sdd-executor-contract` passed | PARTIAL: validators are pure helpers; no verified bootstrap/orchestrator call path invokes them. |
| Fleet cap — MR-1 (verify-only) | Direct disk-generator suite passed | PASS. |

## Fresh source findings

### CRITICAL

1. **Strict-TDD evidence is missing.** `TASKS.md` is fully checked, but there
   is no target `apply-progress` artifact and no TDD-cycle table. The strict
   protocol requires per-task RED, GREEN, triangulation, and safety-net
   evidence; current green tests cannot reconstruct it.

2. **The seven tools are registered but do not implement the required durable
   SDD lifecycle.** `src/bootstrap/index.ts` wires `buildSddTools`, but
   `src/bootstrap/sdd-tools.ts` makes `sdd_status` require a change and hardcodes
   `inFlightPhase: null`; it cannot produce SS-5/SS-6 discovery status or show
   a crashed lock. `sdd_compose_phase_prompt` and `sdd_save_artifact` exchange
   caller-provided lock/fingerprint values rather than storing, loading, or
   recomputing them. A second caller can supply `null` and compose concurrently.
   This fails the structural DL-1..DL-6 and the observable-status scenarios.

3. **WF-3 and the silent-git-failure remediation exist only below the tool
   boundary.** `captureWorktreeFingerprint` correctly calls
   `git status --porcelain=v1 -uall` and marks `gitProbeFailed`; the comparator
   fails closed. However no SDD MCP tool calls capture, returns a fingerprint,
   accepts it on save, or supplies current/baseline fingerprints to
   `saveArtifact`. The unit tests use synthetic fingerprints, so no live phase
   can detect a tracked or untracked unexpected write.

4. **Checkpoint OCC is not atomic in the actual SQLite backend.**
   `SqliteMcpToolClient.handleStore` first reads `version`, then separately
   executes an unconditional `INSERT ... ON CONFLICT DO UPDATE`. There is no
   transaction and no `WHERE memories.version = expectedVersion`; two concurrent
   clients can both pass the check and the later upsert overwrites the earlier
   one. The passing SQLite test is sequential, and CP-16/CP-17 use an
   in-memory fake that enforces the missing atomic conditional. Thus the new
   source fixes the former *absence* of version fields, but not the production
   optimistic-concurrency guarantee.

5. **The live persistence backend is not the specified agent-memory MCP tool
   path.** The bootstrap instantiates `SqliteMcpToolClient`, which opens the
   private `memories` SQLite schema directly. Its `callTool` names emulate MCP
   calls but never call the external `agent-memory-mcp` server. This contradicts
   SS-8's structured agent-memory MCP-tool requirement and leaves schema and
   concurrency semantics privately coupled.

### WARNING

1. `sdd_compose_phase_prompt` has no `projectRoot`/`changeName`, takes upstream
   artifacts from its caller, and bootstrap provides no `skillResolver`. Any
   phase with static mandatory skills (for example `sdd-tasks`) therefore fails
   with `UnresolvableSkillError` in the actual plugin rather than resolving the
   registry and reading PMC artifacts.

2. `sdd_parse_request` and `sdd_init_questions` omit `projectRoot`, contrary to
   the explicit-root rule. The parser tool invokes `sddParseRequest(text)` with
   no service or timeout, so the application-level EF-4 gateway path is not the
   runtime tool path. The checkpoint tool likewise injects no semantic gateway,
   so supplied notes are discarded rather than distilled.

3. There is no test of the OpenCode `tool()` definitions or bootstrap return
   map. The current 14 suites establish helper behavior, not an end-to-end MCP
   call that reads PMC state, composes a prompt, writes an artifact, and reads
   status back.

4. No coverage command/tool is configured in `package.json`; changed-file
   coverage is skipped rather than inferred from test count.

### SUGGESTIONS

1. Add an integration harness using the real registered tool definitions and a
   disposable persistence backend; assert discovery, persistent lock recovery,
   artifact readback, and fingerprint capture/save in one flow.
2. Use a single atomic conditional SQLite statement or transaction for checkpoint
   writes and test two independent clients interleaving after the version read.
3. Preserve a target apply-progress/TDD evidence artifact before claiming a
   Strict-TDD archive gate.

## Re-evaluation of stale findings and claims

| Prior claim | Fresh result |
|---|---|
| SG-4 truncation throw absent | Closed at application level: the second-truncation test now constructs `SemanticGatewayTruncationError`. |
| SG-5 / EF-4 timeout only abandoned requests | Closed at application level by `AbortController` + signal assertion and hanging-parser timeout test from `014ee5d`. |
| C-3 checkpoint real writers skipped readback | Closed in `checkpoint.ts`: declare, complete, block, and resume use `writeCheckpointsDurable`. |
| C-4 status/next/reason disagreement | Closed in `assembleStatus` for its supplied `verifyReportHasUnresolvedCritical` input. |
| MCP surface absent | Superseded: seven tools are present and bootstrap-wired. They are nevertheless incomplete against the specified lifecycle, so this is not an archive-ready closure. |
| Optimistic checkpoint concurrency is now complete | Rejected: version plumbing and fake-store tests are present, but production SQLite check-then-upsert is race-prone. |
| WF-3 / failed `git status` fixed | Helper implementation is fixed and unit-covered; production tool wiring is absent. |

## Model-route failure separation

`npm run test:model-routes` reached and passed fleet regeneration and the disk
generator, then failed at `tests/model-route-cli.test.ts:131` because the test
requires the real `.opencode/agents/` directory to contain no generated
`sdd-mr-v1-*.md` files. Independent inspection found **13** such ignored files.
This is the stated environmental/pre-existing failure, not a regression from
`d10b292`, and is excluded from the SDD verdict. Direct MR-1 execution passed.

## Artifact paths changed

- `docs/superpowers/specs/2026-08-03-sdd-phase-agents-VERIFY-fresh-d10b292.md` — this report only.

## Final verdict

**FAIL.** Do not archive. The next appropriate phase is remediation/apply for
the CRITICAL findings, followed by a fresh Strict-TDD verification with a
recorded apply-progress artifact. No fixes were made in this verification.
