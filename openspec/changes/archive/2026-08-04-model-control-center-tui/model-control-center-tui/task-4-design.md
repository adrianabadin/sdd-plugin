# Task 4 Design: Model-Detail Screen & Editable Metadata Forms

**Change**: model-control-center-tui | **Scope**: detail screen + draft editing only — NO persistence (Task 5 owns writes) | **Base**: Task 2/3 state machine and catalog view (unchanged host contract)

## Technical Approach

Fill the existing `model-detail` screen slot with a tabbed read/edit form. Data comes from a NEW read-only query port (Prisma adapter, additive) merged with the Task 3 catalog snapshot. All editing happens in an immutable **draft** kept separate from the loaded baseline; Ctrl+S validates and commits draft → in-memory baseline (explicitly NOT persisted). Pure modules hold view derivation, draft logic, and validation; screens stay thin Solid components.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Read path | New `ModelDetailQueryPort.findModelDetail(providerId, modelId)`; Prisma adapter gains additive read methods; merged with catalog row (persisted wins) | Reuse write-only `ModelRepositoryPort`; catalog-only | Current port is write-only (traced: upserts + `findLatestPricing` only); a separate query port keeps write contract untouched |
| Schema gaps | Fields without schema columns (context window, max output, capabilities, subscription plan/periodic cost/included usage/overage) live in draft as **unmapped metadata**, validated + editable, flagged "pending schema (Task 5)" | Extend Prisma schema now; drop fields | Task 5 owns persistence; Task 4 must not migrate the DB. Flagging preserves user-required fields without fake persistence |
| Draft model | `DetailDraft` = deep copy of `LoadedDetail`; pure `createDraft`, `updateField`, per-tab `isDirty(baseline, draft)` | Mutating signals; single dirty flag | Matches project pure-core style; per-tab dirty enables precise warnings and reducer tests without a renderer |
| Save semantics (Ctrl+S) | `save-intent` event → run all validators; errors block; on ok, draft becomes new baseline in memory + notice "Validated — persistence lands in Task 5" | Silent no-op; write to DB | Real, testable behavior honoring the Task 5 persistence boundary |
| Cancel / unsaved | Esc in field focus → exit focus (keep draft). Esc on tab strip with dirty tab → discard draft, notice, stay; second Esc pops (Task 3 dual-role precedent) | Modal confirm; auto-save | Deterministic, no new dialog infra, matches existing Esc vocabulary |
| Field focus | Screen gains `focus: {area:"tabs"} | {area:"fields"; index}`; Enter enters fields, Tab/Shift+Tab cycles fields when `area:"fields"`, cycles tabs when `area:"tabs"` | Tab always cycles tabs; per-field keymap | Resolves Tab dual-role explicitly, keeps strip navigation from Task 2 intact |

## Field Map (form → domain → schema)

| Tab | Fields | Backing |
|---|---|---|
| Overview | modelId (readonly), display name → `ModelData.name`, status/blocked → `ProviderData.isBlocked`, context window, max output, capabilities (vision/tools/reasoning checkboxes) | name/isBlocked: schema OK; context/max-output/capabilities: **no column — draft-only** |
| Benchmarks | mmlu, humaneval, sweBench, gpqa, math, bbh, mtBench, multineedle (floats, optional) | `BenchmarkScores` / `BENCHMARK_FIELDS` — schema OK |
| Pricing | input/output/cached per-million (floats), currency (ISO-4217); unit is a fixed "per 1M tokens" display label | `PricingData` — schema OK |
| Subscription | enabled (bool), type/tier (small/medium/large) → `ProviderData.subscription`; plan name, periodic cost, included usage, overage rate | enabled/tier: schema OK; plan/cost/usage/overage: **draft-only** |

## Validation (pure, per field)

- Numbers: `parseFloat` finite, ≥ 0; benchmarks additionally ≤ 100 when treated as percentages (warning if > 100, not error).
- Currency: 3-letter uppercase alpha; non-USD → warning "conversion not applied".
- Empty optional fields → warning "incomplete metadata"; never an error.
- Invalid input → inline error, field marked, `save-intent` blocked with error summary.
- Result shape: `{ status: "ok" | "warn" | "error"; message?: string }` per field id.

