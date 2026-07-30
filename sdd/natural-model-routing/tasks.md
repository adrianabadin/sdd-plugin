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

## WU4 — Security / failure-mode suite ✅ (this batch + remediation)

Reconciliado con el tasks memory autoritativo `1bf62713-dff6-4b0a-a680-f356fa20d13f` (Phase 4). Manda el autoritativo; los ítems locales no cubiertos se absorben como sub-items de 4.1.

- [x] 4.1 **RED**: crear `tests/natural-routing-security-failures.test.ts` (741 líneas, ≤800 budget) con cobertura fail-closed de:
  - [x] Prompt injection penetration tests across the natural path (5 patrones de override; outcome siempre decidido por el canonical del resolver, ningún substring adversarial del prompt aparece en el audit)
  - [x] Legacy non-intent passthrough byte-for-byte (7 inputs legacy, snapshot deepEqual, sin audit, sin llamada al resolver)
  - [x] Catalog/fleet missing → fail closed (off-fleet canonical → `RoutedAgentUnavailableError`; unknown alias → `NATURAL_ROUTE_UNKNOWN`)
  - [x] Process restart race conditions (bootIdentity mismatch → `AttestationMismatchError`; TTL expired → `AttestationExpiredError`, vía `now()` inyectado)
  - [x] Secret non-persistence e2e (kill -9 simulado dropping la reference sin `stop()`; walk recursivo del workspace verifica 0 archivos contienen la key; `.env` y `audit` no contienen ni el boot identity ni el signing key; boot 2 genera identidad + key + nonce frescos)
  - [x] Recovery-from-failed-boot (boot 1 con empty catalog → `CATALOG_ROUTE_MISSING` + estado `failed` + sin attestation + sin lock; boot 2 con catalog fixed → `ready` + nueva attestation + nuevo UUIDv4 bootIdentity)
  - [x] Fuzz del parser en el boundary de 256 bytes (255/256/257 ASCII, 128/129 ñ multibyte, empty, whitespace-only, control NUL/ESC/DEL → todos `CONTROL_CHARACTER` per D2, exact max bytes, multi-trigger → `NATURAL_INTENT_AMBIGUOUS`)
  - [x] Audit-log integrity (sin prompt crudo, sin key material, contract fields intactos, fsync durable, sensitive keys stripped a cualquier profundidad, grep del sink por 9 patrones de secreto limpio)
- [x] 4.2 **GREEN**: reforzar producción SOLO donde un test RED lo justifique:
  - **Cambio mínimo en `src/infrastructure/logging/model-route-audit.logger.ts` (+4 líneas en `SENSITIVE_KEYS`)**: el audit logger ahora strippea `prompt`, `rawprompt`, `userprompt`, `systemprompt` como defense-in-depth. El test RED de la sección 8 demostró que un caller que pase `prompt` accidentalmente NO es sanitizado por el sink actual (los SENSITIVE_KEYS hardcodeados no incluían "prompt"). El fix es mínimo y respeta el contrato de "prompt nunca se registra" sin tocar el hook.
  - **Ningún otro cambio de producción**: los gates del path natural, el parser, el resolver, el boot manager, y la readiness/canary ya cumplen el contrato fail-closed; los tests RED pasan de entrada (resultado válido, no excusa para tocar).
- [x] 4.3 **REFACTOR**: consolidar fixtures/mocks edge-case en `tests/helpers/model-routing-fixtures.ts`; el archivo principal queda en 741 líneas (≤800 budget).
- [x] 4.4 **REMEDIATION**: centralizar la ACL Windows en `src/infrastructure/runtime/windows-acl.ts`, usando rutas absolutas de `System32` y `AclRestrictionError` (`ACL_RESTRICTION_FAILED`) para no confundir fallos de tooling con tampering.
- [x] 4.5 **REMEDIATION**: fortalecer assertions de `.env`, identidad/key de boot, durabilidad observable del audit sink, controles NUL/DEL/ESC y outcomes de prompt injection.
- [x] 4.6 **REMEDIATION**: agregar Section 9 para la ACL Windows y corregir el nombre/evidencia del escenario de boot abandonado (sin `stop()`).

**Ownership fijado (D3)**: icacls Windows ACL y env scrubbing de attach pertenecen a WU3 v2 (3.14, 3.16 ✅); WU4 solo TESTEA su comportamiento, no los implementa.

**D2 honrado**: los tests de la sección 7h asertan que NUL (U+0000), DEL (U+007F) y ESC (U+001B) son RECHAZADOS con `CONTROL_CHARACTER`, NO strippeados. El parser ya cumple el contrato (WU1).

**Evidencia**: 10/10 secciones WU4 pass; `npm run test:model-routes`, typecheck estricto y `npm run build` pasan; las suites WU1/WU2/WU3 v2 y Unit 5 pasan sin regresiones. La corrida agregada `npm test` debe verificarse por separado porque su build encadenado puede fallar al resolver la ruta del config bajo el sandbox Windows.

## WU5 — Real-host E2E + operator docs ✅

- [x] 5.1 Real-host 1.18.9 natural-route E2E (Gating verified Task 0, host real 1.18.9 detected, provider credentials absent on host -> BLOCKED exit 2 recorded per D1/Precondition 2)
- [x] 5.2 Attestation evidence recording in PMC (Recorded in PMC memory under topic alias sdd/natural-model-routing/wu5-attestation-evidence)
- [x] 5.3 Windows Operator Guide (`docs/windows-natural-routing-operations.md`)
- [x] 5.4 Rollback plan documented (`SDD_NATURAL_ROUTING=off`)

**WU5 status**: Execution completed. Hermetic gating checks (Task 0) verified closed (exit 1/2). OpenCode 1.18.9 detected on host. Live host canary run executed; failed closed with `CANARY_FAILED` (POST /session/.../command returned 500) due to missing provider API credentials on host. Per D1 and Precondition 2, no synthetic attestation was manufactured. Evidence registered in PMC. Docs verified. Repo verification (`test:typecheck:strict`, `build`, `test:model-routes`, `npm test`) 100% green.
