# Foreign Agent Provenance Guard — Tasks

Date: 2026-07-31 (tasks checklist added 2026-08-01)
Status: Ready for `sdd-apply`
Derives from:
- Spec: `docs/plans/2026-07-31-foreign-agent-provenance-guard-spec.md` (REQ-1..REQ-13;
  PMC memory `0ea11a80-4b99-4432-9d07-572b22fd05c7`,
  topic key `decision/foreign-agent-provenance-guard-spec-approved-2026-07-31`)
- Design: `docs/plans/2026-07-31-foreign-agent-provenance-guard-design.md` (rev 3;
  PMC memory `8137f8f5-fc1f-4d34-9c2b-03798e261a64`)
- Full narrative detail (TDD steps, code sketches, exact commit messages):
  `docs/plans/2026-07-31-foreign-agent-provenance-guard-implementation.md`

This checklist is the SDD "tasks" phase deliverable. It tracks scope,
requirement coverage, file lists, and dependency order at a glance. It does
**not** duplicate the TDD step-by-step detail — for that, follow the pointer
under each task into the implementation plan.

> Note: the implementation plan as written contains **Task 0 through Task 9**
> (10 tasks total), not Task 10. This checklist enumerates exactly those 10
> tasks; no 11th task exists in the canonical implementation plan.

## Review Workload Forecast

- **Decision needed before apply:** Yes
- **Chained PRs recommended:** Yes
- **400-line budget risk:** High
- **Chain strategy:** Pending; split into work units or seek document size exception.

## Definition of done

Pulled from the spec's acceptance criteria (spec §"Acceptance criteria") and
the implementation plan's "Required residual-risk statement":

- [ ] All REQ-1 through REQ-13 have at least one automated test per the
      implementation plan's task list (Tasks 0-9).
- [ ] `npm run test:model-routes`, `npm run test:typecheck:strict`, and
      `npm run build` pass with zero errors.
- [ ] `tests/bootstrap-clean-startup.test.ts` passes with the narrowed
      assertion (REQ-9) and its obsolete-routing-hook guards intact.
- [ ] `tests/model-route-real-host-canary.integration.ts` passes with the new
      `opencode run --agent` assertion (REQ-11), run against a real OpenCode
      1.18.9 host — a skipped/gated result does not satisfy acceptance.
- [ ] Task 0's spike notes file exists and states which REQ-7 branch (full
      canonical projection vs. observed-field projection) applies, before
      Task 6/Task 8 are considered complete; it contains only sanitized
      keys/types/equality evidence, never raw prompt or config values.
- [ ] The completed implementation explicitly states the required
      residual-risk statement (remote/managed-source coverage limits,
      post-validation mutation ordering boundary, TOCTOU boundary,
      other-plugin-call out-of-scope decision, `hidden` vs. `mode: subagent`
      distinction) rather than overstating the guarantee.
- [ ] `npm run test:all` (full regression) passes.
- [ ] PMC canonical spec memory (`0ea11a80-4b99-4432-9d07-572b22fd05c7`) is
      updated only after all checks pass, recording Task 0's selected branch,
      implementation commits, real-host evidence, and residual risks; design
      memory (`8137f8f5-fc1f-4d34-9c2b-03798e261a64`) is updated only on a
      factual design correction.
- [ ] Apply-progress TDD evidence requirements are met, and the `tasks.md`
      checklist is persisted and committed continuously.
- [ ] Commits are prefixed with task traceability labels (e.g., `[Task 3] feat(...)`).

**Blocking prerequisite:** Task 0 (the empirical `cfg.agent` merged-shape
spike against a real OpenCode 1.18.9 host) MUST complete and record a
conclusion before Task 6 (read-only merged-config observer) and Task 8 (wire
config observer + per-dispatch validation) may begin their config-hook
validation-branch work. Tasks 1-5 and Task 7 do not depend on Task 0's
conclusion (Task 5's runtime-comparison contract references Task 0 as
precondition reading, but its Markdown-generation half is unconditional).

