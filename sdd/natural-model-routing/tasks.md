# Tasks — `natural-model-routing`

**Status of Work Units** (cumulative across all apply batches).

The WU1 work is verified and locked in. WU2 was implemented in this
batch with strict TDD discipline (RED → GREEN → REFACTOR). WU3, WU4,
and WU5 are explicitly deferred and require their own apply batches.

## WU1 — Bounded natural-intent parser + curated alias table ✅

- [x] 1.1 `parseNaturalModelIntent(prompt)` in `src/domain/model-routing/natural-model-intent.ts` with NFKC + Spanish diacritic fold, ≤ 256-byte reference, fail-closed on ambiguous/malformed
- [x] 1.2 `NATURAL_MODEL_ALIASES` in `src/domain/model-routing/natural-model-aliases.ts` with the curated `gemini flash 3.6 tiered → google/antigravity-gemini-3.6-flash-tiered` mapping
- [x] 1.3 RED-first test coverage in `tests/natural-model-intent.test.ts` (21 cases)
- [x] 1.4 TypeScript strict + test typecheck pass

## WU2 — Hook + bootstrap integration of natural-intent routing ✅

- [x] 2.1 Extend `ModelRouteAuditStage` with `routing.natural.launch | routing.natural.blocked` and add `trigger` / `requestedNaturalReference` fields
- [x] 2.2 `NaturalIntentBlockedError` with Spanish (`messageEs`) and English (`messageEn`) actionable messages
- [x] 2.3 Refactor `ModelRouteTaskHook.execute` into two paths (explicit-grammar + natural-intent) with shared gate order
- [x] 2.4 Wire `NATURAL_MODEL_ALIASES` into the bootstrap resolver for the natural path
- [x] 2.5 Bootstrap boundary defense: parse + short-circuit on parser failure before invoking the hook
- [x] 2.6 RED-first WU2 test coverage in `tests/natural-model-routing-task-hook.test.ts` (13 cases)
- [x] 2.7 TypeScript strict + test typecheck pass; build passes
- [x] 2.8 All WU1 / Unit-5 / related base tests still pass
- [x] 2.9 Persist merged apply-progress to `sdd/natural-model-routing/apply-progress.md`
- [x] 2.10 PMC readback via `pmc refresh-context --enrich`

## WU3 — Boot manager / catalog sync ⏸ DEFERRED

- [ ] 3.1 Boot manager that refreshes the catalog on plugin start
- [ ] 3.2 Periodic catalog sync with bounded busy-timeout
- [ ] 3.3 Fleet warm-up that pre-verifies every manifest route

## WU4 — Security tests ⏸ DEFERRED

- [ ] 4.1 Prompt injection penetration tests across the natural path
- [ ] 4.2 Fuzz tests for the parser at the 256-byte boundary
- [ ] 4.3 Audit-log integrity test (signed entries, no truncation, no secret leakage)

## WU5 — Docs / E2E ⏸ DEFERRED

- [ ] 5.1 Operator-facing docs for the natural grammar
- [ ] 5.2 Spanish error catalog for support / on-call
- [ ] 5.3 Full E2E run-through of `tool.execute.before` for every path
