# Contexto de la sesión de diseño — SDD Phase Agents para sdd-plugin2

Resumen de la conversación que produjo
`docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md`. No es una
transcripción literal — es la secuencia de decisiones en orden, con el
"por qué" de cada una, para que otra sesión (u otro modelo) pueda retomar
el hilo sin haber estado presente.

## Punto de partida

El pedido original: usar `https://github.com/Gentleman-Programming/gentle-ai`
(específicamente `docs/opencode-profiles.md` y los assets de OpenCode del
repo) como referencia para implementar fases de SDD en `sdd-plugin2` —
extraer nombres de fases, cuerpos de prompt de los subagentes, y la lógica
determinista que dispara el flujo (qué va en AGENTS.md para que el proceso
se dispare al pedirlo o al detectar el agente que el pedido lo amerita).

Se arrancó con `superpowers:brainstorming` (obligatorio antes de cualquier
trabajo creativo). Primer hallazgo de exploración: `sdd-plugin2` (nombre
real del paquete `SddPlugin`) es un plugin de OpenCode de **ruteo
determinista de modelos** — no tiene agentes de fase SDD propios, no tiene
`.claude/agents/` ni definiciones `.opencode` para SDD. El nombre "sdd" es
histórico/coincidencia con el proyecto, no una implementación de SDD en sí.

## Investigación del repo de referencia (gentle-ai)

Se delegó a un subagente en background (no bloqueante) fetchear vía `gh
api` los assets reales de OpenCode del repo de gentle-ai:
`internal/assets/opencode/*`, `internal/assets/skills/sdd-*/SKILL.md`,
`sdd-phase-common.md`, `sdd-status-contract.md`. Resultado guardado en el
scratchpad de esa sesión (no persistido — ver la crítica más abajo para el
contenido relevante que sí quedó documentado).

Hallazgo clave del propio doc de gentle-ai: **no existe heurística
autónoma de "complejidad SDD"** — el orquestador prohíbe explícitamente
que tamaño/riesgo/cantidad de archivos disparen SDD por su cuenta; solo un
pedido explícito o una propuesta ya aceptada lo dispara. Esto se adoptó
sin cambios.

## Aclaración de objetivo (antes de diseñar)

El primer intento de aclarar alcance vía `AskUserQuestion` fue rechazado
dos veces por el usuario (prefería texto libre a un formulario de
opciones). El objetivo real, dicho en sus palabras: que el plugin pueda,
de forma agéntica, elegir el modelo que ejecuta la tarea y pasar el prompt
adecuado a la fase de SDD correspondiente — ejemplo dado: *"Quiero crear
un Hello world en java usando sdd y el modelo gemini 3.6"* debería hacer
que el plugin sirva las preguntas de init directamente, guarde la config
en PMC o Engram, y despache el explore con el modelo pedido, pasando la
definición del agente como parte del prompt (no como un subagente
separado).

Se pidió explícitamente pensar en alternativas de **mínimo costo en
tokens**, considerando un modelo híbrido: un `/command` + un MCP que el
agente pueda ejecutar para despachar subagentes — versus generar agentes
al inicio de sesión para cada combinación modelo/fase.

## Hallazgo de arquitectura que definió todo lo demás

Al leer `model-route-task-hook.ts` y `disk-agent-generator.ts` se confirmó
algo crítico: este proyecto **ya tiene** un mecanismo de ruteo de modelo
por *identidad de agente* — reescribe `subagent_type` hacia un host
pre-generado por modelo canónico (fleet tope 8, máximo duro 16), disparado
por una frase de trigger en lenguaje natural embebida en el prompt mismo
(`ModelRouteTaskHook` Path B). Nunca usa `args.model`.

Esto significó que la "fase" SDD **no necesita ser una identidad de
agente en absoluto** — puede ser puro contenido de prompt, compuesto del
lado del servidor, mientras la identidad del agente siga seleccionando
solo el modelo. Esta separación (identidad = modelo, contenido = fase) es
la decisión de la que se derivó todo el resto del diseño.

## Crítica a gentle-ai (antes de adaptar)

