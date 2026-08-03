# SDD Phase Agents — Registro de decisiones y evidencia

Compañero de `2026-08-01-sdd-phase-agents-design.md`. Ese documento dice
**qué** se va a construir; este dice **qué se decidió, por qué, y qué
evidencia lo respalda** — incluyendo las cosas que se probaron y se
descartaron, y los errores que cometí en el camino.

Fecha: 2026-08-01 · Estado del diseño: DRAFT revisión 6, sin open items

---

## 1. Decisiones firmes (con su razón)

| Decisión | Razón | Evidencia |
|---|---|---|
| La fase SDD **no es una identidad de agente**; es contenido de prompt compuesto del lado del servidor. `subagent_type` solo selecciona modelo. | El fleet de este repo está topeado y indexado por modelo canónico, no por fase. Portar el modelo de gentle-ai (11 agentes por perfil) era imposible. | `disk-agent-generator.ts` (cap + indexado por modelo), verificado por dos pasadas de validación. |
| **PMC como único backend** de persistencia; Engram fuera del diseño. | Colapsa una abstracción de doble backend que no aportaba nada a este proyecto, y saca una pregunta del init. | Auditoría del repo `memory-context` → `riesgos.md` (11 riesgos catalogados). |
| **Artefactos upstream inlineados** al componer el prompt; el ejecutor nunca consulta el store de artefactos. | gentle-ai exige `mem_search` → `mem_get_observation` por artefacto: 2 llamadas LLM cada uno. Inlinear las elimina y hace el dispatch reproducible. | `sdd-phase-common.md` de gentle-ai. |
| **`pmc_get_context` sí permitido** a los ejecutores. | "PMC" mezclaba dos capacidades: el store de artefactos (restringido) y la navegación de codebase (solo lectura, y ya exigida por el protocolo del proyecto para cualquier agente que toque código). | Observación del usuario durante la revisión. |
| Un task = **exactamente un escenario** de spec.md, testeable RED→GREEN en aislamiento. | Hace que `apply` y `verify` compartan el mismo eje de partición en vez de dos esquemas divergentes. | — |
| **Checkpoint incremental** en apply/verify, con `completedIds` acumulativo por fase. | Un corte por rate limit o cambio de modelo a mitad de batch pierde como máximo el item en vuelo. Un segundo batch no pisa el progreso del primero. | — |
| **Egreso de datos a BigModel: aceptado.** | Decisión explícita del usuario, tomada con conocimiento de que `batchNotes` manda diffs de código real a un tercero. | Documentado en §8.1 del diseño. |
| **Skills obligatorias por rutas**, mapa estático por fase, `skill_resolution` repuesto. | Pasar rutas (no contenido) preserva la intención del autor y es barato; que el mapa contenga *solo lo obligatorio* es lo que permite exigir la lectura como requisito duro. | Convención ya establecida del proyecto: "pass paths, not generated summaries". |
| **Dispatch por Path A** (gramática explícita), no Path B. | Cuando la gramática matchea, el prompt nunca se escanea por triggers naturales — elimina estructuralmente el riesgo de que un "usando" ordinario dentro de un artefacto inlineado se resuelva como referencia de modelo y desvíe el dispatch. | `model-route-task-hook.ts` (orden de `execute`), `natural-model-intent.ts`. |

---

## 2. Lo que se probó y se descartó

### 2.1 Generación de agentes en caliente (on-the-fly)

**Idea**: materializar un agente temporal con permisos acotados en el
momento del dispatch.

**Descartada** — no por límite técnico sino por una decisión arquitectónica
vigente del repo (`architecture/model-routing-boot-attestation-decision`,
que superseded a `plan/config-hook-fleet-agents`): un hook de runtime no
puede registrar/generar agentes ni saltear la cadena `DiskAgentGenerator +
boot manager + health/version + readback + canary + attestation firmada`.
Un agente materializado a mitad de sesión se saltearía canary y attestation.

### 2.2 Tiers de permisos (dos intentos, ambos fallidos)

**Intento 1** — keyear el fleet por `(modelo, tier)` con grants de `tools`
en el archivo del agente. **Invalidado por validación independiente contra
el código**: exigía cambiar `routes.json`, su decoder, `ManifestRouteEntry`,
`hashHostName`, el lookup del hook, el renderer *y* el comparador de
readback — justo el pipeline que la sección decía dejar intacto — y
reventaba el cap (13 rutas × 3 tiers = 39 > 16).

**Intento 2** — expresar el tier como `permission` (que sí se emite y no
produce diff en el readback) sobre el eje `baseTemplate` (que ya existe en
el hash de nombres y en la gramática declarada). Estructuralmente correcto,
pero **la premisa falló empíricamente**.