## Tasks

- [x] **Task 0 — Empirically resolve the `cfg.agent` merged-shape spike (blocking prerequisite)**
  Delivers: sanitized, real-host-verified answer to whether Markdown agent
  definitions (and their `hidden`/`permission.task` fields) survive into
  `cfg.agent`, determining which REQ-7 validation branch (full canonical vs.
  observed-field) the rest of the plan implements. A third outcome applies:
  if the shape is completely unsupported, stop apply and revise design/spec.
  Satisfies: REQ-7 (branch selection), REQ-13 (declared residual limitation
  if fields are unobservable).
  Files:
  - Create: `docs/plans/2026-07-31-foreign-agent-provenance-guard-spike-notes.md`
  Dependencies: none (first task; gates Task 5, 6 and 8).
  Detail: see implementation plan "Task 0: Empirically resolve the `cfg.agent`
  merged-shape spike (blocking)".

- [x] **Task 1 — Declare parser dependencies and pin the loader contract**
  Delivers: direct production dependencies on `yaml` and `jsonc-parser`,
  proven importable/parseable via a failing-then-passing dependency test.
  Satisfies: REQ-2, REQ-13 (no hand-rolled regex parsers), foundational for
  REQ-1.
  Files:
  - Modify: `package.json`, `package-lock.json`
  - Create: `tests/foreign-agent-parser-dependencies.test.ts`
  Dependencies: none (independent of Task 0).
  Detail: see implementation plan "Task 1: Declare parser dependencies and
  pin the loader contract".

- [x] **Task 2 — Resolve all observable OpenCode definition sources**
  Delivers: a pure, hermetic source resolver
  (`resolveForeignAgentSources`) covering workspace, ancestor, global/XDG,
  `OPENCODE_CONFIG*`, managed, and operator-extended config roots, with
  deduplication and stable ordering.
  Satisfies: REQ-1 (source enumeration), REQ-12 (operator-extensible
  watched roots), REQ-13 (declared managed-root limitation).
  Files:
  - Create: `src/infrastructure/opencode/foreign-agent-sources.ts`
  - Create: `tests/foreign-agent-sources.test.ts`
  Dependencies: Task 1 (parser deps available for downstream consumption;
  no direct code dependency but sequenced after it per the plan's task
  order).
  Detail: see implementation plan "Task 2: Resolve all observable OpenCode
  definition sources".

- [x] **Task 3 — Scan config, Markdown, modes, names, and links fail-closed**
  Delivers: the pure scanner (`scanForForeignAgentDefinitions`) that walks
  resolved sources, applies case-insensitive reserved-name matching,
  workspace-owned-file allowlisting by path+SHA-256, and fail-closed
  handling of symlinks/junctions/unparseable sources.
  Satisfies: REQ-1, REQ-2 (fail-closed inspection failures).
  Files:
  - Create: `src/infrastructure/opencode/foreign-agent-scan.ts`
  - Create: `tests/foreign-agent-scan.test.ts`
  Dependencies: Task 2 (consumes `ObservableAgentSource[]`).
  Detail: see implementation plan "Task 3: Scan config, Markdown, modes,
  names, and links fail-closed".

- [x] **Task 4 — Add typed provenance and resolved-config failures**
  Delivers: the four new typed error classes with stable `name`/`code` and
  no raw-content leakage, and the finding-to-error-class mapping.
  Satisfies: REQ-10 (error taxonomy).
  Files:
  - Create: `src/infrastructure/opencode/foreign-agent-errors.ts`
  - Create: `tests/foreign-agent-errors.test.ts`
  Dependencies: Task 3 (consumes `ForeignAgentFinding` shape/kinds).
  Detail: see implementation plan "Task 4: Add typed provenance and
  resolved-config failures".