## Data Flow

```
enter model-detail → queryPort.findModelDetail + catalog row → LoadedDetail
  → createDraft(loaded) → draft signal + baseline signal
key/input → dispatch(form event) → pure reducer → draft/focus signal → re-render
ctrl+s → validate(draft) → ok: baseline=draft (in-memory) / error: inline messages
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/ports/model-detail-query.port.ts` | Create | Read-only port returning persisted aggregate (model, provider, link, latest pricing) or null |
| `src/infrastructure/prisma/prisma-model-repository.adapter.ts` | Modify | Additive `findModelDetail` (no write-path changes) |
| `src/tui/model-detail-view.ts` | Create | Merge catalog + persisted → `LoadedDetail`; `DetailDraft`, `createDraft`, `updateField`, `isDirty` |
| `src/tui/detail-validation.ts` | Create | Per-field validators + `validateDraft` |
| `src/tui/navigation.ts` | Modify | `model-detail` gains `focus`; events `field-next/prev`, `focus-fields`, `focus-tabs`, `field-input`, `save-intent`, `discard-draft` |
| `src/tui/ModelDetailScreen.tsx` | Create | Tab bar + 4 tab forms; `FormField` (label, input, validation line, focus highlight) |
| `src/tui/ModelControlCenter.tsx` | Modify | Accept optional `detailQuery` port, lazy-load on entering detail, replace placeholder, add `ctrl+s` binding (`mcc.form.save`) |
| `src/tui.ts` | Modify | Construct Prisma-backed query adapter and pass through |
| `tests/tui-model-detail-view.test.ts` | Create | Draft/dirty/merge Given-When-Then (tsx assertion-script convention) |
| `tests/tui-detail-validation.test.ts` | Create | Validator scenarios |
| `tests/tui-navigation.test.ts` | Modify | Focus transitions, save-intent gating, dirty-Esc discard scenarios |

## Test-First Scenarios

- **Given** persisted pricing and catalog row, **when** detail loads, **then** persisted values win and catalog-only fields fill gaps.
- **Given** no persisted record (query returns null), **when** detail loads, **then** form shows catalog data + "no saved metadata" warning; editing still works.
- **Given** clean draft, **when** a field edits, **then** only that tab reports dirty; other tabs stay clean.
- **Given** `"abc"` in a numeric field, **when** `save-intent`, **then** save blocked, inline error on field, draft preserved.
- **Given** empty optional benchmarks, **when** validating, **then** warnings only; save-intent succeeds.
- **Given** focus on tab strip, **when** Tab, **then** tab cycles (Task 2 contract); **when** Enter then Tab, **then** focus moves to next field; Shift+Tab reverses; Esc returns focus to strip.
- **Given** dirty draft, **when** Esc on strip, **then** draft discarded + notice, screen stays; **when** Esc again, **then** stack pops.
- **Given** dirty draft, **when** `ctrl+s` valid, **then** baseline updates, dirty clears, "not persisted" notice shows; reload from port shows original values.

## Migration / Rollout / Rollback

No data migration (explicitly deferred to Task 5). Rollback: revert the Task 4 commit — all surface area is additive except replacing the detail placeholder and extending the `model-detail` union member; Tasks 2/3 behavior untouched.

## Risks

- **Schema gap** for context/capabilities/subscription economics: draft-only fields risk user confusion — mitigated by visible "pending schema (Task 5)" flag and a Task 5 open decision (new columns vs JSON metadata blob).
- Tab/Esc dual-role overload — mitigated by explicit `focus` state and reducer tests for both orders.
- OpenTUI `@opentui/solid` input focus/`onInput` API unverified — same fallback as Task 3 (keymap-driven field input, reducer contract unchanged).

## Non-Goals

Persistence writes and Prisma schema migration (Task 5), runtime bridge to OpenCode config, quarantine UI, provider browsing changes, catalog refresh triggers.

## Open Questions

- Task 5 decision needed: new Prisma columns vs JSON metadata column for context/max-output/capabilities/subscription economics. Not blocking for Task 4 (draft-only).