**El spike que lo cerró** (`docs/plans/2026-08-01-permission-enforcement-spike-notes.md`,
corrido contra OpenCode 1.18.11):

- *Observable 1 — ¿sobrevive al parseo?* **Sí.** A diferencia de
  `permission.task` (que un spike previo encontró descartado), `edit: deny`
  y `bash: deny` aparecen en la config resuelta vía `GET /agent`.
- *Observable 2 — ¿se aplica?* **Parcialmente, y es evitable.** El deny
  saca las herramientas del toolset (control: 18 herramientas; restringido:
  15, faltando `bash`/`edit`/`write`). Pero `pty_spawn`/`pty_write`/
  `pty_read` siguen disponibles y el motor de permisos nunca las chequea.
  Un agente restringido, al que solo se le pidió *"escribí un archivo y
  corré un comando bash"* —sin instrucción de evadir nada— usó PTY por su
  cuenta y creó el archivo, sin una sola línea `evaluated permission=` en
  el log.

**Por qué eso lo cierra**: el bypass no es adversarial, es el camino
natural que toma el modelo cuando le falta su herramienta habitual. La
restricción no impide la escritura, la desvía por un canal sin rastro de
auditoría — peor que no restringir, porque compra una falsa sensación de
control. Y perseguirlo significaría mantener una denylist de escapes
(`pty_*` hoy, lo que venga mañana), cosa que además no es expresable: el
tipo `permission` del SDK no tiene esa clave.

**Reemplazo**: detección en vez de prevención — límites explícitos en el
prompt de cada fase, más un chequeo `git status`/`git diff` después de toda
fase que no debía escribir, tratado como fallo del Gatekeeper. Garantía más
débil, elegida a propósito: el riesgo real es un modelo confundido
"ayudando", y `git diff` lo agarra en el acto.

> **Nota de método**: el fallback se acordó *antes* de conocer el resultado
> del spike, para que el resultado no pudiera racionalizar la decisión.

### 2.3 Tercer tier (`verify` con bash pero sin edit)

Descartado antes del spike: `bash: allow` ya permite `echo > archivo`,
`sed -i`, `git checkout`. Un tier "sin escritura" que conserva bash no es
una frontera de escritura, solo saca una herramienta.

---

## 3. Errores cometidos y corregidos

Se registran porque el diseño se apoyó en ellos por un tiempo.

1. **Afirmé que `task: deny` ya estaba vigente y era "más estricto que
   gentle-ai".** Falso: el propio spike previo del repo encontró que
   `permission.task` se descarta silenciosamente (el tipo del SDK declara
   solo `edit | bash | webfetch | doom_loop | external_directory`, sin
   index signature). Los bloques `task: deny` que el generador emite hoy
   son bytes cosméticos. Retractado explícitamente en §7.
2. **Propuse `tools` grants en el archivo del agente.** Rompe el readback:
   `compareResolvedAgentDefinition` lista `tools` entre las claves que
   producen diff.
3. **Omití cambios de código necesarios** en la primera versión de los
   tiers: el plumbing de `base` (hoy `routeFromGrammar` descarta
   `parsed.base` por completo), el estado de Path B (sin base, colapsaría
   al primer tier del manifest), y la validación fail-closed del
   vocabulario de tiers.
4. **Dije "solo apply y verify necesitan skills".** Demasiado angosto:
   `sdd-tasks` emite el forecast de chained-PR y 400 líneas, y las skills
   que definen ese formato son obligatorias para él.
5. **Sobredimensioné el cap dos veces** (32, después 64) razonando sobre
   tiers que terminaron descartados. Valor final: 24.
6. **Abandoné §7 con una cirugía parcial.** El vocabulario de tiers quedó
   vivo como texto normativo en §2, §3, §5 y §6 — un implementador habría
   construido un campo `tier` que §7.2 dice que no debe existir. Detectado
   por la tercera pasada adversarial.
7. **Dejé la única garantía de seguridad del diseño en prosa.** El chequeo
   post-fase dependía de que el orquestador (un LLM) se acordara de
   correrlo, en un documento cuyo principio declarado es que las garantías
   viven en código determinista. Ahora lo cargan
   `sdd_compose_phase_prompt` (emite fingerprint + flag `mutating`) y
   `sdd_save_artifact` (lo recomputa y reporta `unexpectedWrites`).
8. **No verifiqué que el ejemplo canónico funcionara.** `"gemini 3.6"` no
   está en `NATURAL_MODEL_ALIASES` (la entrada es `gemini flash 3.6
   tiered`), así que el walkthrough del documento habría fallado en su
   primer dispatch.
