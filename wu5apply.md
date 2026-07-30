# WU5 Apply — Real-host E2E + attestation evidence (`natural-model-routing`)

> Fuente: tasks autoritativo PMC `1bf62713-dff6-4b0a-a680-f356fa20d13f` (Phase 5) + tasks locales `sdd/natural-model-routing/tasks.md` §WU5 + estructura verificada contra el código (imports reales, 2026-07-30) + estado de WU4 cerrado (10/10 secciones, remediation 4.4–4.6 ✅).
> Repo: `C:/Users/aabad/documents/code/ia/sdd-plugin2`

## Misión

Ejecutar WU5 con disciplina TDD donde aplique, budget ≤800 líneas cambiadas. WU5 NO es principalmente escritura de código: es la **verificación real-host** del path natural completo contra un OpenCode 1.18.9 en vivo y el **registro de evidencia de attestation en PMC**, sin fabricar attestations ni evidencia sintética. 5.3 (Operator Guide) y 5.4 (rollback documentado) ya están hechos — este apply solo los VERIFICA, no los reescribe.

**Precondición (bloqueante)**:

1. Correr `npm run test:model-routes` y `npx tsx tests/natural-routing-security-failures.test.ts`. Todo debe estar verde. Si algo falla, FRENAR y reportar — regresiones de WU1–WU4 no se arreglan desde WU5.
2. Confirmar disponibilidad del host real: OpenCode **1.18.9** instalado (`opencode --version`), red local disponible para `opencode serve --hostname 127.0.0.1` (puerto default 4096), y credenciales de provider reales configuradas en el host. Sin host real, 5.1/5.2 permanecen BLOCKED y el apply se cierra solo con la verificación de gating (Task 1) — eso NO es un PASS de WU5.

## Artefactos autoritativos

| Artefacto | ID PMC | Uso |
|---|---|---|
| Tasks autoritativo Phase 5 | `1bf62713-dff6-4b0a-a680-f356fa20d13f` | Fuente operativa; manda sobre los locales |
| Spec | `dcf1d668-3349-4ac1-8d06-ce27a40174ef` | "Boot lifecycle", "Concurrency", "Compatibility" |
| Design final 1.18.9 | `41aa141d-1bbf-4cd0-aba7-63f82f83fbd6` | Contrato OpenCode probado (tabla source-proven) |
| Proposal | `aa40c70b-f635-4246-b94b-e065b0db688e` | Contexto de decisión |
| Tasks locales | `sdd/natural-model-routing/tasks.md` §WU5 | 5.1/5.2 pendientes, 5.3/5.4 hechos |
| Operator Guide (5.3/5.4) | `docs/windows-natural-routing-operations.md` | Secuencia operativa y exit codes — seguirlo al pie |
| Formato apply-progress | `d06bf17c-952e-4038-a118-eb3b19aab631` | Template del reporte final |

## Decisiones fijadas (respetar, no re-abrir)

- **D1 — Cero evidencia sintética**: los comandos gated (`canary:model-routes:real`, `e2e:model-routes`) rechazan sentinels (`boot-default`, `deterministic-key`) y exigen gate vars. Prohibido modificar el gating para "hacer pasar" la suite; host ausente / versión errónea / attestation ausente = **BLOCKED (exit 2)**, nunca PASS.
- **D2 — Secrecy boundary (del design PMC)**: `bootIdentity` es NO-secreto; la HMAC key de 256 bits SÍ es secreta. En PMC se registra evidencia con bootIdentity y metadata, **jamás** la signing key, y jamás key material en `.env`, audit, logs ni tickets (incident handling del Operator Guide).
- **D3 — No tocar producción**: WU1–WU4 están verificados. Si el host real expone un gap, se documenta como hallazgo y se abre track separado; no se parchea producción dentro de WU5 salvo test RED que demuestre defecto real del harness E2E (no del host).
- **D4 — El canary precede al E2E**: orden obligatorio del Operator Guide: generate → boot start (supervisor) → canary real ATTESTED → E2E real ATTESTED → evidencia PMC → stop/rollback check.

## Alcance

### Task 0 — Verificación de gating (hermética, sin host)

Confirmar que los harness gated fallan cerrado SIN host:

1. `npm run canary:model-routes:real` sin `OPENCODE_CANARY_REAL=1` → exit 2, mensaje `BLOCKED:` con el comando exacto requerido.
2. Idem con `OPENCODE_CANARY_REAL=1` pero `OPENCODE_CANARY_SIGNING_KEY=deterministic-key` → rechazo de sentinel, exit ≠ 0.
3. `npm run e2e:model-routes` sin `OPENCODE_E2E_ROUTING=1` → exit 2 BLOCKED.
4. Idem con gate vars pero sin `attestation.json` real en el workspace E2E → BLOCKED, no PASS.

