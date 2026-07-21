# Apply Progress — Task 4: Model-Detail Screen & Editable Metadata Forms

**Change**: `model-control-center-tui`
**Task**: Task 4 — Model-Detail Screen & Editable Metadata Forms
**Mode**: Strict TDD Mode

## Status
Completed Task 4 implementation under Strict TDD cycle. All unit, component, lifecycle, query, validation, and navigation test suites passing cleanly.

## Completed Tasks
- [x] 1. Main menu & keyboard navigation foundation (Task 2)
- [x] 2. Connected providers screen & model list screen with search (Task 3)
- [x] 3. Model detail view & tabbed interface (Task 4)
- [ ] 4. Quarantines list & release workflow (Task 5)

## Completed Work (Task 4)
- Created `src/ports/model-detail-query.port.ts`: `ModelDetailQueryPort` read-only port interface & `PersistedModelDetail`.
- Modified `src/infrastructure/prisma/prisma-model-repository.adapter.ts`: Added additive `findModelDetail` query method without modifying write paths or schema.
- Created `src/tui/model-detail-view.ts`: `LoadedDetail`, `DetailDraft`, `mergeModelDetail` (catalog + persisted merge), `createDraft`, `updateField`, `isTabDirty`, `isDraftDirty`.
- Created `src/tui/detail-validation.ts`: `validateDraft`, `FieldValidation`, `ValidationResult` (per-field range, currency ISO-4217, and numeric checks).
- Modified `src/tui/navigation.ts`: ScreenState focus property (`{ area: "tabs" } | { area: "fields"; index: number }`), events (`focus-fields`, `focus-tabs`, `field-next`, `field-prev`, `save-intent`, `discard-draft`), Enter focus transition, and Esc dual-role focus/dirty handling.
- Created `src/tui/ModelDetailScreen.tsx`: Tabbed read/edit form for Overview, Benchmarks, Pricing, and Subscription tabs with explicit "pending schema (Task 5)" labeling for unmapped metadata.
- Modified `src/tui/ModelControlCenter.tsx`: Accept optional `detailQuery` port, lazy load model details on route entry, wire `ctrl+s` (`mcc.form.save`), validate in-memory draft, update baseline notice, and handle Esc dirty discard.
- Modified `src/tui.ts`: Instantiated additive `PrismaModelRepositoryAdapter` query port and passed it through to `ModelControlCenter`.
- Created `tests/tui-detail-validation.test.ts`, `tests/tui-model-detail-view.test.ts`, `tests/model-detail-query.test.ts`.
- Modified `tests/tui-navigation.test.ts`: Added focus transitions, enter field focus, and Esc field focus / tab dirty discard assertions.

## TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| 4.1 Query Port & Prisma Query | `tests/model-detail-query.test.ts` | Integration | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 2 cases | ✅ Clean |
| 4.2 Detail View & Pure Merger | `tests/tui-model-detail-view.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 3 cases | ✅ Clean |
| 4.3 Draft Validation | `tests/tui-detail-validation.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 6 cases | ✅ Clean |
| 4.4 Navigation Focus & Reducer | `tests/tui-navigation.test.ts` | Unit | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 3 cases | ✅ Clean |
| 4.5 Screen & MCC Integration | `tests/tui-navigation.test.ts` | Integration | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 2 cases | ✅ Clean |

## Verification Evidence
- `npm run test:tui` -> PASS
- `npx tsx tests/tui-detail-validation.test.ts` -> PASS
- `npx tsx tests/tui-model-detail-view.test.ts` -> PASS
- `npx tsx tests/model-detail-query.test.ts` -> PASS
- `npm run build` -> PASS
- `npm run test:typecheck:strict` -> PASS
- `npm run test:all` -> PASS
