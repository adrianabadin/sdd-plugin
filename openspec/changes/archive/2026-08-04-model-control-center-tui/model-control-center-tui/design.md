# Design: Model Control Center TUI

## Technical Approach

The delivered change uses hexagonal boundaries around a host-native OpenCode dialog. `src/tui.ts` composes catalog, persistence, save, and quarantine dependencies, while `src/tui/ModelControlCenter.tsx` owns Solid signals and delegates navigation to pure reducers and view helpers. SQLite is authoritative; process-wide `Symbol.for` registries are verified runtime projections with database read-through recovery. This implements the proposal and all requirements in `specs/model-control-center-tui/spec.md`.

## Architecture Decisions

| Option | Tradeoff | Decision |
|---|---|---|
| Host route plus custom mode (Task 2) | Replaces host context and duplicates modal ownership | **Superseded.** The canonical implementation calls `api.ui.dialog.replace`, registers no route, pushes no custom mode, and lets the host own the modal surface. The intermediate Task 2 note predated the approved native-dialog migration; current source and `tui-registration`, `integration-route-cleanup`, and Bun renderer tests are decisive. |
| Modeless keymaps | Requires explicit priority/lifetime management | Use base priority 100 only for `alt+shift+m`; each mounted control center owns a modeless priority-200 layer, with priority 300 only while editing/overlay capture is active. This avoids host mode conflicts and disposes bindings with the Solid root. |
| Imperative screen chaining | Would duplicate back/tab/search behavior | Preserve one `ScreenState[]` stack and pure `handleNavigation()` reducer. Thin plain-JSX screens avoid host alert primitives that capture Enter/Escape. |
| Publish before persistence | Faster but can expose uncommitted state | Validate, transact, independently read back, then publish only a verified result. Durable state survives registry loss or publication failure. |
| Typed columns for every evolving field | Stronger DB constraints but repeated migrations | Store sparse provider/model fields in versioned JSON envelopes, guard manual saves with a canonical hash, and keep pricing as temporal rows. Quarantine remains typed by domain unions and nullable scope columns. |

## Data Flow

```text
alt+shift+m -> base command -> dialog.replace -> owned createRoot
  -> ModelControlCenter -> ScreenState reducer -> active plain-JSX screen

catalog: OpenCodeModelCatalogAdapter -> ModelCatalogPort -> pure grouping/filtering
save: draft -> domain validation -> Prisma transaction -> independent readback
      -> verified ModelConfigRegistry publish -> bootstrap interception
quarantine: overlay -> use case -> Prisma transaction -> verifier
            -> QuarantineStore -> bootstrap block/release decision
registry/store missing -> SQLite query -> hydrate/reconcile -> continue decision
```

Per-open `DialogHandle` identity guards and idempotent scopes prevent delayed `onClose` callbacks from disposing a newer dialog.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/tui.ts` | Modify | Native dialog composition, shortcut, per-open lifecycle, awaitable shutdown |
| `src/tui/ModelControlCenter.tsx` | Create | Reactive controller, modeless keymaps, save/quarantine orchestration |
| `src/tui/MainMenu.tsx`, `src/tui/ProvidersScreen.tsx`, `src/tui/ModelsScreen.tsx`, `src/tui/ModelDetailScreen.tsx`, `src/tui/QuarantinesScreen.tsx` | Create | Plain host-rendered screens |
| `src/tui/navigation.ts`, `src/tui/catalog-view.ts`, `src/tui/model-detail-view.ts`, `src/tui/model-detail-field-edit.ts`, `src/tui/quarantine-overlay.ts` | Create | Pure state, view, draft, and input logic |
| `src/ports/model-catalog.port.ts`, `src/ports/model-detail-query.port.ts`, `src/ports/model-detail-write.port.ts`, `src/ports/quarantine-write.port.ts` | Create/Modify | Hexagonal contracts |
| `src/application/save-model-detail/save-model-detail.use-case.ts`, `src/application/quarantine/` | Create | Validation, verified persistence, runtime projection |
| `src/infrastructure/prisma/prisma-model-repository.adapter.ts` | Modify | Atomic detail/pricing and quarantine persistence/query |
| `src/infrastructure/runtime/persistence-context.ts`, `src/infrastructure/runtime/model-config-registry.ts`, `src/infrastructure/runtime/quarantine-store.ts` | Create | Dual-client persistence lifecycle and cross-bundle caches |
| `src/bootstrap/index.ts` | Modify | DB read-through and quarantine interception gate |
| `prisma/schema.prisma`, `prisma/migrations/20260721000000_init/migration.sql`, `prisma/migrations/20260727000000_add_quarantine_reason/migration.sql` | Modify/Create | Nullable metadata/hash/quarantine fields |

## Interfaces / Contracts

- `ModelControlCenterProps` injects API, ports/use cases, persistence failure reason, and `onClose` into the detached root.
- `ModelDetailWritePort.saveModelDetail()` returns `{updatedAt, envelopeHash}`; `SaveModelDetailResult` is `verified | committed-unverified`.
- `ModelConfigRegistry` exposes `publish/get/subscribe`; `QuarantineStore` exposes `hydrate/reconcile/publish/release/isActive/snapshot`.
- Quarantine precedence is `provider > model > modelProvider`; TTL is active only while `now < until`.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | Reducers, catalog/detail helpers, validation, TTL/precedence | `tests/tui-navigation.test.ts`, `tests/use-case-save-model-detail.test.ts`, `tests/domain-quarantine.test.ts` |
| Integration | Prisma transactions, readback, hydration, interception, lifecycle | `tests/integration-model-edit-flow.test.ts`, `tests/integration-quarantine-interception.test.ts`, `tests/integration-route-cleanup.test.ts` |
| Native/E2E | Reactive dialog frames and overlays | Bun/OpenTUI: `tests/tui-bun-renderer.test.ts`, `tests/tui-save-outcome.test.ts`, quarantine/subscription Bun tests |
| Release | Exports, isolated DBs, forbidden artifacts | `tests/integration-package-exports.test.ts`, `tests/integration-release-safety.test.ts`; run `npm test`, `npm run build`, `npm run test:tui:bun` |

## Migration / Rollout

No migration is required by this reconstruction. The delivered rollout uses additive nullable SQLite columns and CI gates. Roll back by reverting feature commits, then use Prisma migration resolve/deploy guidance; existing rows remain valid.

## Open Questions

None blocking. Native dialog/modeless presentation is canonical. Future host shortcut collisions and pricing-history retention are non-blocking release/product follow-ups.