Se le pidió al asistente criticar el diseño de gentle-ai antes de adaptar
nada. Puntos que se mantuvieron sin cambios: el Result Contract, el
Dependency Graph, el split costo-consciente del Gatekeeper
(inline-vs-fresh-context), la deduplicación de lanzamiento de subagentes,
y la anti-heurística de disparo explícito.

Puntos identificados como estructuralmente incompatibles o ineficientes:
- El modelo de "11 agentes por perfil" no encaja con el tope de fleet de
  este proyecto (8/16, indexado por modelo, no por fase).
- El dispatcher nativo de estado es openspec-first; para Engram cae en que
  el LLM recalcule el estado a mano — PMC no tiene representación en
  absoluto.
- Recuperación de artefactos vía `mem_search` → `mem_get_observation` es
  una danza de 2 llamadas por artefacto, cara en tokens.
- Boilerplate (gate de orquestador, override de ejecutor, branching de
  backend) repetido verbatim en los 10 archivos de skill.
- Preflight e init son dos rondas de preguntas bloqueantes separadas,
  fricción innecesaria para el flujo de "una sola línea dispara todo".

## Decisiones de diseño, en el orden en que se tomaron

1. **Split identidad/contenido**: `subagent_type` solo selecciona modelo
   (vía el hook existente); la fase es contenido de prompt ensamblado por
   una herramienta MCP nueva, `sdd_compose_phase_prompt`.
2. **Superficie de herramientas MCP** (todas deterministas, no-LLM):
   `sdd_parse_request`, `sdd_status`, `sdd_init_questions`,
   `sdd_save_config`, `sdd_compose_phase_prompt`, `sdd_save_artifact`,
   `sdd_checkpoint`.
3. **Preflight + init fusionados** en una sola ronda persistida por
   proyecto (no por sesión).
4. **Artefactos previos inlineados** al componer el prompt — cero
   round-trips de recuperación para el ejecutor.
5. **Esquema de estado unificado** (`sdd_status`) — mismo shape sin
   importar el backend (en ese momento todavía se contemplaba PMC/Engram;
   más tarde se resolvió a PMC solamente, ver más abajo).
6. **Granularidad de tareas = escenarios de spec.md**: un task = un
   escenario independientemente testeable RED→GREEN, nunca más de uno ni
   menos de uno por task. Esto hizo que `apply` y `verify` compartan el
   mismo eje de partición.
7. **Mecanismo de checkpoint/breadcrumb** (el más discutido): motivado por
   la pregunta del usuario sobre qué pasa si se corta la sesión o se
   cambia de modelo a mitad de un `apply` (ejemplo dado: sumar/restar/
   multiplicar ya implementadas, falta dividir). Resuelto como:
   - El ejecutor decide su propio alcance de batch y lo declara
     (`totalIds`) *antes* de escribir código.
   - Checkpoint (`completedId`) inmediatamente después de que cada
     escenario pasa su test — no al final del batch.
   - `sdd_status.checkpoint` expone `totalIds/completedIds/remainingIds`
     — retomar es leer `remainingIds` y despachar ahí, en cualquier
     modelo.
   - `batchNotes`: no es una transcripción de razonamiento — design.md ya
     debe llevar firma/contrato por escenario (Hard Rule agregada); solo
     captura desviaciones descubiertas a mitad de batch que design.md no
     pudo anticipar.
   - **Presupuesto de reintentos** (`attemptCounts`, tope 3): agregado
     porque el propio mecanismo de resume barato hace fácil el loop
     infinito sobre un item roto — riesgo que gentle-ai nunca tuvo por su
     granularidad más gruesa.
8. **Preguntas bloqueantes a mitad de fase**: los ejecutores nunca llaman
   herramientas interactivas directamente (son subagentes no interactivos,
   igual que en gentle-ai, donde el manejo de prompts bloqueantes vive
   solo en el orquestador). Se resuelve con `status: blocked` +
   `blockedOn{question, progressSummary}`; el orquestador relay-ea con su
   propio tool `question` y re-despacha la misma fase con la respuesta
   inlineada. `progressSummary` reusa el `executive_summary` que ya era
   obligatorio — no hace falta maquinaria nueva.
