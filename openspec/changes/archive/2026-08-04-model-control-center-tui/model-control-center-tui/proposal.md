# Proposal: Model Control Center TUI

> Reconstructed post-delivery (2026-08-04) from apply-progress, verify-report, task designs, and source. No product code changed.

## Intent

Model/provider configuration was code/CLI-only. Users need an interactive OpenCode TUI to browse connected models, edit model metadata, and quarantine providers/models — edits apply live and survive restarts, backed by the existing SQLite DB.

## Scope

### In Scope
- TUI entry: `alt+shift+m` keymap → `model-control-center.open` → native host dialog (supersedes original route/mode design).
- Main menu + pure-reducer navigation state machine (screen stack, Esc/pop).
- Providers screen; models list with `/` search (read-only `ModelCatalogPort`).
- Model-detail tabbed form: draft editing, per-field validation, Ctrl+S save.
- Durable persistence: `SaveModelDetailUseCase`, versioned JSON metadata envelope, envelope-hash optimistic guard, pricing history, additive nullable-column migration.
- Live runtime application: `Symbol.for` globalThis registries (`model-config-registry.v1`, `quarantine-store.v1`), DB read-through hydration in bootstrap interception.
- Quarantine management: provider/model/modelProvider levels, TTL/permanent, precedence `provider > model > modelProvider`, use cases, Quarantines screen, interception gate.
- Release safety: package exports (root, `./tui`), Bun/OpenTUI renderer CI gate, DB-path isolation, staged-artifact gate.

### Out of Scope
- Write-back to OpenCode SDK config (one-way DB→runtime).
- Automatic quarantine triggers; catalog refresh triggers.
- Browser E2E, linter/coverage tooling.

## Capabilities

### New Capabilities
- `model-control-center-tui`: TUI for browsing, editing, persisting, live-applying model metadata, plus quarantine management with interception gating.

### Modified Capabilities
- None (only unrelated `foreign-agent-provenance-guard-spec.md` exists in `openspec/specs/`).

## Approach

Hexagonal layering: pure domain/view reducers; detail and quarantine ports; Prisma transactions; thin SolidJS screens over a pure `transition()` reducer. SQLite is source of truth; globalThis registries are write-through caches with DB rehydration fallback. Strict TDD per `openspec/config.yaml`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/tui.ts`, `src/tui/*` | New/Modified | Dialog, screens, navigation, views |
| `src/application/{save-model-detail,quarantine}` | New | Use cases |
| `src/ports/*` | New | Detail + quarantine ports |
| `src/infrastructure/{prisma,runtime}` | Modified/New | Adapter, registries, DB path |
| `src/bootstrap/index.ts` | Modified | Registry-first interception, quarantine gate |
| `prisma/`, `package.json`, `.gitignore`, `ci.yml` | Modified | Nullable columns, exports, gates |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Future host binds `alt+shift+m` | Low | Release-notes check per upgrade |
| Cross-bundle registry drift | Med | `Symbol.for` + DB read-through |
| Stale concurrent saves | Low | Envelope-hash guard |
| Staged DB/dist artifacts | Low | `verify-release-safety` CI gate |

## Rollback Plan

Revert change commits; `prisma migrate resolve --rolled-back` + `prisma migrate deploy` (columns nullable; rows preserved). Per-task commits enable granular revert.

## Dependencies

OpenCode `>= 1.17.11`; Bun via `oven-sh/setup-bun@v2` in CI; existing Prisma/SQLite.

## Success Criteria

- [x] All gates green: build, `npm test`, integration, exports, strict typecheck, `test:tui:bun`, release-safety (verify-report 2026-08-04).
- [x] Edits persist and rehydrate without restart; quarantine blocks/releases at correct scope.
- [x] No host keymap collision (`ctrl+alt+f` guard).

## Proposal question round

Assumptions needing user review (reconstructed post-delivery):

1. **Presentation**: implementation uses a host **dialog**, superseding Task 2's route/mode design — confirm dialog as canonical?
2. **Capability granularity**: one capability vs splitting browsing/editing/quarantine into three delta specs?
3. **Boundary**: one-way DB→runtime (no OpenCode config write-back) — permanent or deferred?
4. **Shortcut**: `alt+shift+m` permanent; per-upgrade release-notes check acceptable?
5. **Pricing history**: each save appends a pricing row — unbounded growth OK, or schedule pruning?
