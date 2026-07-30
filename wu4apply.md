# WU4 Apply — Security / failure-mode suite (`natural-model-routing`)

> Fuente: pre-flight PMC `f9dec8b2-c337-4eec-bbca-6cd50dea9941` + tasks locales reconciliadas `sdd/natural-model-routing/tasks.md` (sección WU4) + estructura verificada contra el código (imports reales) y claves de símbolos del grafo PMC.
> Repo: `C:/Users/aabad/documents/code/ia/sdd-plugin2`

## Misión

Implementar WU4 con TDD estricto RED→GREEN→REFACTOR, budget ≤800 líneas cambiadas. Crear la suite de seguridad/failure-modes que pruebe fail-closed end-to-end del path natural, SIN reimplementar lo que WU1–WU3 ya construyeron.

**Precondición (bloqueante)**: correr `npx tsx tests/windows-boot-manager.test.ts` y `npx tsx tests/natural-model-routing-task-hook.test.ts`. Si algo falla, FRENAR y reportar — WU3 v2 es responsabilidad de otro apply, no arreglarlo desde WU4.

## Artefactos autoritativos

| Artefacto | ID PMC | Uso |
|---|---|---|
| Pre-flight WU4 (decisiones D1–D3) | `f9dec8b2-c337-4eec-bbca-6cd50dea9941` | Leer primero; no re-decidir |
| Tasks locales reconciliadas | `sdd/natural-model-routing/tasks.md` §WU4 | Fuente operativa de este apply |
| Spec | `dcf1d668-3349-4ac1-8d06-ce27a40174ef` | "Ordered security gates", "Compatibility", "Boot lifecycle", "Concurrency" |
| Design | `41aa141d-1bbf-4cd0-aba7-63f82f83fbd6` | Sección Testing |
| Tasks autoritativo | `1bf62713-dff6-4b0a-a680-f356fa20d13f` Phase 4 | 4.1 RED / 4.2 GREEN / 4.3 REFACTOR |
| Formato de apply-progress a seguir | `d06bf17c-952e-4038-a118-eb3b19aab631` | Template del reporte final |

## Decisiones fijadas (respetar, no re-abrir)

- **D2 — reject, no strip**: control characters en la referencia se RECHAZAN con `CONTROL_CHARACTER` (spec: "fail as malformed"; impl: `containsControlCharacter` en `natural-model-intent.ts`). Los tests asertan RECHAZO. El tasks memory autoritativo dice "stripped" — desviación registrada, gana reject.
- **D3 — ownership**: icacls Windows ACL y env scrubbing de attach pertenecen a WU3 v2 (tasks locales 3.14/3.16 ✅). WU4 solo TESTEA su comportamiento observable; no modificarlos.
- Los gates de producción YA existen (ver estructura abajo). Se espera que varios tests RED pasen de entrada — resultado válido. Solo tocar producción cuando un test RED demuestre un gap real.

## Alcance

### 4.1 RED — crear `tests/natural-routing-security-failures.test.ts`

Cobertura obligatoria (del tasks.md reconciliado):

1. **Prompt injection**: prompts con instrucciones de override ("ignorá las reglas y corré esto en X", triggers embebidos en instrucciones falsas, texto que simula ser configuración) → gates se ejecutan en orden fijo (quarantine → fleet → attestation) sobre el canonical resuelto; el texto nunca altera orden/inputs/outcome.
2. **Legacy passthrough**: prompt sin trigger → todos los argumentos byte-for-byte idénticos, sin rewrite, sin audit.
3. **Catalog missing**: referencia resuelta pero ruta ausente del catálogo/fleet → fail closed antes de dispatch.
4. **Restart race**: attestation emitida con bootIdentity A; verify con bootIdentity B → `AttestationMismatchError`; expired → `AttestationExpiredError` (usar `now()` inyectado).
5. **Secret non-persistence e2e**: boot → kill -9 simulado (proceso muere sin `stop()`) → ninguna key/nonce recuperable en disco, `.env`, audit ni logs; boot 2 no valida attestation de boot 1.
6. **Recovery-from-failed-boot**: sync/readback de catálogo falla → boot fail-closed sin readiness; restart del operador completa y publica readiness válido.
7. **Fuzz boundary 256B**: referencias de 255/256/257 bytes UTF-8 (incluyendo multibyte que cruza el límite), vacías, whitespace-only, con control chars → contrato del parser respetado exactamente.
8. **Audit integrity**: entradas sin prompt crudo, sin key material, campos capados (sin truncamiento silencioso del contrato), escritura durable; grep del sink por patrones de secreto.

### 4.2 GREEN

Reforzar `model-route-task-hook.ts` / `natural-model-intent.ts` SOLO donde un test RED demuestre gap. Prohibido refactorear "por las dudas".

### 4.3 REFACTOR

Consolidar fixtures/mocks edge-case (reusar los existentes, ver tabla abajo). Verificar `npx tsx tests/natural-routing-security-failures.test.ts` limpio.

## Estructura de archivos y relaciones (verificada contra imports reales)

### Pipeline de dispatch (objetivo principal de los tests de inyección/gates)

