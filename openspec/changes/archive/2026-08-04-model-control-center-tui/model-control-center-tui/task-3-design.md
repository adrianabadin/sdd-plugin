# Task 3 Design: Connected Providers & Model Browsing

**Change**: model-control-center-tui | **Scope**: read-only browsing only | **Base**: Task 2 route/state machine (commit 5bd339d, unchanged host contract)

## Technical Approach

Extend the Task 2 discriminated-union state machine so `providers` and `models` render real content sourced from the existing `ModelCatalogPort` (`OpenCodeModelCatalogAdapter` → `client.config.providers()`). The TUI composition root builds the adapter from `api.client` (present on `TuiPluginApi`, tui.d.ts:492) and injects the port as a prop — no Prisma, no persistence, no new discovery path. All grouping/sorting/filtering lives in a pure module; screens stay thin Solid components with the same DialogAlert test fallback as `MainMenu`.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Data source | Reuse `ModelCatalogPort` via `OpenCodeModelCatalogAdapter(api.client)` | Prisma repository; global provider discovery | Read-only, single source of truth (`config.providers`); repository writes belong to the sync use case, not browsing |
| Loading model | One catalog fetch per route mount, cached in a root signal; screens derive views | Fetch per screen entry; refetch on every navigation | One round-trip, deterministic snapshot, trivially testable; staleness accepted (refresh is Task 1's background coordinator's job) |
| View derivation | Pure functions `buildProviderSummaries(rows)` / `filterModels(rows, query)` in `catalog-view.ts` | Logic inside components | Matches project hexagonal style; Given/When/Then tests need no renderer |
| Sorting | Providers by `providerId` ascending (code-unit); models by `modelName.toLowerCase()` ascending, tie-break `modelId` | SDK order; localeCompare | SDK order is unspecified; code-unit compare is deterministic across environments |
| Search input | `/` enters search mode on `models`; OpenTUI `input` onInput dispatches `search-input(text)`; Esc exits search mode **keeping** query | Keymap per-character capture; clear-on-Esc | Keymap layer stays command-only; keeping the query is non-destructive and reversible |
| Error semantics | Port rejection → error panel; resolved `[]` (unavailable/malformed catalog) → empty state | Treat both as error | Existing adapter contract already swallows malformed payloads into `[]` (traced); design follows it, no adapter change |

## Screen State Extension (navigation.ts)

```ts
| { name: "providers"; selectedIndex: number }
| { name: "models"; providerId: string; selectedIndex: number; query: string; searchActive: boolean }
```

New events: `search-start`, `search-stop`, `search-input(text)`. `activate` on `providers` pushes `models` for the selected provider; on `models` pushes the existing `model-detail` placeholder (content owned by Task 4). `back` on `models` with `searchActive` emits `search-stop` instead of popping.

## Keyboard

| Key | Screen | Behavior |
|---|---|---|
| up/down | providers, models | Move selection cyclic over visible rows |
| enter | providers | Push `models(providerId)` |
| enter | models | Push `model-detail` placeholder |
| `/` | models only | Enter search mode (no-op elsewhere) |
| esc | models + searchActive | Exit search mode, keep query |
| esc | otherwise | Pop stack (Task 2 contract) |

## Data Flow

```
route mount → catalog.getConnectedModels() → root signal CatalogView
providers screen: buildProviderSummaries(rows) → sorted list + counts
models screen: rows.filter(providerId) → filterModels(query) → sorted list
key/input event → dispatch(event) → pure transition → signal → re-render
```

`CatalogView = {status:"loading"} | {status:"error";message} | {status:"ready";providers;modelsByProvider}`.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/tui/catalog-view.ts` | Create | Pure `buildProviderSummaries`, `filterModels`, `CatalogView` type |
| `src/tui/navigation.ts` | Modify | Extend screen union, add search events/transitions |
| `src/tui/ProvidersScreen.tsx` | Create | Provider list + counts, loading/empty/error render |
| `src/tui/ModelsScreen.tsx` | Create | Model list, search input, empty/loading/error render |
| `src/tui/ModelControlCenter.tsx` | Modify | Accept `catalog: ModelCatalogPort` prop, load on mount, wire new screens |
| `src/tui.ts` | Modify | Build `OpenCodeModelCatalogAdapter(api.client)` and pass to root |
| `tests/tui-catalog-view.test.ts` | Create | Pure derivation tests (tsx assertion-script convention) |
| `tests/tui-navigation.test.ts` | Modify | New reducer/search/Esc scenarios |

## Test-First Scenarios

- **Given** catalog rows for providers `beta`,`alpha`, **when** summaries build, **then** order is `alpha`,`beta` with correct model counts; providers with zero models never appear (no rows emitted by port).
- **Given** unsorted model rows, **when** the models screen derives its list, **then** output is `modelName` lowercase ascending with `modelId` tie-break — identical across runs.
- **Given** query `gpt`, **when** `search-input("GPT")` dispatches, **then** visible models match case-insensitively on `modelId` or `modelName`.
- **Given** a query matching nothing, **then** the screen shows "No models match" and Esc/back still works.
- **Given** the port resolves `[]` (empty/malformed catalog), **then** providers screen shows "No connected providers" empty state.
- **Given** the port rejects, **then** an error panel renders with the message and Esc pops the screen.
- **Given** a pending promise, **then** "Loading…" renders.
- **Given** `models` with `searchActive`, **when** Esc, **then** `searchActive=false`, query kept, stack unchanged; **when** Esc again, **then** stack pops to `providers`.
- **Given** `providers`, **when** `/`, **then** state unchanged.

## Migration / Rollout / Rollback

No data migration. Rollback: revert the Task 3 commit — Task 2 placeholders are replaced additively, route/keymap/mode contracts untouched, so revert restores Task 2 behavior cleanly.

## Risks

- `TuiPluginApi.client` shape drift vs the adapter's structural `OpenCodeClient` — mitigated by the adapter's existing defensive typing and adapter tests.
- Stale catalog within one route session — accepted (documented); manual refresh is out of scope.
- Esc dual-role (search-stop vs back) could confuse — mitigated by explicit reducer tests for both orders.

## Non-Goals

Model-detail content/editor, persistence, quarantines, background refresh triggers, catalog mutations, and any new SDK discovery path are **out of scope** (Tasks 4–5 and Task 1 coordinator own them).

## Open Questions

- None blocking. Confirm during implementation that OpenTUI `input` exposes `onInput` in the pinned `@opentui/solid` version; if not, fall back to keymap `search-input(char)` events (reducer contract unchanged).
