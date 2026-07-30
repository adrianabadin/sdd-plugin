# Plan v2: Resolver scope drift WU3 — natural-model-routing (verificado sdd-verify)

> Fuente: memoria PMC `e18b5a26-3d4c-426e-af18-fe34cd05f169` (topic `plan/wu3-scope-drift-fix`, v2).

**Memoria origen del drift**: 7beddc6b-ecb1-4ffa-8cce-53db6286471f.
**Artefactos autoritativos**: diseño 41aa141d-1bbf-4cd0-aba7-63f82f83fbd6, tasks 1bf62713-dff6-4b0a-a680-f356fa20d13f (Phase 3, ítems 3.1–3.4), proposal aa40c70b-f635-4246-b94b-e065b0db688e.
**Budget**: ≤800 líneas cambiadas. TDD RED→GREEN→REFACTOR.
**Estado tests actuales**: los 10 de tests/windows-boot-manager.test.ts PASAN pero contra el alcance reducido — varios deberán REESCRIBIRSE (no solo extenderse) al reemplazar el readiness ad-hoc.

## Gaps conocidos (5 originales)

1. Spawn de `opencode serve` + health/version check: no existe en el repo. Construir desde cero.
2. Sin sync de catálogo en vivo antes del read-back: el manager solo hace `existsCanonical` contra Prisma (stale). Piezas: `OpenCodeModelCatalogAdapter` (src/infrastructure/opencode/opencode-model-catalog.adapter.ts, `getConnectedModels()`), `SyncConnectedModelsUseCase` (src/application/sync-connected-models/, `constructor(catalog, repository)`, `execute()`), `PrismaModelRouteCatalogAdapter`.
3. Canario sin GET /session/:id read-back del padre (igualdad exacta de session.model; nuevo error PARENT_MODEL_MISMATCH).
4. Readiness ad-hoc en vez de `ModelRouteReadiness` (src/infrastructure/opencode/model-route-readiness.ts: issue/verify, nonce, TTL, REQUIRED_OPENCODE_VERSION="1.18.9"); stop() no borra readiness.
5. src/cli/model-route-boot.ts:152 hace stop() inmediato y sale; sin attach, sin supervisión; `status` imprime idle de un manager nuevo (inútil).

## Nuevos bloqueos encontrados por verificación (N1–N7)

- **N1 — Distribución de key/bootIdentity**: el hook verificador lee `SDD_MODEL_ROUTING_BOOT_ID`/`SDD_MODEL_ROUTING_SIGNING_KEY` de SU proceso (src/bootstrap/index.ts:98-123, 260-285) y falla ROUTING_NOT_CONFIGURED si faltan. El spawn de serve debe inyectar AMBAS variables en el env del hijo (asumiendo que el plugin corre dentro del proceso serve — **validar esto primero**). `getSigningKey()` (windows-model-route-boot-manager.ts:166-173) dice "MUST NOT echo the key" — reconciliar con la necesidad de pasarla al env del hijo. Absorber en Paso 3.
- **N2 — Sin lock ni borrado de readiness stale al boot**: el diseño abre con `lock → remove stale readiness`. Además `ModelRouteReadiness.assertCurrentState` (model-route-readiness.ts:185) trata la presencia de generator.lock como mismatch → crash mid-boot deja dispatch fail-closed para siempre sin recovery. Y el subcomando CLI `stop` instancia un manager fresco en idle → no-op cross-process. Absorber en Pasos 2/4 + historia de stale-lock recovery.
- **N3 — Paso "generate fleet" ausente**: el manager solo LEE el manifest; nada invoca el generador ni verifica fileHashes al boot (eso solo lo hace ModelRouteReadiness.issue/verify, que el path ad-hoc bypasea). Clarificar ownership; adoptar issue (Paso 2) cubre la verificación de hashes.
- **N4 — ACL Windows real**: FileReadinessPublisher hace chmod 0600 best-effort = NO-OP en Windows; el test 7 skipea la aserción en win32, la plataforma objetivo. ModelRouteReadiness.atomicPersist (model-route-readiness.ts:217) tiene el mismo problema. Requerido: icacls/ACL restringida al SID del usuario actual para readiness Y attestation.
- **N5 — Sin TTL/expiry ni renewal**: el cuerpo ad-hoc carece de expiresAt/nonce/openCodeVersion/verifierVersion/fileHashes. El dispatch (model-route-task-hook.ts:305-324, ya implementado en WU2) depende de verify con expiry. Definir TTL y decisión de re-emisión durante boots long-lived. Absorber en Paso 2.
- **N6 — Invalidación en restart incompleta**: el archivo viejo queda en disco entre muerte del proceso y nuevo ready; solo salva la key efímera por boot. Pero bootstrap acepta key estática por env (src/bootstrap/index.ts:118-123), lo que derrota la rotación. Establecer: key generada por boot es la única fuente válida; reconciliar con el path legacy de env vars.
- **N7 — Env scrubbing de attach**: "attach receives routing variables removed" — al spawnear attach hay que construir el env del hijo BORRANDO ambas SDD_MODEL_ROUTING_*. No existe utilidad de scrubbing. Sub-requisito explícito del Paso 4.

