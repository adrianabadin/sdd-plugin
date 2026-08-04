# Validación arquitectónica independiente — SDD Phase Agents

**Sesión:** 2026-08-01 · **Validador:** GLM-5.2 (cuarta pasada, independiente)
**Documento validado:** `docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md`
**Resultado:** revisión 5 → **revisión 6**, con tres correcciones aplicadas. Listo para `writing-plans`.

---

## 1. Veredicto de resumen

El diseño es **arquitectónicamente sano** y está listo para `writing-plans`,
con tres correcciones requeridas primero — ninguna cambia la arquitectura de
fondo. La separación identidad/contenido (`subagent_type` = modelo, fase =
prompt compuesto) que estructura todo es la decisión correcta para este repo,
verificada contra el código real. Las decisiones sobre permisos (abandonar
tiers por detección) son correctas y empíricamente fundamentadas.

La cuarta pasada encontró **un error de hecho** sobre el código y **dos
garantías que se apoyaban en prosa del orquestador** cuando el principio del
documento dice que las garantías viven en código determinista. Los tres están
corregidos en revisión 6. Lo notable: el error de hecho sobrevivió a tres
pasadas adversariales previas y es material (no cosmético), y la premisa de
serialización en §9.12 contradice exactamente el principio que §7.2 establece
dos secciones antes.

---

## 2. Lo que se verificó y confirmó (base del resto)

Cinco agentes verificaron independientemente cada afirmación técnica sobre el
código. **Resultado: 22 de 23 afirmaciones confirmadas exactas.** Las clave:

- **Path A vs Path B** — CONFIRMADO. `parseModelRouteGrammar` corre primero
  sobre `subagent_type`; si matchea, retorna antes de que el prompt se
  escanee. `parseNaturalModelIntent` falla cerrado (`BYTE_LIMIT_EXCEEDED`
  con prompt largo, ambiguo con dos triggers, **nunca** desvía al modelo
  equivocado). Base de §3.1 y de la decisión de dispatch por Path A.
  (`model-route-task-hook.ts:164-254`, `natural-model-intent.ts:193-217`)
- **Fleet keyed por modelo canónico** — CONFIRMADO (par `providerId/modelId`,
  no por fase ni por tier). (`disk-agent-generator.ts:345-352`)
- **`HARD_MAX_ROUTES = 24`** con comentario explicativo — CONFIRMADO, presente
  en el working tree sin commitear. `FLEET_DEFAULT_CAP = 8`.
  (`disk-agent-generator.ts:74-75`)
- **`permission` se emite pero no se compara en readback; `tools` SÍ
  produciría diff** — CONFIRMADO con listados de campo exactos.
  (`routed-agent-definition.ts:40-52`)
- **Alias table: 19 entradas, frozen, `"gemini flash 3.6 tiered"` presente y
  `"gemini 3.6"` ausente** — CONFIRMADO. El walkthrough canónico usa la frase
  que sí resuelve, deliberadamente. (`natural-model-aliases.ts:22-43`)
- **`QuarantinedModelError`** existe, se lanza post-resolución en el hook.
  (`model-route-task-hook.ts:83`)
- **`hashHostName` mezcla `baseTemplate` + canonical id** — CONFIRMado.
  (`model-route-host-naming.ts:29-42`)
- **`sizeException` bypass** — CONFIRMADO: declarar `cap >= routes.length`
  skipa el chequeo; el tope duro (`> HARD_MAX_ROUTES`) nunca se bypassa.
  (`disk-agent-generator.ts:357-367`)

La honestidad sobre errores previos (los 11 en §3 de DECISIONES) y el método
del spike (verificar por disco/logs, no por auto-reporte del modelo) son
inusuales y valiosos.

---

## 3. Hallazgos de la cuarta pasada (los tres corregidos)

### H1 — ERROR DE HECHO: la descripción del vector foreign-agent era inexacta

**Severidad: media.** El diseño afirmaba que el vector era que "el sweep
matchea por filename", así que un shadow file con prefijo en el frontmatter
pero no en el filename escapaba. **Falso para `scanForForeignAgentDefinitions`**:
esa función SÍ lee el frontmatter `name` (`foreign-agent-scan.ts:155-166`).