Estos 4 checks son los tests de aceptación del harness; documentar exit codes reales en apply-progress.

### Task 1 (5.1 RED→GREEN) — Real-host natural-route E2E contra OpenCode 1.18.9

Harness existente (NO recrear):

- `tests/model-route-real-host-canary.integration.ts` (script `canary:model-routes:real`) — gate `OPENCODE_CANARY_REAL=1` + `OPENCODE_CANARY_URL` + `OPENCODE_CANARY_BOOT_ID` + `OPENCODE_CANARY_SIGNING_KEY` + `OPENCODE_CANARY_PARENT_MODELS` (JSON target→parent). Corre `ModelRouteCanary.verifyEveryRoute(manifest)` con `OpenCodeHttpCanaryTransport` real, valida `requiredOpenCodeVersion` del manifest y `GET /global/health` == `1.18.9`, emite attestation real vía `ModelRouteReadiness.issue({ttlMs: 15*60_000})`, imprime `{status:"ATTESTED", hosts, nonce, expiresAt, openCodeVersion, bootIdentity}`.
- `tests/model-route-routing-e2e.test.ts` (script `e2e:model-routes`) — gate `OPENCODE_E2E_ROUTING=1` + `OPENCODE_E2E_URL` + `OPENCODE_E2E_BOOT_ID` + `OPENCODE_E2E_SIGNING_KEY` + `OPENCODE_E2E_DB_PATH` + `OPENCODE_E2E_WORKSPACE`. Hace `prisma db push --accept-data-loss` con `DATABASE_URL=file:<DB_PATH>`, exige `attestation.json` real en disco, instancia `ModelRouteTaskHook` con Prisma real y verifica `output.args.subagent_type === expected.hostName`; imprime `{status:"ATTESTED", routedAgent, canonical, openCodeVersion}`.

Secuencia de ejecución (del Operator Guide):

1. `npm run generate:model-routes -- $workspaceRoot config/model-routing/routes.json` → verificar `manifest.json.requiredOpenCodeVersion === "1.18.9"` en `$workspaceRoot/.opencode/sdd-model-routing/`.
2. `npx tsx src/cli/model-route-boot.ts start $workspaceRoot` (supervisor long-lived; compone Prisma + `OpenCodeHttpCanaryTransport` + `OpenCodeModelCatalogAdapter` con `fetch(${baseUrl}/config/providers)` + `SyncConnectedModelsUseCase` + `OpenCodeProcessSupervisor` que spawnea `opencode.cmd serve` y exige health `version === "1.18.9"`) → debe alcanzar estado `ready` con attestation fresca.
3. `npm run canary:model-routes:real` con las gate vars del supervisor → `status: "ATTESTED"`, evidencia por ruta (distinct parent session model verificado vía `GET /session/:id` read-back, child user+assistant model evidence).
4. `npm run e2e:model-routes` con gate vars → `status: "ATTESTED"` y `subagent_type` reescrito al host owned esperado (natural intent E2E: prompt en lenguaje natural → canonical resuelto → gates → rewrite).
5. `npx tsx src/cli/model-route-boot.ts status $workspaceRoot` (read-only: attestation, expiry, lock) y luego `stop` → verificar que stop zeroiza/borra attestation+lock+control y restaura env.

Tests de aceptación 5.1 (todos deben registrar resultado real en apply-progress):

- T1: canary real ATTESTED con versión exacta `1.18.9` y ≥1 `CanaryEvidence` por ruta del manifest (hostName, targetCanonicalId, parentCanonicalId, parentSessionId, childSessionId, observedUser/AssistantCanonicalId).
- T2: E2E real ATTESTED con `subagent_type` == hostName esperado; un prompt legacy sin intent pasa byte-for-byte (sin rewrite, sin audit natural).
- T3: prompt natural con modelo fuera de fleet/quarantine → blocked (fail-closed observable en host real).
- T4: `status` refleja attestation con `expiresAt` futuro y `openCodeVersion === "1.18.9"`; `stop` deja el workspace sin attestation/lock/control.
- T5 (rollback 5.4): tras stop, `SDD_NATURAL_ROUTING=off` a nivel wrapper/deployment y restart del host → routing natural inactivo, bootstrap fail-closed sin credenciales (documentado: `SDD_NATURAL_ROUTING` no existe en `src/`; es marker operator-level).