## Pasos del plan (v2)

**Paso 0 — RED tests** (reescribir los que cubren readiness ad-hoc + extender). Aserciones requeridas (las 10 de la verificación):

1. Version mismatch (serve ≠ 1.18.9) → boot fail-closed sin readiness.
2. Stale readiness pre-sembrado → removido/reemplazado; boot fallido no deja ninguno.
3. Lock adquirido al inicio, liberado en stop; comportamiento con lock retenido y stale lock post-crash (N2).
4. ACL win32: readiness/attestation solo SID del usuario actual (N4).
5. Env scrubbing: attach sin SDD_MODEL_ROUTING_*; serve CON ambas (N1/N7).
6. No-persistencia cross-restart: key/identidad del boot 1 no validan attestation del boot 2; ningún artefacto del boot 1 sobrevive.
7. Key nunca en logs/audit (grep de sinks; hoy solo se testea workspace y process.env).
8. Expiry: con now() inyectado, pasar expiresAt → verify lanza AttestationExpiredError; attestation emitida lleva nonce/expiry.
9. CATALOG_ROUTE_MISSING post-sync: sync invocado SIEMPRE antes del read-back (mock de orden), fallo del sync → fail-closed.
10. Journal/coverage gate en issue: issue lanza si journal no vacío o cobertura de canarios ≠ manifest.

Más lo ya listado: spawn serve, health/version wait, canary parent GET readback, ModelRouteReadiness issue/verify, attach spawn, shutdown controlado con borrado de readiness.

**Paso 1 — Canario parent read-back**: GET /session/:id tras crear padre; igualdad exacta de session.model antes del command; error PARENT_MODEL_MISMATCH. (Sin cambios)

**Paso 2 — Adoptar ModelRouteReadiness + lock + TTL**: reemplazar cuerpo ad-hoc por issue/verify; borrar attestation en stop(); lock acquisition al inicio + remoción de stale readiness/lock; definir TTL y política de renewal (N2/N3/N5); attestation con nonce/openCodeVersion/verifierVersion/fileHashes.

**Paso 3 — Orquestación serve + catalog sync + distribución de secretos**: spawn de `opencode serve` con bootIdentity Y HMAC key en env del hijo (resolver N1: el plugin debe correr dentro del proceso serve; reconciliar docstring de getSigningKey); poll health + versión vs REQUIRED_OPENCODE_VERSION; SyncConnectedModelsUseCase antes del loop existsCanonical (CATALOG_ROUTE_MISSING fail-closed); key efímera por boot como única fuente válida, reconciliar con env-var legacy de bootstrap (N6).

**Paso 4 — CLI supervisora + attach + ACL Windows**: start long-lived; spawn de attach con env scrubbed (sin SDD_MODEL_ROUTING_*); SIGINT/SIGTERM detiene attach+serve y borra readiness; `status` lee attestation/lock real; arreglar subcomando stop cross-process (N2); ACL icacls current-user SID para readiness/attestation en win32 (N4).

**Paso 5 — Verificación y artefactos**: npx tsx tests/windows-boot-manager.test.ts + npm test + npm run build + npm run test:typecheck:strict; actualizar sdd/natural-model-routing/tasks.md y apply-progress.md al alcance real; pmc refresh-context --enrich; actualizar memoria 7beddc6b como resuelta con evidencia.

## Orden, dependencias y riesgos

Paso 0 → Pasos 1 y 2 (independientes) → Paso 3 → Paso 4 → Paso 5.
Riesgos: Paso 3 = primer process supervisor del repo, validar contrato spawn/health de `opencode serve` 1.18.9 en host real (tests con stub inyectado); **N1 depende de la asunción plugin-in-serve-process — validarla temprano o el diseño de distribución de secretos cambia.**
No tocar: WU4 (security suite) y WU5 (real-host E2E). Sin commits/branches/push.
