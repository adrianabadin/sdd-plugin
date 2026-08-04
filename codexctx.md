# Handoff: SDD phase agents

## Estado actual

- Repositorio: `C:\Users\aabad\documents\code\ia\sdd-plugin2`
- Branch: `feat/sdd-phase-agents`
- HEAD: `d10b2928799ac9fe2161a2eb8fb12371c4909294` (`d10b292`)
- Memoria PMC: `7105331a-a743-4779-abfb-e1254bd60143`
- Engram: observación `#2420`; topic key `sdd/sdd-phase-agents/remediation-handoff`

## Advertencia principal

`docs/superpowers/specs/2026-08-02-sdd-phase-agents-VERIFY.md` está **desactualizado**. Fue escrito antes de una tanda de remediación no reflejada en ese informe. Tratarlo únicamente como hipótesis: rederivar cada hallazgo contra el árbol en `d10b292` antes de abrir trabajo de remediación.

No entregar el brief de remediación #2418 a un agente `sdd-apply` tal cual: apunta a código que ya cambió y ya provocó un slice desperdiciado.

## Cambios ya incorporados

Dos commits de la sesión actual en `feat/sdd-phase-agents`:

- `014ee5d` — SG-5 / SG-4 / C-2:
  - abort real en el gateway semántico mediante `AbortSignal`;
  - prueba del throw ante truncamiento;
  - `sddParseRequest` queda bajo timeout con prueba de puerto colgado.
- `d10b292` — baseline de la implementación SDD y de las 14 suites, más tres bloqueadores reales del MCP surface:
  - se eliminó el shadowing de `sddParseRequest` en `src/bootstrap/sdd-tools.ts` (el `execute` estaba llamando al `ToolDefinition`, no al use case);
  - se corrigieron dos violaciones de `exactOptionalPropertyTypes` mediante conditional spreads;
  - la declaración ambiente `node:sqlite` pasó a `src/types/node-sqlite.d.ts`; se removió la copia/configuración duplicada de tests.

También ya están implementados los hallazgos que el VERIFY viejo llama C-1, C-3, C-4 y el MCP surface: concurrencia optimista de checkpoints, read-back, bloqueo en `compute-status` y las siete herramientas PMC. No asumir que siguen pendientes.

## Evidencia de gates anterior

La sesión anterior ejecutó y dejó verdes:

- `npm run test:typecheck:strict`
- `npm run test:typecheck:persistence`
- `npm run build`
- las 14 suites `tests/sdd-*.test.ts`

Falla conocida y ajena al trabajo SDD: `npm run test:model-routes` falla en `model-route-cli.test.ts` porque hay 13 agentes `sdd-mr-v1-*.md` reales en `.opencode/agents/` y el test asume el directorio vacío. No perseguirla como regresión de esta fase.

## Pendiente exacto

Ejecutar un `sdd-verify` nuevo, de solo lectura, con Opus contra `d10b292`, usando esta instrucción:

> El `VERIFY.md` en disco es una hipótesis posiblemente obsoleta. Re-derive cada hallazgo contra el código y pruebas actuales de `d10b292`; no reabra C-1/C-3/C-4 ni el MCP surface sin evidencia actual.

Este handoff no ejecutó ese verify fresco: en el entorno Codex actual no hay binario `opencode` ni un dispatcher `sdd-verify` instalado en el workspace. Una auditoría local no debe presentarse como sustituto de aquella revisión independiente.

## Posibles temas que requieren revalidación

- WF-3: `tests/sdd-worktree-fingerprint.test.ts` alimenta literales `porcelainStatus` al comparador puro; la captura real `git status --porcelain=v1 -uall` no está caracterizada. Quitar `-uall` deja los tests verdes.
- `src/domain/sdd/worktree-fingerprint.ts`: un fallo de `git status` se convierte en cadena vacía, lo que puede degradar silenciosamente el guard a árbol limpio.
- La anterior deferral del MCP surface no quedó documentada; posiblemente ya sea irrelevante porque la superficie ahora existe. Confirmar antes de cambiar el alcance del SPEC.

## Decisiones del usuario

- Scope: completo (todos los CRITICAL y los 13 WARNING).
- Entrega: PRs encadenados, `feature-branch-chain`; tracker `feat/sdd-phase-agents`, el primer PR apunta al tracker y cada PR siguiente al anterior.
- Artifact store: híbrido — archivos en `docs/superpowers/specs/` y Engram del proyecto `sdd-plugin`.
- Estrategia: Strict TDD. Cada ítem debe comenzar en RED y probar que el test discrimina: romper la implementación, ver rojo, restaurar, ver verde.

## Límites del árbol de trabajo

El lado SDD queda limpio respecto de `d10b292`, pero el worktree contiene cambios ajenos. No barrerlos en commits SDD:

- `.codex/config.toml`, `.gitignore`, `AGENTS.md`, `package.json`
- `config/model-routing/routes.json`
- `src/domain/model-routing/natural-model-aliases.ts`
- `src/infrastructure/opencode/disk-agent-generator.ts`
- `src/infrastructure/opencode/foreign-agent-scan.ts`
- `src/infrastructure/opencode/foreign-agent-sources.ts`
- `tests/model-route-disk-generator.test.ts`
- `.zcode/`, `glmdocu-contexto.md`, `glmdocu.md`, `reasonix.toml`
- `docs/plans/2026-08-01-permission-enforcement-spike-notes.md`
- `docs/superpowers/specs/claudeconversacion.md`

## Regla de diagnóstico ya demostrada

El patrón de defectos recurrentes es un test que verifica literales construidos a mano contra un comparador puro, sin ejecutar la captura o wiring de producción. Para remediaciones, preferir la entrada real de producción (por ejemplo, `assembleStatus`) antes que pasar el mismo arreglo artificial a funciones auxiliares.