Nota autoritativa: el tasks PMC Phase 5.1 nombra `tests/model-route-natural-e2e.real-host.test.ts`; el repo ya materializó ese harness como `tests/model-route-routing-e2e.test.ts` + `tests/model-route-real-host-canary.integration.ts` (desviación de nombre registrada, cobertura equivalente: server real, catalog readback, distinct-parent, command execution, sin attestation sintética). No duplicar el archivo; si el verificador exige el nombre autoritativo, renombrar es la única acción válida.

### Task 2 (5.2 GREEN) — Attestation evidence en PMC

No existe mecanismo de código para esto; se hace con tooling PMC (`mcp__agent-memory__store` / `pmc`), siguiendo el Operator Guide ("registrar el JSON output y el path del attestation en PMC como evidencia WU5").

Grabar UNA memoria de evidencia con:

- `status: "ATTESTED"` del canary y del E2E, `openCodeVersion: "1.18.9"`, nonce, `issuedAt`/`expiresAt`, `manifestHash`, `workspaceIdentity`, path del `attestation.json`, exit codes reales de cada comando, fecha/hora y host.
- `bootIdentity` (NO-secreto, permitido). **PROHIBIDO**: signing key, hex de la HMAC key, prompts crudos con datos sensibles.
- Tags: `sdd`, `natural-model-routing`, `wu5`, `evidence`, `attestation`, `real-host`, `opencode-1.18.9`, `pmc-only`.
- Topic alias sugerido: `sdd/natural-model-routing/wu5-attestation-evidence`.

Test de aceptación 5.2:

- T6: readback de la memoria (`agent-memory_search` / `resolve_topic`) devuelve la evidencia íntegra.
- T7: la evidencia NO contiene la signing key ni ningún patrón de secreto (grep de los 9 patrones usados en WU4 sección 8 sobre el contenido grabado).

### Task 3 (5.3/5.4) — Verificación de docs (ya implementados)

- `docs/windows-natural-routing-operations.md` cubre: boot wrapper usage, startup canary verification, environment overrides, troubleshooting catalog-missing, rollback `SDD_NATURAL_ROUTING=off`, exit codes (3/4/5/7/1), incident handling. Verificar que los comandos documentados existen y coinciden con `package.json`/CLI (excepción conocida: el header del CLI menciona `npm run model-route:boot` que NO existe en package.json; el doc usa `npx tsx` directo, que es lo correcto — documentar la discrepancia, no "arreglarla" cambiando comportamiento).
- T8: checklist del doc ejecutado paso a paso en el host real durante Tasks 1–2; cualquier paso que no coincida con la realidad se corrige en el doc (únicos cambios de archivo esperados en este apply).

### Task 4 (REFACTOR / cierre) — Verificación completa del repo

- `npm run test:typecheck:strict`, `npm run build`, `npm run test:model-routes`, suite WU4, y `npm test` completo (documentar limitación conocida: el build encadenado de `npm test` puede fallar bajo sandbox Windows al resolver la ruta del config — si ocurre, reportar exit status exacto y causa, no parchear).
- Zero secret leakage: grep del workspace por key material post-stop (reuse del patrón `walkForContent` de `tests/helpers/model-routing-fixtures.ts`).
- Actualizar checkboxes WU5 en `sdd/natural-model-routing/tasks.md` y `apply-progress.md` con evidencia honesta (exit codes reales, sin cifras fabricadas — lección W6 de WU4).
- `pmc refresh-context --enrich` y guardar apply-progress WU5 en PMC (formato de `d06bf17c`).

## Estructura de archivos y relaciones (verificada contra imports reales)

### Harness E2E gated (SUT directo de 5.1)

```
tests/model-route-real-host-canary.integration.ts   (script canary:model-routes:real)
├── gate: OPENCODE_CANARY_REAL=1 + URL/BOOT_ID/SIGNING_KEY/PARENT_MODELS; rechaza sentinels → exit 2 BLOCKED
├── import: src/infrastructure/opencode/model-route-canary.ts → ModelRouteCanary, OpenCodeHttpCanaryTransport
├── import: src/infrastructure/opencode/model-route-readiness.ts → ModelRouteReadiness.issue (ttlMs 15min), REQUIRED_OPENCODE_VERSION
└── output: {status:"ATTESTED", hosts, nonce, expiresAt, openCodeVersion, bootIdentity}

tests/model-route-routing-e2e.test.ts               (script e2e:model-routes)
├── gate: OPENCODE_E2E_ROUTING=1 + URL/BOOT_ID/SIGNING_KEY/DB_PATH/WORKSPACE; sin attestation.json real → BLOCKED
├── prisma db push --accept-data-loss (DATABASE_URL=file:<DB_PATH>)
├── import: src/infrastructure/opencode/model-route-task-hook.ts → ModelRouteTaskHook (Prisma real)
└── assert: output.args.subagent_type === expected.hostName; output {status:"ATTESTED", routedAgent, canonical, openCodeVersion}
```