El vector **real** es estrecho en alcance pero preciso en efecto:
`checkName` solo corre su lógica de ownership para archivos cuyo nombre
resuelto ya empieza con el prefijo reservado (`foreign-agent-scan.ts:51`
gatea todo el body), y para esos early-returna sobre `ownership:
"workspace-owned-candidate"` (`foreign-agent-scan.ts:66-68`) — que es como
se sourcea el dir `.opencode/agent(s)/` del workspace
(`foreign-agent-sources.ts:43-44`). Así que *cualquier archivo que use el
prefijo reservado* en ese dir escapa al reporte. Archivos sin prefijo nunca
iban a ser reportados de todas formas; el early-return traga silenciosamente
justo el caso de shadow-file (nombre con prefijo) que el detector existe para
atrapar.

**Corrección aplicada:** reformulado el item cerrado de foreign-agent en el
diseño (§ "Closed items") con el mecanismo real, y el item de deuda §6.3 en
DECISIONES.md. La referencia genérica en §7.2 no necesitó cambio (no describía
el mecanismo).

### H2 — Garantía en prosa: la serialización del dispatch (§9.12)

**Severidad: media-alta.** §9.12 justificaba un exposure de concurrencia bajo
asumiendo "dispatch is serialized (one phase in flight)". **No existía ningún
mecanismo estructural** que lo enforce: no hay lock, no hay campo in-flight en
`sdd_status`, no hay tool que rehúse. Era prosa dirigida al orquestador (un
LLM) — exactamente el patrón que §7.2 corrige: "guarantees live in deterministic
code, not in prose the orchestrator may skip."

**Atenuación que el diseño sí tenía:** §9.12 también especifica concurrencia
optimista (read con versión, retry, fail loud), así que la consecuencia de dos
dispatches concurrentes no era pérdida silenciosa sino un conflicto detectado.
El mecanismo de backup contenía el daño; lo incorrecto era la premisa usada
para minimizar el riesgo.

**Decisión del usuario:** opción 1 (structural lock). **Corrección aplicada:**
- `sdd_status` gana `inFlightPhase: string | null` (§4).
- `sdd_compose_phase_prompt` adquiere el lock, rehúsa con
  `PhaseAlreadyInFlightError` si otra fase está en vuelo (§2).
- `sdd_save_artifact` libera el lock; un lock trabado (crash sin save) es
  visible en `sdd_status` para clears deliberados (§2).
- §9.12 reformulado: la serialización es ahora un hecho estructural, no una
  premisa; el optimistic-concurrency se mantiene como defense-in-depth contra
  PMC background enrichment (que escribe keys distintas y no respeta el lock).

### H3 — Tensión no resuelta: `sdd-verify` y el flag `mutating`

**Severidad: baja-media.** §6 define verify como "real test execution" —
inherentemente mutador del worktree (cachés, `__pycache__`, coverage). Pero el
flag `mutating` **nunca se declaraba por fase**, dejando a verify en tierra de
nadie: hace checkpoint como apply, ejecuta tests como apply, pero sin
clasificación clara respecto del fingerprint de §7.2.

**Decisión del usuario:** opción 2 (verify como `mutating: true` sin filtros).
**Corrección aplicada:**
- Tabla explícita de `mutating` por fase añadida en §7.2: init/explore/propose/
  spec/design/tasks/archive = false; apply/verify = true.
- La protección que verify pierde (el fingerprint no detecta un verify que
  edita código para hacer pasar tests) está declarada honestamente, cubierta
  por el Gatekeeper y la disciplina de verify (§6) en su lugar.
- Se rechazó la alternativa de una exclusion list de patrones de caché de test
  por ser la misma forma que la denylist de `pty_*` que §7.1 rechazó: un
  catálogo para siempre incompleto.

---

## 4. Las dos zonas críticas (que el autor pidió examinar con lupa)

### §7.2 fingerprint

Los límites **declarados** son honestos (gitignored, fuera-del-root, no-git).
Dos límites **no declarados** detectados:
1. La mayoría de las fases no-mutantes operan sobre artefactos que viven en
   PMC bajo `.planning/`, que git ignora. Un `explore`/`propose` que escribiera
   directo al store en vez de retornar por el Result Contract no sería
   detectado — debilita el guardrail para las fases que más lo necesitan.
2. El caso no-git no tiene `.gitignore`, así que el walk recursivo del root no
   tiene forma de saber qué ignorar (caminaría `node_modules/`).

Estos amplían H3 pero son secundarios. El mecanismo como conjunto es sano y
proporcionado al threat model declarado (model error, no modelo malicioso).

### §9 resoluciones (15 items)

**13 de 15 sólidas.** Bien razonadas: item 2 (size cap fail-loud), item 5
(degradación), item 7 (cold start refuse), item 11 (testing skill por config
key), item 13 (partial dropped, applyProgress computable), item 14
(normalización Windows). Los dos con problemas son los que se convirtieron en
H2 (item 12) y contribuyen a H3 (item 10) — ambos corregidos.