- [ ] **Task 5 — Define one canonical generated-agent contract**
  Delivers: a single shared module owning the canonical routed-agent
  definition (description, `mode: subagent`, `hidden: true`, model, exact
  prompt, `permission.task["*"]: deny`) used by both the descriptor writer
  and the runtime comparator; refactors `disk-agent-generator.ts` to consume
  it.
  Satisfies: REQ-6 (canonical generated-agent contract).
  Files:
  - Create: `src/infrastructure/opencode/routed-agent-definition.ts`
  - Modify: `src/infrastructure/opencode/disk-agent-generator.ts`
  - Create: `tests/routed-agent-definition.test.ts`
  - Modify: `tests/model-route-disk-generator.test.ts`
  Dependencies: **blocked by Task 0** (for the runtime-comparison branch contract)
  and depends on Task 4 (typed errors). (The Markdown-generation half is
  otherwise independent of Tasks 1-4). Sequenced after Task 4 per plan order.
  Detail: see implementation plan "Task 5: Define one canonical
  generated-agent contract" (note its explicit "Precondition: Read Task 0's
  spike notes...").

- [ ] **Task 6 — Implement the read-only merged-config observer**
  Delivers: `ResolvedAgentConfigGuard`, a pure observe/assert class that
  retains the live `cfg.agent` reference, validates per Task 0's confirmed
  branch, never mutates config, and exposes
  observe/recordObservationFailure/recordAuditFailure/assertMatches.
  Satisfies: REQ-6 (runtime comparator), REQ-7 (merged runtime-config
  validation), REQ-8 (config-hook failure semantics — recording, not
  throwing).
  Files:
  - Create: `src/infrastructure/opencode/resolved-agent-config-guard.ts`
  - Create: `tests/resolved-agent-config-guard.test.ts`
  Dependencies: **blocked by Task 0** (must implement whichever validation
  branch the spike confirmed); also depends on Task 5 (canonical definition
  contract) and Task 4 (typed errors).
  Detail: see implementation plan "Task 6: Implement the read-only
  merged-config observer" (note its explicit "Precondition: Task 0's spike
  notes must state which validation branch applies...").

- [ ] **Task 7 — Gate generation and signed readiness on filesystem provenance**
  Delivers: integration of the scanner into `DiskAgentGenerator.generate()`
  (after owned-hash verify, before sweep/write/manifest-commit) and into
  `ModelRouteReadiness.assertCurrentState()` (`issue()`/`verify()`, uncached),
  plus the shared `assertNoForeignAgentDefinitions()` facade and preserved
  ordered error precedence for owned-file tamper.
  Satisfies: REQ-1, REQ-2, REQ-3 (generation gate), REQ-4 (readiness gate),
  REQ-10 (error precedence: `ModifiedOwnedFileError` /
  `AttestationMismatchError` / `ForeignAgentDefinitionError`).
  Files:
  - Modify: `src/infrastructure/opencode/disk-agent-generator.ts`
  - Modify: `src/infrastructure/opencode/model-route-readiness.ts`
  - Create: `tests/foreign-agent-guard-generator.test.ts`
  - Create: `tests/foreign-agent-guard-readiness.test.ts`
  Dependencies: Task 3 (scanner), Task 4 (error taxonomy). Independent of
  Task 0/Task 6 (filesystem-only gate, not the config-hook branch).
  Detail: see implementation plan "Task 7: Gate generation and signed
  readiness on filesystem provenance".

