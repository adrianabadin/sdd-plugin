## Similar-project reference

When a problem is unclear or cannot be resolved confidently from this repository, consult the related implementation at:

`C:\Users\aabad\Documents\CODE\ia\subagentsplugin`

Use PMC/Engram context first when available, then inspect the corresponding source and tests in that repository. Treat it as a reference implementation, not an authority: verify differences in OpenCode SDK versions, runtime contracts, and project requirements before copying a pattern.

For model-refresh behavior specifically, compare against `src/plugin.ts` and `src/models.ts` there. The reference implementation uses best-effort, deduplicated background refreshes, preserves the OpenCode SDK method binding with `list.call(provider)`, extracts providers from `result.data.all` / `result.data.providers` / arrays, and walks nested `provider.models` entries.

<!-- pmc:autostart -->
## PMC Session Autostart

Session initialization is handled automatically by the `pmc session-start` hook
(installed by `pmc setup`). The hook runs **outside the model context window**, costs zero
tokens, and injects a compact status + project context summary.

**If your harness does NOT have a SessionStart hook configured**, run this once per session:

```bash
pmc session-start .
```

This command handles everything deterministic in one shot:
- Checks enrichment status; launches background enrich + watchdog if needed
- Reports pending sync operations (run `/sync-context` to apply manually)
- Loads project context from materialized disk artifacts (no MCP round-trip)
- Reports if LLM subagent drain is needed

**If the session summary reports `subagentQueue.pending > 0`**, dispatch the `enrich` subagent
to drain those entries — that is the only step that requires LLM involvement.

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `pmc get-context <file-or-symbol>` FIRST. Do NOT open files without first checking PMC context.
- **AFTER implementing code changes**: Run `pmc refresh-context --enrich` (refreshes graph incrementally, queues and launches enrichment; background sync will auto-spawn automatically).
- **Default context depth**: Always use `depth=compact`. Use `extended` or `deep` ONLY when explicitly asked.
- **`map-project --all`** is only needed for full reinstall or ground-up graph rebuild. Day-to-day, `refresh-context` keeps everything current.

## Generación de Agentes Ruteados (Model Routing)

Para habilitar e interceptar modelos por alias (como `"laguna s 2.1"`, `"laguna"` o `"gemini flash 3.6 tiered"`) o mediante la gramática explícita `model-route:v1|...`, ejecutá la generación manual de agentes:

```bash
npm run generate:model-routes
```

O usá el supervisor de ruteo para mantener los agentes y la atestación sincronizados:

```bash
npx tsx src/cli/model-route-boot.ts start .
```

### Convención de dispatch — determinismo por prompt (OBLIGATORIO)

El modelo de un subagente lo decide **el plugin**, nunca el default del agente
pelado. Dos vías, usadas en combo:

1. **Path A — grammar como `subagent_type`** (obligatorio al despachar fases
   SDD): `model-route:v1|sdd-mr-base|<modelReference>`. Es exactamente el
   `subagentType` que devuelve `sdd_compose_phase_prompt`; despachar con él y
   NO con el nombre del agente pelado (`sdd-explore`, `sdd-apply`, ...). El
   resolver elige el host ruteado; nunca hace falta conocer los hashes.
2. **Path B — trigger natural en el prompt** (red de seguridad para dispatches
   ad-hoc): `usando <modelo>`, `con el modelo <modelo>`, `using model <modelo>`
   o `@model <modelo>`. El hook lo captura aunque el `subagent_type` sea el
   agente pelado.

Sin grammar y sin trigger → legacy passthrough: el agente corre con su modelo
configurado (NO determinista). Con el supervisor activo, verificar siempre en
`.opencode/sdd-model-routing/routing.audit.jsonl` qué modelo se ruteó.

Referencias: `src/infrastructure/opencode/model-route-task-hook.ts` (Path A: L187,
Path B: L196), `src/domain/model-routing/natural-model-intent.ts` (triggers),
`src/application/sdd/entry-flow.ts` (grammar default).

## Context Retrieval Rules

| Situation | Command | Depth |
|-----------|---------|-------|
| About to read a file | `pmc get-context <file>` | compact |
| Working on a specific symbol | `pmc get-context <symbol>` | compact |
| Need dependency information | `pmc get-context <symbol> extended dependencies` | extended |
| Debugging complex issues | `pmc get-context <symbol> deep all` | deep |
| Need raw source code | `pmc get-context <symbol> disk` | disk |
| Quick project overview | `agent-memory_search "project context overview"` | — |
| After code changes | `pmc refresh-context --enrich` (background sync auto-spawns) | — |

## Memory Protocol — Deterministic Triggers

The complete deterministic Memory Protocol — including the plugin-active exception, the 7-event save triggers, the local/global search table, the post-compaction recovery, the global error tracking rules, the topic-key/alias flow, and the memory-lifecycle rules — lives in **`pmc-skill`**. Load the skill before the first memory/session call; it owns the tool names and triggers.

- **Skill location** (this project): `.agents/skills/pmc-skill/SKILL.md`
- **Skill location** (global config): `~/.config/opencode/skills/pmc-skill/SKILL.md` (OpenCode) / `~/.claude/skills/pmc-skill/SKILL.md` (Claude Code)
<!-- /pmc:autostart -->
