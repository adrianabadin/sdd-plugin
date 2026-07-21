<!-- pmc:generic -->
# PMC Setup Guide

This project uses PMC (Project Memory Context) for persistent structured memory.

## Quick Start

```bash
# Bootstrap the project (graphify + worklist + base memories)
pmc map-project --all --enrich

# Check enrichment status
pmc enrich-status

# Run semantic enrichment for pending symbols (non-blocking)
pmc enrich . --background

# Refresh project context memories
pmc get-context --refresh

# Sanitize (re-run graphify, mark stale entries)
pmc sanitize

# Sync pending PMC updates into agent-memory (optional manual trigger)
pmc sync-context
```

## How It Works

1. **Map Project** runs `graphify` to map your codebase structure, extracts symbols, and creates an enrichment worklist.
2. **Enrich** processes each symbol through a semantic enrichment pipeline (local model -> cloud API -> agent subagent fallback chain).
3. **Sync** pushes enriched memories to `agent-memory-mcp` for persistent retrieval (done automatically in the background after refresh/enrich, or manually via `pmc sync-context`).
4. **Context** materializes 9 base project-context memories (stack, architecture, dependencies, etc.).

## Files

- `.planning/project-memory-context/` — all PMC data lives here
- `.planning/project-memory-context/enrichment/worklist.json` — symbol enrichment queue
- `.planning/project-memory-context/enrichment/sync-manifest.json` — pending agent-memory upserts
- `.planning/project-memory-context/graph/` — graphify output

## Requirements

- Node.js >= 18
- Python + `graphifyy` (`pip install graphifyy`)
- `npx -y @aabadin/agent-memory-mcp` (optional, for persistent memory)

## CLI Reference

```
pmc init-project [--agent opencode|claude-code|cursor|generic]
pmc map-project [dir] [--all] [--enrich]
pmc enrich [dir] [--concurrency N]
pmc get-context [<target>] [depth] [focus]
pmc get-context --refresh
pmc sanitize
pmc enrich-status
pmc sync-context
```
<!-- /pmc:generic -->