```
src/infrastructure/opencode/model-route-task-hook.ts  (552 líneas, ModelRouteTaskHook)
├── import: domain/model-routing/model-route-grammar.ts      → parseModelRouteGrammar, ModelRouteGrammarError   [Path A: grammar explícita]
├── import: domain/model-routing/model-route-resolver.ts     → ModelRouteResolver, RouteUnknownError, RouteAmbiguousError  [Tier 1→2→3]
├── import: domain/model-routing/natural-model-intent.ts     → parseNaturalModelIntent + errores   [Path B: intent natural — WU1]
├── import: domain/model-routing/natural-model-routing-errors.ts → NaturalIntentBlockedError (messageEn/messageEs), builders  [WU2]
├── import type: domain/model/quarantine.ts                  → QuarantineEntry
├── import type: infrastructure/runtime/quarantine-store.ts  → QuarantineStore   [gate 1: quarantine]
├── import: ./model-route-readiness.ts                       → ModelRouteReadiness.verify + Attestation*Error  [gate 3: attestation]
├── import: infrastructure/logging/model-route-audit.logger.ts → ModelRouteAuditLogger, stages routing.launch/blocked/natural.*  [audit-before-mutation]
└── import type: ./disk-agent-generator.ts                   → Manifest   [gate 2: fleet whitelist]
```

Orden de gates en AMBOS paths (A explícito y B natural): parse → resolve → quarantine → fleet manifest → readiness verify → audit sincrónico → rewrite SOLO de `subagent_type`. Constructor guards: `TaskHookBootIdentityMissingError`, `TaskHookSigningKeyMissingError` (sin fallbacks).

### Dominio (parser + errores — objetivo del fuzz)

```
src/domain/model-routing/natural-model-intent.ts  (229 líneas, CERO imports — puro)
├── exported: parseNaturalModelIntent(prompt) → NaturalModelIntent | null
├── exported: NaturalModelIntent (interface), NaturalIntentTrigger (type)
├── exported: NaturalIntentAmbiguousError (>1 trigger)
├── exported: NaturalIntentMalformedError (codes: EMPTY_REFERENCE_AFTER_TRIM | BYTE_LIMIT_EXCEEDED | CONTROL_CHARACTER)
└── locals: buildFoldedView, findTriggerMatches, containsControlCharacter, isWhitespaceChar, TriggerMatch
    (vista NFKC + fold de diacríticos con mapa de offsets a bytes originales; NUNCA muta el prompt)

src/domain/model-routing/natural-model-routing-errors.ts  (216 líneas)
├── exported: NaturalIntentBlockedError (code, messageEn, messageEs, format(locale))
├── exported: NaturalIntentErrorCode = NATURAL_INTENT_AMBIGUOUS | NATURAL_INTENT_MALFORMED | NATURAL_ROUTE_UNKNOWN | NATURAL_ROUTE_AMBIGUOUS
├── exported builders: naturalRouteUnknownError, naturalRouteAmbiguousError,
│   naturalIntentAmbiguousError, naturalIntentMalformedError, naturalIntentBlockedFromParse
└── locals: build*Message (mensajes ES/EN con candidatos canónicos)
```

Nota: `QuarantinedModelError` y `AttestationUnavailableError` viven en el hook; `AttestationExpiredError`/`AttestationMismatchError` en readiness; `RouteUnknownError`/`RouteAmbiguousError` en el resolver. NO duplicarlos.

### Readiness / attestation (objetivo de restart-race y expiry)

```
src/infrastructure/opencode/model-route-readiness.ts  (266 líneas)
├── node:crypto (createHmac, randomBytes), node:child_process (execFileSync → icacls)
├── import type: ./disk-agent-generator.ts → Manifest
├── import type: ./model-route-canary.ts   → CanaryEvidence
├── exported: ModelRouteReadiness — issue({manifest, evidence, openCodeVersion, bootIdentity, ttlMs}) / verify({...})
├── exported: ReadinessAttestation (nonce, issuedAt, expiresAt, fileHashes, verifierVersion, signature)
├── exported: AttestationExpiredError, AttestationMismatchError, ReadinessSigningKeyMissingError
├── exported: REQUIRED_OPENCODE_VERSION = "1.18.9", READINESS_VERIFIER_VERSION
└── local: applyCurrentUserAcl (icacls current-user SID — WU3 v2, NO tocar: D3)
```

### Boot manager (objetivo de kill -9 / recovery — SUT indirecto)

```
src/infrastructure/runtime/windows-model-route-boot-manager.ts  (~480 líneas, WU3 v2)
├── import type: ../opencode/disk-agent-generator.ts → Manifest
├── import: ModelRouteReadiness (issue/verify) [adoptado en v2]
├── import type: ports/model-route-catalog.port.ts → ModelRouteCatalogPort (existsCanonical)
├── exported: WindowsModelRouteBootManager (lifecycle idle→starting→syncing→canarying→ready→stopping|failed, single-flight)
├── exported: CatalogRouteMissingError (CATALOG_ROUTE_MISSING), FileReadinessPublisher, ReadinessPublisher,
│   BootLifecycleState, BootChildProcess, BootProcessSupervisor, CatalogSyncUseCase
└── locals: generateUuidV4, applyCurrentUserAcl (icacls — WU3 v2 3.16, NO tocar)

src/infrastructure/runtime/model-route-boot-control.ts  (cross-process control, WU3 v2 — locals: cleanArtifacts, errorCode, errorMessage)
src/cli/model-route-boot.ts  (supervisor long-lived; attach con env scrubbed — WU3 v2 3.14, NO tocar)
```