9. **Permisos por tier, no por prompt**: se descartó tanto generar agentes
   "al vuelo" (prohibido por una decisión architectural ya existente en
   este repo, `architecture/model-routing-boot-attestation-decision`, que
   impide que un hook de runtime genere/registre agentes o bypasee
   `DiskAgentGenerator` + boot manager + canary + attestation) como un
   hook paralelo de marcador de capacidad. Resuelto: extender el fleet
   existente para indexar por `(modelo, tier)` en vez de solo `(modelo)`
   — 3 tiers (`read-only`, `read-exec`, `read-write-exec`), `task: false`
   sin excepción en los tres (más estricto que gentle-ai, que solo lo
   pone en `review-refuter`).
10. **PMC como único backend** (persistencia + modelo semántico): se sacó
    Engram por completo de la ecuación. Antes de comprometerse, se auditó
    el repo real de PMC (`memory-context`) por riesgos — resultado
    documentado en `memory-context/riesgos.md` (11 riesgos, 3 altos/5
    medios/3 bajos), confirmando entre otras cosas que `pmc doctor`
    devolvió la ruta de memoria de OTRO proyecto en una corrida manual
    (causa raíz: no hay parámetro explícito de proyecto activo en la
    CLI/MCP server de PMC).
11. **Guardrails diseñados para no romper con futuros fixes de PMC**: se
    pidió explícitamente que las mitigaciones no dependieran del estado
    actual del bug. Se revisó cada una contra ese criterio; la única que
    no lo cumplía (llamar a Ollama directo "para siempre" en vez de a
    través de una interfaz propia) se corrigió a una gateway abstracta
    swappable por config.
12. **`pmc_get_context` sí permitido en los ejecutores** (a diferencia del
    store de artefactos SDD, que sigue prohibido): el usuario preguntó por
    qué no dejar que los subagentes consulten PMC, lo cual hizo notar que
    "PMC" mezclaba dos capacidades distintas — el store de artefactos
    (correctamente restringido) y la navegación de codebase vía
    `pmc get-context` (solo lectura, y de hecho ya exigida por el
    protocolo global del usuario para cualquier agente que toque código).
    Se separó la regla: prohibido auto-consultar el store de artefactos,
    permitido `pmc_get_context` en los tres tiers.
13. **Modelo default de la gateway semántica: GLM-4-Flash**, no Ollama —
    decisión final de la sesión. Referencia: `memory-context`'s
    `tools/project-memory-context/cli/name-communities.mjs` ya usa
    GLM-4-Flash (BigModel/Zhipu, endpoint OpenAI-compatible) para otra
    tarea semántica (naming de comunidades), leyendo la API key desde
    `BIGMODEL_API_KEY` en tiempo de llamada — nunca hardcodeada, regla que
    ya existe en `openspec/specs/community-naming/spec.md:37` de ese
    repo. Se adoptó el mismo patrón: config JSON con `endpoint`, `model`,
    `apiKeyEnvVar` (nunca la key en sí), `timeoutMs`.

## Nota de seguridad

Durante esta sesión el usuario pegó el valor real de `BIGMODEL_API_KEY` en
el chat (visible en logs de esa sesión de PowerShell). **Esa clave no fue
guardada en ningún artefacto de este diseño ni de esta conversación** — ni
en el spec, ni en PMC, ni en este archivo. Recomendación pendiente:
rotarla, dado que quedó expuesta en texto plano en una sesión de terminal.

## Segunda mitad: validación adversarial y el spike que cambió el diseño

Lo anterior era el diseño tal como quedó tras la primera ronda. Lo que
sigue pasó después, y modificó conclusiones importantes.

### Primera pasada adversarial (contexto fresco, Opus)

Encontró 5 hallazgos críticos y 11 importantes. Los que cambiaron el
diseño:

