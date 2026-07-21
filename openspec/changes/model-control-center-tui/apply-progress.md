# Apply Progress — Task 6: Quarantine Management

**Change**: `model-control-center-tui`
**Task**: Task 6 — Quarantine Management
**Mode**: Strict TDD Mode

## Status
Completed Task 6 implementation under Strict TDD cycle. All unit, integration, domain, runtime, use case, TUI view, and Prisma adapter test suites passing cleanly. Tasks 2-5 preserved. No automatic quarantine; no provider/model browser redesign.

## Completed Tasks
- [x] 1. Main menu & keyboard navigation foundation (Task 2)
- [x] 2. Connected providers screen & model list screen with search (Task 3)
- [x] 3. Model detail view & tabbed interface (Task 4)
- [x] 4. Durable model-detail persistence & immediate runtime application (Task 5)
- [x] 5. Quarantine management: TTL/precedence helpers, QuarantineWritePort, use cases, runtime store, screen, navigation integration, and bootstrap interception gate (Task 6)

## Completed Work (Task 5 — preserved)
- **Schema & Migration**: `prisma/schema.prisma` carries nullable `metadata`, `metadataEnvelopeHash`, `quarantineType`, and `quarantineUntil` columns on `Provider` and `Model`, plus `quarantineType`/`quarantineUntil` on `ModelProvider`. Migration `20260721000000_init` already committed.
- **Domain Metadata**: `src/domain/model-detail/metadata.ts` (ProviderMetadata, ModelMetadata, parse/serialize/envelope hash).
- **Domain Validation Promotion**: `src/domain/model-detail/detail-validation.ts` and `src/tui/detail-validation.ts`.
- **Shared DB Authority**: `src/infrastructure/runtime/database-path.ts`; `src/bootstrap/index.ts` and `src/tui.ts` routed through it.
- **Write Port & Adapter**: `src/ports/model-detail-write.port.ts` and `saveModelDetail` on `PrismaModelRepositoryAdapter` (single `$transaction`, optimistic `metadataEnvelopeHash`, pricing history).
- **Use Case**: `src/application/save-model-detail/save-model-detail.use-case.ts`.
- **Model Config Registry**: `src/infrastructure/runtime/model-config-registry.ts` on `Symbol.for("sdd-plugin.model-config-registry.v1")`.
- **Plugin Interception**: `src/bootstrap/index.ts` `tool.execute.before` with registry-first DB read-through hydration.
- **TUI Wiring**: `src/tui/ModelControlCenter.tsx` Ctrl+S save intent, conflict notices, automatic re-read on stale hash.

## Completed Work (Task 6)
- **Domain Primitives**: `src/domain/model/quarantine.ts` exposes `QuarantineType`, `QuarantineLevel`, `QuarantineTarget`, `QuarantineEntry`, `isQuarantineActive(entry, now)`, and `resolveQuarantinePrecedence(entries, providerId, modelId, now)`. Precedence: `provider > model > modelProvider`; TTL active while `now < quarantineUntil`; exact boundary is inactive.
- **Write Port**: `src/ports/quarantine-write.port.ts` defines `SetQuarantineCommand` and `QuarantineWritePort` (`setQuarantine`, `releaseQuarantine`, `listQuarantines`).
- **Application Use Cases**: `src/application/quarantine/{set,release,list}-quarantine.use-case.ts` enforce target/TTL validation, transactional persistence, and `QuarantineStore` publish/release/hydrate. Runtime-store failures are swallowed to keep DB commit authoritative.
- **Runtime Store**: `src/infrastructure/runtime/quarantine-store.ts` implements `QuarantineStore` with `hydrate`, `publish`, `release`, `isActive`, `snapshot`. `getGlobalQuarantineStore()` is a `Symbol.for("sdd-plugin.quarantine-store.v1")` singleton on `globalThis`.
- **Prisma Adapter**: `PrismaModelRepositoryAdapter` gained `setQuarantine`, `releaseQuarantine`, and `listQuarantines` (provider, model, and modelProvider scopes; release clears both `quarantineType` and `quarantineUntil`; writes wrapped in `prisma.$transaction`).
- **TUI View & Screen**: `src/tui/quarantine-view.ts` derives sorted/labeled `QuarantineItemView[]` with active/expired labels; `src/tui/QuarantinesScreen.tsx` renders loading/empty/expired/error/notice states with up/down navigation and Enter/Esc actions.
- **Navigation Integration**: `src/tui/navigation.ts` `quarantines` screen state now carries `selectedIndex`; `transitionScreen` handles up/down for quarantines with cyclic bounds; main-menu activate pushes `{ name: "quarantines", selectedIndex: 0 }`.
- **MCC Integration**: `src/tui/ModelControlCenter.tsx` replaces the placeholder with `QuarantinesScreen`, lazy-loads entries via `listQuarantinesUseCase` (or `quarantinePort.listQuarantines()`), tracks `loading`/`error`/`notice` signals, and surfaces visible count for navigation.
- **TUI Wiring**: `src/tui.ts` instantiates `ListQuarantinesUseCase`, `SetQuarantineUseCase`, and `ReleaseQuarantineUseCase` sharing the `PrismaModelRepositoryAdapter` and the global `QuarantineStore`, then passes them into `ModelControlCenter`.
- **Bootstrap Interception Gate**: `src/bootstrap/index.ts` `tool.execute.before` performs a defensive `getGlobalQuarantineStore()` check (try/catch fallback), hydrates from `repository.listQuarantines()` if the snapshot is empty, and emits an info log for any active target. A missing store cannot break task interception.
- **Port Index**: `src/ports/index.ts` re-exports `QuarantineWritePort` and `SetQuarantineCommand`.
- **Tests**: `tests/domain-quarantine.test.ts`, `tests/runtime-quarantine-store.test.ts`, `tests/use-case-quarantine.test.ts`, `tests/prisma-quarantine-adapter.test.ts`, `tests/tui-quarantine-view.test.ts`. `tests/bootstrap-interception.test.ts` extended to assert quarantine store DB read-through hydration.

## TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| 4.1 Query Port & Prisma Query | `tests/model-detail-query.test.ts` | Integration | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 2 cases | ✅ Clean |
| 4.2 Detail View & Pure Merger | `tests/tui-model-detail-view.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 3 cases | ✅ Clean |
| 4.3 Draft Validation | `tests/tui-detail-validation.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 6 cases | ✅ Clean |
| 4.4 Navigation Focus & Reducer | `tests/tui-navigation.test.ts` | Unit | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 3 cases | ✅ Clean |
| 4.5 Screen & MCC Integration | `tests/tui-navigation.test.ts` | Integration | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 2 cases | ✅ Clean |
| 5.1 Domain Metadata Envelope | `tests/domain-metadata.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 3 cases | ✅ Clean |
| 5.2 Shared DB Path Authority | `tests/runtime-database-path.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 1 case | ✅ Clean |
| 5.3 Global Model Config Registry | `tests/runtime-model-config-registry.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 2 cases | ✅ Clean |
| 5.4 SaveModelDetailUseCase | `tests/use-case-save-model-detail.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 3 cases | ✅ Clean |
| 5.5 Prisma Write Adapter Transaction | `tests/prisma-write-adapter.test.ts` | Integration | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 3 cases | ✅ Clean |
| 5.6 Bootstrap Interception & Hydration | `tests/bootstrap-interception.test.ts` | Integration | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 2 cases | ✅ Clean |
| 6.1 Domain TTL & Precedence | `tests/domain-quarantine.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 4 cases | ✅ Clean |
| 6.2 QuarantineStore Runtime | `tests/runtime-quarantine-store.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 6 cases | ✅ Clean |
| 6.3 Quarantine Use Cases | `tests/use-case-quarantine.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 5 cases | ✅ Clean |
| 6.4 Prisma Adapter Transactional | `tests/prisma-quarantine-adapter.test.ts` | Integration | N/A (new) | ✅ Written | ✅ Passed | ✅ 6 cases | ✅ Clean |
| 6.5 Quarantine View Derivation | `tests/tui-quarantine-view.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 2 cases | ✅ Clean |
| 6.6 Bootstrap Quarantine Gate | `tests/bootstrap-interception.test.ts` | Integration | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 1 case | ✅ Clean |

## Verification Evidence
- `npx tsx tests/domain-metadata.test.ts` -> PASS
- `npx tsx tests/runtime-database-path.test.ts` -> PASS
- `npx tsx tests/runtime-model-config-registry.test.ts` -> PASS
- `npx tsx tests/use-case-save-model-detail.test.ts` -> PASS
- `npx tsx tests/prisma-write-adapter.test.ts` -> PASS
- `npx tsx tests/bootstrap-interception.test.ts` -> PASS
- `npx tsx tests/domain-quarantine.test.ts` -> PASS
- `npx tsx tests/runtime-quarantine-store.test.ts` -> PASS
- `npx tsx tests/use-case-quarantine.test.ts` -> PASS
- `npx tsx tests/prisma-quarantine-adapter.test.ts` -> PASS
- `npx tsx tests/tui-quarantine-view.test.ts` -> PASS
- `npm run test:tui` -> PASS
- `npm run build` -> PASS
- `npm run test:typecheck:strict` -> PASS
- `npm run test:all` -> PASS

## Workload / PR Boundary
- Mode: single PR
- Current work unit: Task 6 (Quarantine Management) full slice
- Boundary: scoped to quarantine TTL/precedence, port/use cases, runtime store, Prisma adapter, TUI screen + view, navigation, MCC wiring, tui.ts wiring, bootstrap interception gate, and focused tests. Tasks 2-5 are preserved unchanged.
- Estimated review budget impact: within 400-line change budget for new quarantine additions; pre-existing Task 5 changes carried over from the prior apply batch.

## Risks
- Clock drift is mitigated with an injected `now` parameter for both the domain helper and the runtime store.
- Cross-bundle drift is mitigated with `Symbol.for` + DB read-through hydration on the bootstrap interception gate.
- A missing store cannot break task interception: every store call is wrapped in try/catch and falls back to existing behavior.
- Concurrency: identical-target `setQuarantine` calls are serialized inside the same Prisma `$transaction`; the in-memory store replaces the previous entry on `publish` to keep state converged.
- Quarantine release persists `quarantineType = null` AND `quarantineUntil = null` in a single transaction, so an old TTL cannot resurface.