### CLI / composition root (cómo se llega al host real)

```
src/cli/model-route-boot.ts   (subcomandos: start|stop|status; SIN named exports — entry point)
├── paths: <ws>/.opencode/sdd-model-routing/{manifest.json, generator.lock, attestation.json, boot-control.json}
├── baseUrl: process.env.SDD_OPENCODE_BASE_URL ?? "http://127.0.0.1:4096"
├── OpenCodeProcessSupervisor (local): spawnServe → `opencode.cmd serve --hostname 127.0.0.1`;
│   waitForHealthy → polling GET /global/health (30s) exigiendo version === "1.18.9";
│   spawnAttach → `opencode attach <baseUrl>`
├── compone: PrismaClient(PrismaLibSql) → PrismaModelRouteCatalogAdapter,
│   OpenCodeHttpCanaryTransport({baseUrl}), OpenCodeModelCatalogAdapter (config.providers stub via fetch),
│   PrismaModelRepositoryAdapter, SyncConnectedModelsUseCase, WindowsModelRouteBootManager
├── classify() exit codes: 2 args, 3 CatalogRouteMissingError, 4 CanaryBlockedError, 5 MANIFEST_MISSING, 7 StaleLockUnrecoverableError, 1 resto
└── defaultSelectParentModel: google/* → openai/gpt-4o; resto → google/antigravity-gemini-3.6-flash-tiered
```

### Boot manager / readiness / canary (firma pública relevante para E2E)

```
src/infrastructure/runtime/windows-model-route-boot-manager.ts
├── class WindowsModelRouteBootManager(options) — start() single-flight, stop() idempotente
│   (zeroiza key, borra attestation+lock+control, restaura env), getState(), getAttestation()
├── estados: idle→starting→syncing→canarying→ready→stopping|failed
├── errors: CatalogRouteMissingError(CATALOG_ROUTE_MISSING), StaleLockUnrecoverableError (exit 7)
└── env secrets: SDD_MODEL_ROUTING_BOOT_ID / SDD_MODEL_ROUTING_SIGNING_KEY (childEnv si hay supervisor)

src/infrastructure/opencode/model-route-readiness.ts
├── ModelRouteReadiness.issue({manifest, evidence, openCodeVersion, bootIdentity, ttlMs}) / verify({...})
├── ReadinessAttestation: schemaVersion, verifierVersion, openCodeVersion, workspaceIdentity,
│   generationEpoch, manifestHash, fileHashes[], bootIdentity, nonce, issuedAt, expiresAt,
│   canaries: CanaryEvidence[], signature (HMAC-SHA256)
├── persistencia atómica: tmp+rename+fsync+applyCurrentUserAcl → <ws>/.opencode/sdd-model-routing/attestation.json
└── consts: REQUIRED_OPENCODE_VERSION="1.18.9", READINESS_VERIFIER_VERSION="1.0.0"

src/infrastructure/opencode/model-route-canary.ts
├── OpenCodeHttpCanaryTransport({baseUrl}): POST /session, POST /session/:id/command (SIN model),
│   GET /session/:id/children, GET /session/:id/message, GET /session/:id (read-back)
├── ModelRouteCanary.verifyEveryRoute(manifest) → CanaryEvidence[]
│   (parent distinto → read-back exacto session.model → diff children → user+assistant model evidence)
└── CanaryBlockedError codes: CANARY_FAILED | PARENT_MODEL_UNAVAILABLE | PARENT_MODEL_MISMATCH |
    CHILD_SESSION_MISSING | CANARY_METADATA_MISMATCH | CANARY_METADATA_UNOBSERVABLE | CANARY_TIMEOUT
```

### Contrato OpenCode 1.18.9 (source-proven, design `41aa141d`)

| Operación | Contrato |
|---|---|
| `POST /session` | acepta `model:{providerID,id,variant?}`; un parent por modelo pedido; `variant` solo si configurado y hasheado en manifest |
| `GET /session/:id` | `session.model` autoritativo; el canary DEBE leerlo y exigir igualdad exacta antes de invocar comandos |
| `POST /session/:id/command` | DEBE omitir `model`; el command hereda el model del parent verificado |

## Datos semánticos PMC para el implementador

### Memorias autoritativas / de contexto

