# Tasks — `natural-model-routing`

**Status of Work Units** (cumulative across all apply batches).

The WU1 + WU2 work is verified and locked in. WU3 was implemented in
this batch with strict TDD discipline (RED → GREEN → REFACTOR). WU4
and WU5 are explicitly deferred and require their own apply batches.

## WU1 — Bounded natural-intent parser + curated alias table ✅

- [x] 1.1 `parseNaturalModelIntent(prompt)` in `src/domain/model-routing/natural-model-intent.ts`
- [x] 1.2 `NATURAL_MODEL_ALIASES` in `src/domain/model-routing/natural-model-aliases.ts`
- [x] 1.3 RED-first test coverage in `tests/natural-model-intent.test.ts` (21 cases)
- [x] 1.4 TypeScript strict + test typecheck pass

## WU2 — Hook + bootstrap integration of natural-intent routing ✅

- [x] 2.1 Extend `ModelRouteAuditStage` with `routing.natural.launch | routing.natural.blocked`
- [x] 2.2 `NaturalIntentBlockedError` with Spanish (`messageEs`) and English (`messageEn`) actionable messages
- [x] 2.3 Refactor `ModelRouteTaskHook.execute` into two paths
- [x] 2.4 Wire `NATURAL_MODEL_ALIASES` into the bootstrap resolver
- [x] 2.5 Bootstrap boundary defense
- [x] 2.6 RED-first WU2 test coverage in `tests/natural-model-routing-task-hook.test.ts` (13 cases)
- [x] 2.7 TypeScript strict + test typecheck + build pass
- [x] 2.8 All WU1 / Unit-5 / related base tests still pass
- [x] 2.9 Persist merged apply-progress
- [x] 2.10 PMC readback

## WU3 — Windows boot manager + catalog readback + distinct-parent canary ✅

### WU3 v1 (prior batch — verified, superseded by v2)

- [x] 3.1 RED-first lifecycle test coverage in `tests/windows-boot-manager.test.ts` (10 cases)
- [x] 3.2 `WindowsModelRouteBootManager` in `src/infrastructure/runtime/windows-model-route-boot-manager.ts`
- [x] 3.3 Reuse existing `ModelRouteCanary` with distinct-parent enforcement
- [x] 3.4 CLI wrapper `src/cli/model-route-boot.ts` (start/stop/status)
- [x] 3.5 `CatalogRouteMissingError` (`CATALOG_ROUTE_MISSING`) fail-closed before readiness
- [x] 3.6 ACL 0600 on `readiness.json` (POSIX; best-effort Windows)
- [x] 3.7 HMAC key zeroed on `stop()`; never on disk / in `process.env` / in audit log
- [x] 3.8 Single-flight `start()`; concurrent calls await the same lifecycle
- [x] 3.9 TypeScript strict + test typecheck + build pass
- [x] 3.10 All WU1 / WU2 / Unit-5 / related base tests still pass
- [x] 3.11 Persist merged WU1+WU2+WU3 apply-progress
- [x] 3.12 PMC readback via `pmc refresh-context --enrich` + `pmc sync-context`

### WU3 v2 (this batch — drift remediation, re-anchored to the authoritative `ModelRouteReadiness` contract)

- [x] 3.1 Canario parent read-back via `GET /session/:id` (`PARENT_MODEL_MISMATCH`)
- [x] 3.2 `WindowsModelRouteBootManager` adopts `ModelRouteReadiness.issue()` (nonce + TTL + verifierVersion + fileHashes)
- [x] 3.3 Lock acquisition at the start of the boot sequence with stale-lock recovery (`StaleLockUnrecoverableError`, exit code 7)
- [x] 3.4 `SyncConnectedModelsUseCase` invoked BEFORE the `existsCanonical` readback (mock de orden)
- [x] 3.5 Secret distribution via env (`SDD_MODEL_ROUTING_BOOT_ID` / `SDD_MODEL_ROUTING_SIGNING_KEY`); cleared on `stop()`, caller-owned values restored
- [x] 3.6 CLI is now a long-lived supervisor (SIGINT/SIGTERM → `manager.stop()`); cross-process `stop` reads the lock payload
- [x] 3.7 RED-first test coverage extended to 16 cases in `tests/windows-boot-manager.test.ts`
- [x] 3.8 TypeScript strict + test typecheck + build pass
- [x] 3.9 All WU1 / WU2 / Unit-5 / related base tests still pass
- [x] 3.10 Persist merged WU1+WU2+WU3 v1+WU3 v2 apply-progress
- [x] 3.11 PMC readback via `pmc refresh-context --enrich` + `pmc sync-context`
- [x] 3.12 Production `opencode serve` supervisor with exact health/version gate
- [x] 3.13 Mandatory live catalog sync wired in the CLI composition root
- [x] 3.14 Attach child receives a scrubbed environment; serve receives ephemeral secrets
- [x] 3.15 Cross-process control/status/stop, child teardown, renewal, and stale-state cleanup
- [x] 3.16 Windows current-user ACL via `icacls` with offline-account fallback

## WU4 — Security / failure-mode tests ⏸ DEFERRED

- [ ] 4.1 Prompt injection penetration tests across the natural path
- [ ] 4.2 Fuzz tests for the parser at the 256-byte boundary
- [ ] 4.3 Audit-log integrity test (signed entries, no truncation, no secret leakage)
- [ ] 4.4 Secret non-persistence end-to-end test (kill -9 during boot, no key on disk)
- [ ] 4.5 Recovery-from-failed-boot tests (catalog readback fails → operator restart path)

## WU5 — Real-host E2E + operator docs ⏸ DEFERRED

- [ ] 5.1 Real-host 1.18.9 natural-route E2E
- [ ] 5.2 Attestation evidence recording in PMC
- [ ] 5.3 Windows Operator Guide (`docs/windows-natural-routing-operations.md`)
- [ ] 5.4 Rollback plan documented (`SDD_NATURAL_ROUTING=off`)