9. **Describí el hazard del "usando" inlineado como *misroute*.** Es al
   revés: `parseNaturalModelIntent` falla **cerrado**
   (`BYTE_LIMIT_EXCEEDED` con prompt largo, ambiguo con dos ocurrencias).
   El dispatch no va al modelo equivocado — no va. La conclusión sobre
   Path A no cambia, la caracterización sí era falsa.
10. **Afirmé que un `subagent_type` pelado era passthrough seguro.** Es lo
    contrario: manda al hook por Path B, que **sí** escanea el prompt.
    Como los prompts compuestos inlinean artefactos en español, ese era el
    camino peligroso, no el seguro.
11. **Sobrevendí read-after-write** como mitigación de la race TOCTOU de
    PMC. Es una prueba de **durabilidad**, no control de concurrencia:
    demuestra que los bytes estaban en T, no impide que otro los pise en
    T+1. Reenmarcado honestamente.

---

## 4. Evidencia empírica recolectada

| Pregunta | Método | Resultado |
|---|---|---|
| ¿De dónde salía el tope de 16? | Búsqueda en código, openspec, historial de git del commit que lo introdujo, y memoria de PMC | **Sin justificación documentada en ningún lado.** Es un guard de blast radius autoimpuesto, no una restricción de la plataforma. |
| ¿`permission.edit`/`bash` se aplican? | Spike con agente de control vs restringido, observando disco y logs del servidor | Parcial y evitable vía `pty_*` (§2.2) |
| ¿`glm-4.7-flash` existe? | POST real al endpoint de BigModel | **HTTP 200**, model id ecoado en la respuesta |
| ¿`glm-4.7-flash` se comporta como modelo simple? | Mismo probe con `max_tokens: 5` | **No: es modelo de razonamiento.** Gastó los 5 tokens en `reasoning_content` y devolvió `content` vacío → el gateway debe presupuestar `maxTokens` para razonamiento + respuesta, y tratar `content` vacío con `reasoning_content` no vacío como truncamiento, no como resultado válido. |
| ¿El fallo de `model-route-cli.test.ts` es del cambio de cap? | Inspección de `.opencode/agents/` | **No, preexistente**: hay 13 archivos `sdd-mr-v1-*.md` reales de uso previo (gitignoreados) y el test asume el directorio vacío. |

---

## 5. Cambios de código ya aplicados (working tree, sin commitear)

- `src/infrastructure/opencode/disk-agent-generator.ts` —
  `HARD_MAX_ROUTES` 16 → **24**, con la fórmula explícita en el comentario
  de cabecera (~20 modelos conectados, un host por modelo, más holgura) en
  vez de un número sin razón, que fue el problema del 16 original.
  `FLEET_DEFAULT_CAP` sin tocar en 8.
- `tests/model-route-disk-generator.test.ts` — tests al nuevo tope (17 y 24
  aceptados con `sizeException`; 25 rechazado outright aun con excepción).

Hecho con TDD estricto (RED verificado antes de GREEN).
Suite: `test:fleet-regeneration` verde, `build` verde,
`test:typecheck:strict` limpio. `test:model-routes` falla en
`model-route-cli.test.ts` por la razón preexistente de arriba.

---

## 6. Deuda derivada a otros lugares

No son bloqueantes de este diseño, pero salieron de esta investigación:

1. **`riesgos.md` en `memory-context`** — 11 riesgos de PMC para consumo
   programático no supervisado (3 altos / 5 medios / 3 bajos), para que ese
   equipo los trabaje de su lado.
2. **Bug del `sizeException`** (este repo) — la exigencia de excepción está
   anidada bajo `routes.length > declaredCap`, así que declarar un `cap`
   alto la saltea por completo. Confirmado leyendo el código. Decisión de
   producto pendiente: ¿declarar un cap debería contar *como* la excepción?
3. **Hueco de `foreign-agent-scan.ts`** (este repo) — `checkName` solo
   corre su lógica de ownership para archivos cuyo nombre resuelto ya
   empieza con el prefijo reservado (`foreign-agent-scan.ts:51` gatea todo
   el body), y para esos early-returna sobre `ownership:
   "workspace-owned-candidate"` (`foreign-agent-scan.ts:66-68`) — que es
   como se sourcea el dir `.opencode/agent(s)/` del workspace
   (`foreign-agent-sources.ts:43-44`). Así que *cualquier archivo que use
   el prefijo reservado* en ese dir escapa al reporte como
   `foreign-reserved-definition` (solo se chequea si también está en
   `ownedMap`, lo cual un shadow file no está). Archivos sin el prefijo
   nunca iban a ser reportados de todas formas, así que el early-return no
   ensancha el vector para ellos — pero traga silenciosamente justo el caso
   de shadow-file (nombre con prefijo) que el detector existe para atrapar.
   (Una descripción anterior de este item decía que el agujero era que el
   sweep matchea por filename y un shadow file con prefijo en el frontmatter
   escapaba — corregido por la cuarta pasada: el detector SÍ lee frontmatter.
   Una segunda imprecisión posterior — "cualquier archivo sin importar
   nombre" — fue atrapada por la quinta pasada/validador externo y
   acotada a "archivos con prefijo".) Hoy inocuo; era el diseño de tiers
   el que lo volvía explotable, y ese diseño se descartó.