- [ ] **Task 8 — Wire the config observer and per-dispatch validation**
  Delivers: `SddPlugin`'s read-only `config` hook wired to
  `ResolvedAgentConfigGuard`, the narrowed `tests/bootstrap-clean-startup.test.ts`
  assertion (REQ-9), `ModelRouteTaskHook` gate-order enforcement (REQ-5),
  `routing.config.blocked` audit shape, and
  `SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS` plumbing through bootstrap,
  regeneration use case, CLI, task hook, readiness, and both
  `WindowsModelRouteBootManager` readiness-construction sites (REQ-12).
  Satisfies: REQ-4 (boot-manager call sites), REQ-5 (dispatch gate
  ordering), REQ-7, REQ-8 (config-hook failure semantics — audit, promise
  always resolves), REQ-9 (regression-test coexistence), REQ-10 (no
  downgrade to `AttestationUnavailableError`), REQ-12 (env-var plumbing at
  every production call site).
  Files:
  - Modify: `src/bootstrap/index.ts`
  - Modify: `src/infrastructure/logging/model-route-audit.logger.ts`
  - Modify: `src/infrastructure/opencode/model-route-task-hook.ts`
  - Modify: `src/infrastructure/runtime/windows-model-route-boot-manager.ts`
  - Modify: `src/application/regenerate-fleet-agents/regenerate-fleet-agents.input.ts`
  - Modify: `src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.ts`
  - Modify: `src/cli/model-route-agents.ts`
  - Modify: `src/cli/model-route-boot.ts`
  - Modify: `tests/bootstrap-clean-startup.test.ts`
  - Modify: `tests/model-route-audit.test.ts`
  - Modify: `tests/model-route-boot-composition.test.ts`
  - Modify: `tests/windows-boot-manager.test.ts`
  - Create: `tests/foreign-agent-config-hook.test.ts`
  - Create: `tests/foreign-agent-guard-task-hook.test.ts`
  - Create: `tests/foreign-agent-guard-bootstrap.test.ts`
  Dependencies: **blocked by Task 0** (config-hook validation branch);
  depends on Task 6 (`ResolvedAgentConfigGuard`), Task 7 (readiness/generator
  gate ordering it must not disturb), Task 4 (error taxonomy).
  Detail: see implementation plan "Task 8: Wire the config observer and
  per-dispatch validation" (note its explicit "Precondition: Task 0's spike
  notes must state which validation branch applies...").

- [ ] **Task 9 — Wire suites, document the boundary, and verify end to end**
  Delivers: every new focused test script added to `test:model-routes`,
  README operator documentation, the extended real-host
  `opencode run --agent` CLI-selection assertion, full regression pass, and
  the PMC sync of the canonical spec/design memories.
  Satisfies: REQ-11 (CLI-selection barrier proof), REQ-13 (documented
  residual limitations), and the acceptance-criteria closure for all of
  REQ-1..REQ-13.
  Files:
  - Modify: `package.json`
  - Modify: `README.md`
  - Modify: `tests/model-route-real-host-canary.integration.ts`
  - Modify: `docs/plans/2026-07-31-foreign-agent-provenance-guard-design.md`
    (only if implementation exposes a factual correction)
  Dependencies: Task 8 (all guard wiring complete); effectively the final
  task, sequential after all others.
  Detail: see implementation plan "Task 9: Wire suites, document the
  boundary, and verify end to end".

## Task dependency summary

```
Task 0 (spike, blocking) ──┬─────────────► Task 6 ──► Task 8 ──► Task 9
                           ├─────────────► Task 5 (comparator contract)
                           └─────────────► Task 8 (branch selection)
Task 1 ─► Task 2 ─► Task 3 ─► Task 4 ─┬─► Task 5 ─► Task 6
                                      └─► Task 7 ───────────────► Task 9
Task 7 (independent of Task 0/6) ─────────────────────────────────► Task 8
```

Plain-language reading: Tasks 1→2→3→4 are strictly sequential (parser deps →
sources → scanner → errors). Task 5 and Task 7 both depend on Task 4 but are
otherwise independent of each other. Task 0 is a standalone blocking
prerequisite that must land before Task 5 (comparator branch), Task 6, and Task 8 start their
config-hook/branch-specific work.
Task 6 depends on Task 0 (branch), Task 5 (canonical contract), and Task 4
(errors). Task 8 depends on Task 0 (branch), Task 6 (guard), and Task 7
(ordering it must preserve). Task 9 is last, after Task 8.
