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

## OpenCode TUI Integration (`sdd-plugin2/tui`)

The `./tui` subpath export provides the OpenCode Model Control Center TUI module (`{ id: "sdd-plugin.tui", tui }`).

> **Configuration Notice**: OpenCode requires TUI modules to be declared in `tui.json` (or under the TUI plugin configuration section), NOT in the main server plugin list (`opencode.json` `plugin: [...]`). Main server plugins operate in non-DOM/headless background node runtimes and lack `@opentui/*` UI primitives.

### Correct TUI Configuration (`tui.json` or TUI plugin config):
```json
{
  "plugin": ["sdd-plugin2/tui"]
}
```

### Activation Contract:
- **Module export**: `sdd-plugin2/tui` exports a TUI plugin module matching `{ id: "sdd-plugin.tui", tui: (api) => ... }`.
- **Keymap shortcut**: Press `ctrl+alt+f` in `base` mode. This triggers the command `model-control-center.open` registered via `api.keymap.registerLayer`, navigating to the `model-control-center` route.
- **Route rendering**: The route is registered with `api.route.register`. When entered, it pushes a route-specific mode (`model-control-center`) via `api.mode.push` and renders the Solid interface (`DialogAlert` placeholder component).
- **Teardown & Cleanup**: Leaving the route invokes Solid `onCleanup` which pops the mode. Unloading the plugin disposes keymap and route registrations via `api.lifecycle.onDispose`.
- **Peer / UI dependencies**: Compatible with `@opentui/solid`, `@opentui/core`, and `@opentui/keymap` (`^0.4.5`).

### TUI Validation & Testing Commands:
- **Node.js Host Contract & Lifecycle Test**: `npm run test:tui`
  Validates keymap registration, `ctrl+alt+f` binding, command execution route navigation, route mode push/pop (`onCleanup`), and host component props contract.
- **Bun OpenTUI Real Renderer Test**: `npm run test:tui:bun` (or `bun tests/tui-bun-renderer.test.ts`)
  Invokes `@opentui/solid` `testRender` against the Solid/OpenTUI route component. OpenCode executes plugins under Bun; this test requires the Bun runtime (with native FFI) and fails with an explicit error under Node.js.

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