- **§7 (tiers de permisos) era inimplementable** tal como estaba: exigía
  tocar `routes.json`, su decoder, el manifest, `hashHostName`, el hook,
  el renderer y el comparador de readback — el mismo pipeline que la
  sección decía dejar intacto — y reventaba el cap (13 rutas × 3 tiers =
  39 > 16).
- **Riesgo de trigger natural**: `parseNaturalModelIntent` falla cerrado
  con más de un trigger, y `usando` es trigger. Un "usando" ordinario
  dentro de un artefacto inlineado habría bloqueado el dispatch. Se
  resolvió cambiando a Path A (gramática explícita), donde el prompt
  nunca se escanea.
- Varios huecos de especificación reales: campo `status` inexistente pero
  usado para routear, `attemptCounts` no computable con la interfaz
  declarada, sin semántica de merge entre batches sucesivos de `apply`,
  contradicción sobre quién persiste, `skill_resolution` eliminado sin
  reconocer la pérdida funcional.

### El rediseño de §7 y su re-validación

Se reescribió §7 sobre `baseTemplate` + `permission` — dos ejes que el
fleet ya tenía. La segunda pasada adversarial confirmó que las tres
afirmaciones de hecho eran correctas, **pero encontró que la premisa de
enforcement estaba contradicha por evidencia que ya existía en el repo**:
un spike previo había probado que `permission.task` se descarta
silenciosamente. Eso hizo caer una afirmación que yo había escrito como
establecida ("`task: deny` ya es la postura de todos los hosts, más
estricto que gentle-ai") — era falsa.

### El spike de enforcement

Se acordó **antes de correrlo** qué se haría con cada resultado, para que
el resultado no pudiera racionalizar la decisión: si salía negativo, los
tiers se abandonaban, no se reparaban.

Salió negativo. `edit: deny`/`bash: deny` sí sobreviven al parseo (a
diferencia de `task`) y sí sacan las herramientas del toolset — pero
`pty_spawn`/`pty_write` siguen disponibles y el motor de permisos nunca
las chequea. Un agente restringido, al que solo se le pidió escribir un
archivo, **usó PTY por su cuenta y escribió igual**, sin dejar rastro de
auditoría.

Decisión ejecutada: tiers abandonados, reemplazados por detección
(`git diff` post-fase como fallo del Gatekeeper) más límites por prompt.
Beneficio colateral: desaparece la multiplicación del fleet y todos los
cambios de código que los tiers implicaban.

### Otras resoluciones de esta mitad

- **Cap del fleet**: se investigó de dónde salía el 16 → **no hay
  justificación documentada en ningún lado** (código, openspec, historial
  de git, memoria PMC). Es un guard autoimpuesto, no un límite de la
  plataforma. Se subió a 32, después a 64 (razonando sobre tiers), y
  finalmente quedó en **24** al descartarse los tiers. Implementado con
  TDD estricto.
- **`glm-4.7-flash`**: verificado vivo con un POST real (HTTP 200). Salió
  un dato de diseño: es modelo de razonamiento, y con `max_tokens` bajo
  devuelve `content` vacío gastando todo en `reasoning_content`.
- **Egreso de datos**: aceptado explícitamente por el usuario, con
  constancia de que `batchNotes` manda diffs de código real a un tercero.
- **Skills**: rutas (no contenido), mapa estático que contiene *solo lo
  obligatorio* — precisión del usuario que es lo que permite exigir la
  lectura como requisito duro — y `skill_resolution` repuesto.

### Tercera pasada adversarial (sobre el documento completo)

Veredicto: las decisiones de fondo eran sólidas y **toda** afirmación sobre
el código resultó exacta, pero el documento no cerraba como spec
implementable. Lo que encontró:

- **El vocabulario de tiers había sobrevivido al abandono de §7 como texto
  normativo vivo** en §2, §3, §5 y §6 — no como historia. Un implementador
  habría construido un campo `tier` que §7.2 dice explícitamente que no
  debe existir. Fue una cirugía parcial.
- **La detección por git era ciega a `.opencode/`** (verificado: está en
  `.gitignore`), o sea que no veía la flota de agentes, el manifest, el
  lock, el journal ni el estado de PMC — que incluye exactamente el vector
  de shadow-file que se había diferido diciendo "este diseño ya no lo
  vuelve load-bearing". Los dos items cerrados se apoyaban uno en el otro.
- **Nada obligaba al orquestador a correr el chequeo**: la única propiedad
  de seguridad que quedaba dependía de que un LLM recordara una
  instrucción en prosa, en un documento cuyo principio es que las
  garantías viven en código determinista.
- **El ejemplo canónico del documento no resolvía**: `"gemini 3.6"` no está
  en la tabla de alias (la entrada es `gemini flash 3.6 tiered`), así que
  el walkthrough habría fallado en su primer dispatch.
- El checkpoint no podía sostener `apply` y `verify` a la vez; no había
  total autoritativo (`allIds`), así que `applyProgress: done` no era
  computable; el tope de reintentos lo enforzaba el LLM aunque el dato ya
  vivía server-side; `nextRecommended: init`/`select-change` eran
  inalcanzables; y §8.2 sobrevendía read-after-write como si mitigara la
  race de concurrencia (es durabilidad, no control de concurrencia).

Todo eso se corrigió. Dos errores míos adicionales quedaron registrados:
describir el hazard del "usando" como *misroute* (falla **cerrado**, no va
al modelo equivocado — no va), y afirmar que un `subagent_type` pelado era
passthrough seguro (es lo contrario: manda por Path B, que sí escanea el
prompt).

### Resolución de los 15 open items

Se resolvieron todos con defaults razonados, cada uno con su justificación
explícita para que se pueda discutir en vez de redescubrir. Los más
salientes:

- **Tope de tamaño**: falla duro nombrando el artefacto culpable, sin
  auto-resumir — resumir cambiaría silenciosamente lo que la fase ve, que
  es justo lo que el diseño de inlinear existe para evitar.
- **Cold start**: se niega con mensaje accionable, nunca auto-bootstrapea
  (`pmc init`/`map-project` son pesados y escriben fuera del namespace SDD).
- **Fingerprint**: `git status --porcelain=v1 -uall` + `HEAD` sha (cubre
  untracked, que `git diff` no muestra); fuera de git, walk de
  `(relpath, size, mtime_ns)`. Rutas ignoradas fuera de alcance, declarado.
- **Skill de testing**: se resuelve por *clave de config* (`testingSkill`,
  que escribe `sdd-init`), no sniffeando el stack en tiempo de composición
  — así el mapa sigue siendo estático. Sin skill registrada = `none`, no
  falla dura.
- **Concurrencia del checkpoint**: concurrencia optimista con versión,
  un reintento, y falla ruidosa al segundo conflicto.
- **`partial` eliminado** de los artefactos almacenados (un blob existe o
  no); solo `applyProgress` conserva tres estados, y ahora *computados*.
- **Degradación**: solo PMC es bloqueante; gateway y `pmc_get_context`
  degradan.

## Estado al cierre

Diseño en **revisión 5**, sin open items: los 15 quedaron resueltos y
aprobados por el usuario. Tres pasadas adversariales independientes con
contexto fresco, más un spike empírico que cambió una decisión central.

## Artefactos producidos

- `docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md` — el
  diseño (§1–§9).
- `docs/superpowers/specs/2026-08-01-sdd-phase-agents-DECISIONES.md` —
  registro de decisiones, alternativas descartadas, errores cometidos y
  corregidos, y toda la evidencia empírica recolectada.
- `docs/plans/2026-08-01-permission-enforcement-spike-notes.md` — el spike
  de permisos, con método y salida cruda.
- `C:\Users\aabad\documents\code\ia\memory-context\riesgos.md` — catálogo
  de riesgos de PMC, para que ese proyecto los trabaje del otro lado.
- Este archivo.
- Cambios en working tree (sin commitear): `HARD_MAX_ROUTES` 16 → 24 en
  `disk-agent-generator.ts` + sus tests.
- Memorias en `agent-memory` (PMC) bajo `sdd/opencode-sdd-phase-agents/design`.
