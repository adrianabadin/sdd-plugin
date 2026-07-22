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

> **Configuration Notice**: OpenCode resolves TUI modules from package specifications declared in `tui.json` (or under the host TUI plugin configuration section), NOT by listing `"sdd-plugin2/tui"` directly in `opencode.json` `plugin: [...]`. Main server plugins operate in non-DOM/headless background node runtimes and lack `@opentui/*` UI primitives.
> When the host encounters a package specifier in `tui.json` (such as `"sdd-plugin2"` or `"/absolute/path/to/sdd-plugin2"`), it resolves the package's `package.json` `exports["./tui"]` mapping (`./dist/tui.js`) to load `{ id, tui }`.

### Correct TUI Configuration (`tui.json` or TUI plugin config):
```json
{
  "plugin": ["sdd-plugin2"]
}
```
*Note: Specifying `"sdd-plugin2"` in `tui.json` causes OpenCode host resolution to check `package.json` `exports["./tui"]` and load the `{ id, tui }` module.*

### Activation Contract:
- **Module export**: `sdd-plugin2` via `package.json` `exports["./tui"]` exports a TUI plugin module matching `{ id: "sdd-plugin.tui", tui: (api) => ... }`.
- **Keymap shortcut**: Press `alt+shift+m` in `base` mode. This triggers the command `model-control-center.open` registered via `api.keymap.registerLayer`, navigating to the `model-control-center` route. The mnemonic is "**M**odel" and was chosen because the host keymap in OpenCode 1.18.4 already binds `ctrl+alt+f` to the built-in `messages_page_down` command — re-introducing `ctrl+alt+f` would silently swallow the keypress without warning.
- **Route rendering**: The route is registered with `api.route.register`. When entered, it pushes a route-specific mode (`model-control-center`) via `api.mode.push` and renders the Solid interface (`DialogAlert` placeholder component).
- **Teardown & Cleanup**: Leaving the route invokes Solid `onCleanup` which pops the mode. Unloading the plugin disposes keymap and route registrations via `api.lifecycle.onDispose`.
- **Peer / UI dependencies**: Compatible with `@opentui/solid`, `@opentui/core`, and `@opentui/keymap` (`^0.4.5`).

### TUI Validation & Testing Commands:
- **Node.js Host Contract & Lifecycle Test**: `npm run test:tui`
  Validates keymap registration, `alt+shift+m` binding, command execution route navigation, route mode push/pop (`onCleanup`), and host component props contract. The test also asserts the legacy `ctrl+alt+f` binding is absent (host collision guard).
- **Bun OpenTUI Real Renderer Test**: `npm run test:tui:bun` (or `bun tests/tui-bun-renderer.test.ts`)
  Invokes `@opentui/solid` `testRender` against the Solid/OpenTUI route component. OpenCode executes plugins under Bun; this test requires the Bun runtime (with native FFI) and fails with an explicit error under Node.js.

## Release Safety (Task 7)

The CI pipeline enforces release safety before any artifact is shipped:

1. **Forbidden staged artifacts** — `.gitignore` and the CI gate `npm run verify:release-safety` ensure that `.env` files, `opencode-models.db` (production DB), `dist/`, `node_modules/`, generated Prisma client, and incremental build state are never staged for commit.
2. **Test database isolation** — every integration test writes to a unique `opencode-models.test-<uuid>.db` path via the shared `resolveDatabasePath()` resolver; production DBs are never touched.
3. **Bun release gate** — `npm run test:tui:bun` runs only on Bun (the runtime OpenCode uses in production). The Node suite `npm test` is split from the Bun gate so a Bun-less local environment cannot falsely claim renderer coverage.
4. **End-to-end integration suite** — `npm run test:integration` covers model edit immediate application, quarantine set/release interception, publish-failure resilience, route open/close cleanup, `alt+shift+m` binding (formerly `ctrl+alt+f`; corrected after the OpenCode 1.18.4 host collision was confirmed) and a guard that the legacy `ctrl+alt+f` binding is absent, public exports after build, and staged-artifact protection.
5. **Migration safety** — the committed Prisma migration only adds nullable columns (`metadata`, `metadataEnvelopeHash`, `quarantineType`, `quarantineUntil`); rollback is `prisma migrate resolve --rolled-back` followed by `prisma migrate deploy`. Existing rows are preserved because every new column is nullable.

### CI gate commands

```bash
npm run verify:release-safety   # gate 1: no forbidden artifacts staged
npm run build                   # gate 2: TypeScript build succeeds
npm test                        # gate 3: Node test suite + integration
npm run test:exports            # gate 4: public root + ./tui self-references
npm run test:typecheck:strict   # gate 5: tests compile with strict checks
npm run test:tui:bun            # gate 6 (Bun-only): native OpenTUI renderer
```

A change MUST pass all six gates before it can be merged. Gates 1, 4, 5, 6
are non-negotiable. Gates 2 and 3 are split so a Bun-less contributor can
still run unit and integration tests locally.

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