| Contenido | ID |
|---|---|
| Tasks autoritativo (Phase 5 manda) | `1bf62713-dff6-4b0a-a680-f356fa20d13f` |
| Design final 1.18.9 | `41aa141d-1bbf-4cd0-aba7-63f82f83fbd6` |
| Spec | `dcf1d668-3349-4ac1-8d06-ce27a40174ef` |
| Proposal | `aa40c70b-f635-4246-b94b-e065b0db688e` |
| Plan WU3 v2 (drift fix, N1–N7) | `e18b5a26-3d4c-426e-af18-fe34cd05f169` |
| Pre-flight WU4 (D1–D3) | `f9dec8b2-c337-4eec-bbca-6cd50dea9941` |
| Formato apply-progress | `d06bf17c-952e-4038-a118-eb3b19aab631` |
| Este plan WU5 | `4aa78e5b-a007-4568-87f3-9549edc64742` (topic: `sdd/natural-model-routing/wu5-apply-plan`) |

### Claves de símbolos (formato `ts|<ruta>|<kind>|exported|<Name>|<arity>`)

- `ts|src/cli/model-route-boot.ts|…` — entry point sin named exports; inspeccionar con `pmc get-context src/cli/model-route-boot.ts`
- `ts|src/infrastructure/runtime/windows-model-route-boot-manager.ts|class|exported|WindowsModelRouteBootManager|1`
- `ts|src/infrastructure/opencode/model-route-readiness.ts|class|exported|ModelRouteReadiness|1`
- `ts|src/infrastructure/opencode/model-route-canary.ts|class|exported|ModelRouteCanary|1`
- `ts|src/infrastructure/opencode/model-route-canary.ts|class|exported|OpenCodeHttpCanaryTransport|1`
- `ts|src/infrastructure/opencode/model-route-task-hook.ts|class|exported|ModelRouteTaskHook|1`
- `ts|src/infrastructure/opencode/opencode-model-catalog.adapter.ts|class|exported|OpenCodeModelCatalogAdapter|…` (`getConnectedModels(1)`)
- `ts|src/application/sync-connected-models/sync-connected-models.use-case.ts|class|exported|SyncConnectedModelsUseCase|2`
- `ts|src/domain/model-routing/natural-model-intent.ts|function|exported|parseNaturalModelIntent|1`

Nota (igual que en WU4): el grafo PMC tiene símbolos `enriched` con `semanticSummary` vacíos y sin edges cargados — confiar en el código y en este documento, no en el enrich. Lectura de evidencia PMC disponible vía `scripts/dump-pmc-artifacts.mjs <memory-id>` (node:sqlite sobre `.planning/project-memory-context/memory-db.db`).

### Helpers de test reutilizables

`tests/helpers/model-routing-fixtures.ts`: `sleep`, `cleanupDir`, `sha256`, `writeStrict`, `readAllLines`, `stubCatalog`, `BootStubCatalog`, `BootStubCanary`, `makeHook`, `makeBootManager`, `seedManifestAndAttestation`, `seedBootManifest`, `makeResolverWithAliases`, `makeResolverWithCatalog`, `walkForContent`, `readAllViaIndependentFd`. Convención: scripts top-level `await main()` con `npx tsx`, asserts manuales, sin framework.

## Restricciones

- Prohibido fabricar attestations/evidencia; host ausente = BLOCKED documentado, no PASS.
- Prohibido grabar signing key ni key material en PMC, audit, logs, `.env` o tickets. `bootIdentity` permitido (no-secreto por diseño).
- No modificar producción de WU1–WU4; no modificar el gating de los harness E2E para forzar verde.
- Sin commits, branches ni push.
- Cambios de archivo esperados: solo correcciones del Operator Guide si la realidad del host lo contradice, y actualización de `tasks.md`/`apply-progress.md`. Todo lo demás requiere justificación RED.

## Cierre obligatorio

1. Los 4 checks de gating hermético (Task 0) documentados con exit codes reales.
2. Si hay host: T1–T5 con outputs reales `{status:"ATTESTED",...}` registrados; si no hay host: cierre como BLOCKED con evidencia del gating, WU5 queda OPEN.
3. T6/T7: evidencia PMC grabada y verificada sin secretos.
4. `npm run test:typecheck:strict` + `npm run build` + `npm run test:model-routes` + suite WU4 verdes; `npm test` reportado con exit status exacto (limitación sandbox documentada si aplica).
5. Checkboxes WU5 en `sdd/natural-model-routing/tasks.md` y `apply-progress.md` con cifras medidas reales.
6. `pmc refresh-context --enrich` + apply-progress WU5 guardado en PMC (formato `d06bf17c`) + topic alias `sdd/natural-model-routing/wu5-attestation-evidence`.
