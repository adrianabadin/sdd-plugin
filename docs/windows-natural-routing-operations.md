# Windows Natural Model Routing Operations

This guide covers the Rev 2 operator workflow for deterministic model
routing. The full stack is `routes.json` + the pre-start generator +
the dispatch hook. There is **no supervisor**, **no attestation**, **no
boot identity**, and **no signing key**; routing works in a plain
OpenCode session that knows nothing about the routing infrastructure.

## Prerequisites

- Any OpenCode version that supports the `subagent_type` dispatch and
  the `task` tool. The plugin does not pin an OpenCode version.
- A project workspace containing `.opencode/`.
- A configured `config/model-routing/routes.json` whitelist.

Generate the owned route descriptors from the repository root:

```powershell
npm run generate:model-routes -- $workspaceRoot config/model-routing/routes.json
```

The generator writes only under `$workspaceRoot/.opencode/`. Each
route in `routes.json` produces a base agent (`.opencode/agents/sdd-mr-v1-<hash>.md`)
plus, for each normalized effort level the model exposes, a suffixed
agent (`.opencode/agents/sdd-mr-v1-<hash>-{low,medium,high}.md`) and a
single canary command. The `cap` in `routes.json` counts routes, not
files.

## Dispatch

Two equivalent ways to route a `task` call:

- **Explicit grammar**: `subagent_type = "model-route:v1|sdd-mr-base|<provider>/<model>"`
  optionally with a 4th segment for effort, e.g.
  `"model-route:v1|sdd-mr-base|openai/gpt-5.6|high"`.
- **Natural intent** in the prompt: any of the four bounded triggers
  (`usando <ref>`, `con el modelo <ref>`, `using model <ref>`,
  `@model <ref>`) followed by a model reference, optionally with an
  effort phrase (`esfuerzo <low|medium|high>`,
  `con esfuerzo <low|medium|high>`, or `effort <low|medium|high>`).

Examples:

```text
subagent_type = "model-route:v1|sdd-mr-base|anthropic/claude-opus-5"
# routes to sdd-mr-v1-<hash>-low (default)

subagent_type = "model-route:v1|sdd-mr-base|openai/gpt-5.6|high"
# routes to sdd-mr-v1-<hash>-high (explicit effort)

prompt = "usando openai/gpt-5.6 con esfuerzo high"
# same routing via natural language
```

## Effort selection

The dispatcher normalizes the requested effort against the
`variants.json` snapshot the generator wrote next to the manifest:

- Model exposes the requested level → routes to the suffixed agent.
- Model has variants but does not expose the requested level → routes
  to the nearest available level, audit records
  `effortFallbackReason: "LEVEL_NOT_EXPOSED"`.
- Model exposes no variants at all → routes to the base agent, a
  warning is logged, audit records
  `effortFallbackReason: "MODEL_HAS_NO_VARIANTS"`.

Neither case blocks dispatch. The audit log is the authoritative
trace; the warning is visible in the OpenCode session output.

## Error contract

| Code | When |
|---|---|
| `ROUTE_NOT_WHITELISTED` | The canonical model is not in `routes.json`. |
| `QUARANTINED_MODEL` | An active quarantine (any level) blocks the route. |
| `ROUTED_AGENT_UNAVAILABLE` | The route is whitelisted, but the target `.md` is missing on disk. |
| `EFFORT_LEVEL_UNKNOWN` | The natural parser extracted an effort word that is not `low\|medium\|high`. |
| `RouteUnknownError` / `RouteAmbiguousError` | The resolver could not narrow to exactly one whitelisted entry. |

The audit is best-effort: a sink failure logs and the dispatch still
rewrites `subagent_type`. No natural trigger + no grammar trigger
is a byte-for-byte legacy passthrough (no rewrites, no audit).

## Quarantine at generation time

The pre-start generator only excludes routes with **permanent**
quarantines. TTL quarantines are still included at generation; the
dispatcher enforces them at hook time. To exclude a route permanently
until a human intervenes, set the quarantine with `type: "permanent"`.