---

## 5. Lo que no se verificó (y por qué es aceptable)

- **No se re-corrió el spike de permisos** (1.18.11 vs 1.18.9). El método es
  sólido y el bypass de `pty_*` es estructural, no version-specific.
- **No se verificó que `glm-4.7-flash` siga respondiendo** live. Si cambiara,
  es item de implementación, no de arquitectura.
- **No se auditó el repo dependiente PMC** (`riesgos.md`). Las mitigaciones
  son razonables; la calidad depende del lado de PMC.

---

## 6. Cómo queda el plan después de las correcciones

### Cambios aplicados al diseño (revisión 5 → 6)

| Zona | Cambio |
|---|---|
| Header de status | revisión 5 → 6, documenta los tres hallazgos de la cuarta pasada |
| §2, fila `sdd_compose_phase_prompt` | agrega adquisición del dispatch lock (`inFlightPhase`), rehúsa con `PhaseAlreadyInFlightError` |
| §2, fila `sdd_save_artifact` | agrega liberación del dispatch lock; stuck lock visible en `sdd_status` |
| §4, schema | nuevo campo `inFlightPhase: string \| null` con semántica de dispatch lock |
| §7.2 | nueva tabla explícita `mutating` por fase; resolución del caso verify (mutating=true, gap declarado, cubierto por Gatekeeper) |
| §9 item 12 | reformulado: serialización es estructural vía lock, no premisa en prosa; optimistic-concurrency queda como defense-in-depth |
| § "Closed items", foreign-agent | mecanismo corregido: early-return de `workspace-owned-candidate`, no filename matching |

### Cambios aplicados a DECISIONES.md

| Zona | Cambio |
|---|---|
| Header | revisión 5 → 6 |
| §6.3 (deuda foreign-agent) | mecanismo corregido al real |
| §7 (estado de validación) | añadida cuarta pasada; retractada la afirmación "toda afirmación sobre el código es exacta" |
| §8 → §9 (nueva §8) | añadidos errores 12-14 de la cuarta pasada (foreign-agent mecanismo, serialización en prosa, mutating no declarado) |

### Estado final

- **Open items:** 0. Los 15 de §9 están resueltos; los 3 de la cuarta pasada
  están corregidos.
- **Afirmaciones sobre el código verificadas:** 22/23 exactas; la 23ª
  (foreign-agent) corregida en el documento.
- **Decisiones de diseño tomadas en esta sesión:** 2 (H2: lock estructural;
  H3: verify mutating=true sin filtros). Ambas aprobadas por el usuario.
- **Próximo paso:** `writing-plans` para el desglose de implementación.

### Archivos modificados (sin commitear)

- `docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md` (revisiones)
- `docs/superpowers/specs/2026-08-01-sdd-phase-agents-DECISIONES.md` (revisiones)
- `glmdocu.md` (este documento)

Más el cambio preexistente en el working tree:
- `src/infrastructure/opencode/disk-agent-generator.ts` (`HARD_MAX_ROUTES` 16→24)
- `tests/model-route-disk-generator.test.ts` (tests del nuevo tope)
- Otros archivos modificados listados en `git status` (routes.json, aliases, etc.)

---

## 7. Archivos de referencia

- Diseño (lo validado): `docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md`
- Decisiones y evidencia: `docs/superpowers/specs/2026-08-01-sdd-phase-agents-DECISIONES.md`
- Spike de permisos: `docs/plans/2026-08-01-permission-enforcement-spike-notes.md`
- Narrativa de la sesión de diseño: `docs/superpowers/specs/claudeconversacion.md`

Archivos de código cuyas afirmaciones se verificaron:
- `src/infrastructure/opencode/model-route-task-hook.ts`
- `src/infrastructure/opencode/disk-agent-generator.ts`
- `src/infrastructure/opencode/routed-agent-definition.ts`
- `src/infrastructure/opencode/resolved-agent-config-guard.ts`
- `src/infrastructure/opencode/foreign-agent-scan.ts`
- `src/infrastructure/opencode/foreign-agent-sources.ts`
- `src/domain/model-routing/model-route-grammar.ts`
- `src/domain/model-routing/natural-model-intent.ts`
- `src/domain/model-routing/natural-model-aliases.ts`
- `src/domain/model-routing/model-route-host-naming.ts`
- `src/domain/model-routing/model-route-resolver.ts`
- `config/model-routing/routes.json`