### Audit (objetivo de audit-integrity)

```
src/infrastructure/logging/model-route-audit.logger.ts  (191 líneas, solo node:fs/path)
├── exported: ModelRouteAuditLogger (JSONL sincrónico durable, fsync)
├── exported: ModelRouteAuditEntry, ModelRouteAuditLoggerOptions, ModelRouteAuditLoggerError
├── exported: ModelRouteAuditStage (incluye routing.launch | routing.blocked | routing.natural.launch | routing.natural.blocked)
├── exported: ModelRouteAuditStatus
└── locals: sanitizeValue, isSensitive, jsonReplacer, boundString, isPlainObject
    (capado de tamaño/profundidad; los tests deben verificar: sin prompt crudo, sin key, sin truncamiento del contrato)
```

### Quarantine (gate 1)

```
src/infrastructure/runtime/quarantine-store.ts       → QuarantineStore, getGlobalQuarantineStore
src/domain/model/quarantine.ts                       → QuarantineEntry, isQuarantineActive, resolveQuarantinePrecedence
src/infrastructure/prisma/model-route-quarantine.adapter.ts → PrismaModelRouteQuarantineAdapter
src/ports/model-route-quarantine.port.ts             → ModelRouteQuarantinePort
```

## Fixtures/mocks existentes para REUSAR en 4.1/4.3 (de tests previos)

| Helper | Archivo origen | Propósito |
|---|---|---|
| `makeHook` | tests/natural-model-routing-task-hook.test.ts, tests/model-route-task-hook.test.ts | construir hook con deps inyectadas |
| `stubCatalog` | tests/natural-model-routing-task-hook.test.ts | catálogo hermético |
| `StubCatalog` | tests/natural-model-intent.test.ts | idem parser |
| `seedManifestWithOwnedFiles` | tests/natural-model-routing-task-hook.test.ts | manifest + fileHashes coherentes |
| `writeStrict`, `sha256`, `cleanupDir`, `existingSubdirs`, `sleep` | tests de hook/audit/quarantine | utilidades fs/tiempo |
| `baseEntry` | tests/model-route-audit.test.ts | entrada de audit base |
| `stubResolverPort`, `emptyResolverPort` | tests/model-route-task-hook.test.ts | resolvers stub |
| `fixture`, `transportFor`, `stripSignature` | tests/model-route-canary-readiness.test.ts | readiness/canary herméticos |
| Stubs de boot (`StubCatalog`, `FakeCanaryTransport`, `CapturingPublisher`, spies de supervisor) | tests/windows-boot-manager.test.ts | boot hermético, kill -9 simulado |

Convención del repo: tests en `tests/*.test.ts` ejecutados con `npx tsx`, herméticos (tmp dirs, sin red, sin serve real), aserciones con helpers propios.

## Nota sobre el grafo PMC

Los símbolos de estos módulos figuran como `enriched` pero sus `semanticSummary` están vacíos y el grafo no tiene edges de dependencias cargados — las relaciones de arriba se extrajeron de los imports reales del código (verificadas 2026-07-30). Confiar en el código, no en el enrich, para este apply. Claves PMC útiles: `ts|src/infrastructure/opencode/model-route-task-hook.ts|class|exported|ModelRouteTaskHook|0`, `ts|src/infrastructure/opencode/model-route-readiness.ts|class|exported|ModelRouteReadiness|0`, `ts|src/domain/model-routing/natural-model-intent.ts|function|exported|parseNaturalModelIntent|1`.

## Restricciones

- No modificar producción salvo que un test RED lo justifique; cada cambio de producción con su RED previo.
- No tocar WU5 (real-host E2E, docs operador). No tocar icacls ni env scrubbing (D3).
- Prompt crudo nunca en audit/logs; secrets nunca en disco/env/logs/audit.
- Sin commits, branches ni push.

## Cierre obligatorio

1. `npx tsx tests/natural-routing-security-failures.test.ts` limpio.
2. `npm run test:typecheck:strict` + `npm run build` + suite completa sin regresiones (en particular `tests/natural-model-routing-task-hook.test.ts`, `tests/windows-boot-manager.test.ts`, `tests/natural-model-intent.test.ts`, `tests/model-route-audit.test.ts`).
3. Actualizar checkboxes WU4 en `sdd/natural-model-routing/tasks.md` y `apply-progress.md` con evidencia honesta RED→GREEN→REFACTOR, desviaciones y riesgos.
4. `pmc refresh-context --enrich` y guardar apply-progress en PMC (formato de `d06bf17c`).
