# Memoria pendiente de sincronizar con PMC

Fecha: 2026-07-30
Proyecto: `sdd-plugin2`

## Motivo

La sincronización PMC no pudo ejecutarse porque el ejecutable global `pmc`
no está instalado en esta sesión. El intento alternativo con:

```text
npx -y @aabadin/project-memory-context pmc refresh-context --enrich
```

falló con `npm error could not determine executable to run`.

El contexto previo sí fue recuperado mediante MCP/PMC Query. La resolución
también se guardó en Engram con el ID:

`7db1a0bd-42dd-4774-8415-d7a032f9d3b1`

## Review resuelto

El review WU3 había confirmado FAIL con 8 CRITICAL, 7 WARNING y 9 gaps de
producción abiertos. Se implementaron las correcciones siguientes:

- Supervisor real de `opencode serve`.
- Health check y validación exacta de OpenCode `1.18.9`.
- Sincronización obligatoria del catálogo antes del read-back.
- Canario con read-back exacto del modelo padre.
- Lock activo durante todo el lifecycle y recuperación de locks stale.
- TTL y renovación automática de attestation.
- Spawn de attach con `SDD_MODEL_ROUTING_BOOT_ID` y
  `SDD_MODEL_ROUTING_SIGNING_KEY` eliminados del entorno.
- Teardown de attach y serve en `stop`, errores y salida de hijos.
- Control record para status/stop cross-process.
- ACL Windows con `icacls`, restringida al usuario actual.
- Zeroización de la clave HMAC y restauración segura del entorno.
- Limpieza de attestation, lock y control record en todos los failure paths.

## Archivos principales modificados

- `src/infrastructure/runtime/windows-model-route-boot-manager.ts`
- `src/cli/model-route-boot.ts`
- `src/infrastructure/opencode/model-route-readiness.ts`
- `src/infrastructure/opencode/model-route-canary.ts`
- `tests/windows-boot-manager.test.ts`
- `tests/model-route-canary-readiness.test.ts`
- `sdd/natural-model-routing/tasks.md`
- `sdd/natural-model-routing/apply-progress.md`

También se crearon los diseños:

- `docs/plans/2026-07-30-wu3-production-supervision-design.md`
- `docs/plans/2026-07-30-wu3-production-supervision-implementation.md`

## Evidencia de verificación

- `npm run build`: PASS.
- `npm run test:model-routes`: PASS.
- `tests/windows-boot-manager.test.ts`: PASS.
- `npm run test:typecheck:strict`: PASS.
- `npm run test:typecheck:persistence`: PASS.
- `npm run test:exports`: PASS.
- `npm run test:integration`: PASS.
- `npm run test:persistence:guard`: PASS.
- La suite persistence reportó `30/30` gates PASS.

`npm run test:all` excedió el timeout de 120 segundos; no se debe registrar
como PASS global.

## Pendientes PMC

Cuando PMC vuelva a estar disponible, ejecutar:

```text
pmc refresh-context --enrich
```

Después sincronizar el contexto pendiente y actualizar la memoria del review
`596e277f-a08a-4846-9cd3-e5b543491857` con la evidencia final. La memoria
anterior estaba marcada `needs_review` y apuntaba al veredicto actualizado de
Engram.

## Estado del workspace

Se preservaron cambios previos no relacionados. También existe una
modificación en `.codex/config.toml` que no fue realizada como parte de esta
resolución y debe conservarse/revisarse por separado.