---

## 7. Estado de validación

El diseño pasó por **cuatro pasadas adversariales independientes**, cada una
con contexto fresco y verificando contra el código real:

1. **Primera** — invalidó la §7 original (tiers vía `tools` grants):
   inimplementable sin tocar todo el pipeline que decía dejar intacto, y
   reventaba el cap.
2. **Segunda** — validó el rediseño de §7 sobre `baseTemplate` +
   `permission` en lo estructural, pero encontró que la premisa de
   enforcement estaba contradicha por evidencia que ya existía en el repo.
   Eso motivó el spike.
3. **Tercera** (documento completo) — encontró que el abandono de §7 había
   sido una cirugía parcial, que el guardrail de reemplazo era
   inexigible y ciego, y varios huecos de esquema. Todo corregido.
4. **Cuarta** (independiente, sobre el documento como conjunto y no solo
   consistencia) — verificó 22 de 23 afirmaciones sobre el código como
   exactas. La que falló: la descripción del vector foreign-agent citaba
   el mecanismo equivocado. Encontró además dos garantías que se apoyaban
   en prosa del orquestador cuando el principio del documento dice que
   las garantías viven en código: la serialización del dispatch (§9.12,
   que usaba "dispatch is serialized" como premisa para minimizar un
   riesgo) y el flag `mutating` por fase (nunca declarado, dejaba a
   `sdd-verify` — que ejecuta tests — en estado indefinido). Las tres
   corregidas en revisión 6 del diseño.

Cada pasada encontró cosas que las anteriores no. La afirmación de la
tercera ("toda afirmación del documento sobre el código es exacta") resultó
falsa en un punto — el vector foreign-agent — y la cuarta pasada lo
atrapó. Eso es la lección: una afirmación de completitud verificada por
una pasada no sobrevive a la siguiente, y no debería presentarse como
cerrada.

## 8. Errores adicionales de la cuarta pasada (corregidos)

Se registran por la misma razón que §3: el diseño se apoyó en ellos hasta
la corrección.

12. **Describí el vector foreign-agent con el mecanismo equivocado.**
    Afirmé que el agujero era que "el sweep matchea por filename", así que
    un shadow file con prefijo en el frontmatter pero no en el filename
    escapaba. Falso para `scanForForeignAgentDefinitions`: esa función SÍ
    lee el frontmatter `name`. El vector real es el early-return de
    `workspace-owned-candidate`, que asume que todo el dir del workspace
    es owned sin mirar nombre ni frontmatter. Un implementador que leyera
    la descripción original habría arreglado la cosa equivocada.
13. **Usé "dispatch is serialized" como premisa para minimizar un riesgo
    de concurrencia (§9.12).** Era una expectativa sobre el orquestador
    (un LLM), no un mecanismo — exactamente el patrón que §7.2 recién
    había corregido dos secciones antes. La serialización ahora es
    estructural: `inFlightPhase` en `sdd_status`, adquirido por
    `sdd_compose_phase_prompt`, liberado por `sdd_save_artifact`.
14. **Nunca declaré el flag `mutating` por fase.** Quedaba implícito, lo
    que dejaba a `sdd-verify` (que ejecuta tests reales y por ende escribe
    al worktree) sin una clasificación clara. Ahora hay tabla explícita en
    §7.2; verify es `mutating: true`, y la protección que pierde (el
    fingerprint no detecta un verify que edita código) está declarada
    honestamente, cubierta por el Gatekeeper en su lugar.

## 9. Qué falta antes de implementar

Nada abierto: los 15 open items quedaron resueltos en §9 del diseño, cada
uno con su justificación. Cuatro eran juicios con tradeoffs reales (tope de
tamaño, cold start, modelo del validador, política de degradación) y fueron
aprobados explícitamente por el usuario.

La cuarta pasada validó la arquitectura como conjunto (no solo
consistencia) y sus tres hallazgos están corregidos en revisión 6. El
siguiente paso natural es `writing-plans` para el desglose de
implementación.
