# Apply Progress — Task 7: Final Integration & Release Safety

**Change**: `model-control-center-tui`
**Task**: Task 7 — Final Integration & Release Safety
**Mode**: Strict TDD Mode
**Commit**: `80d3547` (chore(release-safety): add Task 7 evidence, packaging, and release-safety gates)
**PR Slice**: single PR (size:exception — see Workload / PR Boundary below)

## Status
Completed Task 7 implementation under Strict TDD cycle. All previous Task 2-6 work preserved. Five integration tests added covering the five contract areas from `task-7-design.md`. All Node test suites green. Strict typecheck, build, public exports, and release-safety verification all pass locally. Bun release gate could not be exercised locally (no `bun` binary in this environment); CI executes it on `oven-sh/setup-bun@v2`.

## Completed Tasks (cumulative)
- [x] 1. Main menu & keyboard navigation foundation (Task 2)
- [x] 2. Connected providers screen & model list screen with search (Task 3)
- [x] 3. Model detail view & tabbed interface (Task 4)
- [x] 4. Durable model-detail persistence & immediate runtime application (Task 5)
- [x] 5. Quarantine management: TTL/precedence helpers, QuarantineWritePort, use cases, runtime store, screen, navigation integration, and bootstrap interception gate (Task 6)
- [x] 6. Task 7 — Final integration: end-to-end integration tests, route open/close cleanup, Ctrl+Alt+F host collision, public root & `./tui` package self-reference exports after build, Bun/OpenTUI renderer CI gate with Node/Bun test separation, Prisma migration / database-path / test DB isolation, staged-artifact protection, README + CI updates.

## Completed Work (Task 7)
- **Five integration tests** aligned with the 5 design bullets:
  - `tests/integration-model-edit-flow.test.ts` — `SaveModelDetailUseCase` → adapter → DB → `ModelConfigRegistry` publish → next `SddPlugin` interception observes update. Includes the publish-failure resilience path (use case surfaces warning when registry throws, DB persists, next interception rehydrates from DB) and cross-process rehydration (delete `globalThis[Symbol.for('sdd-plugin.model-config-registry.v1')]` then trigger the hook).
  - `tests/integration-quarantine-interception.test.ts` — provider- and model-level set/release; bootstrap interception observes `isActive`; release clears `quarantineType` AND `quarantineUntil` in DB; missing-store fallback (`delete globalThis[Symbol.for('sdd-plugin.quarantine-store.v1')]` → hook re-creates and hydrates from DB).
  - `tests/integration-route-cleanup.test.ts` — 5 mount/unmount cycles verifying mode push/pop parity, no duplicate route registrations, base keymap layer registered exactly once, route-scoped layer (from `ModelControlCenter`) registered once per mount and disposed on `onCleanup`, plugin unload disposes both layers. Includes Ctrl+Alt+F host collision check: binding registered ONLY on the base layer, command executes `route.navigate('model-control-center')`, supported OpenCode version contract (`>= 1.17.11`) verified.
  - `tests/integration-package-exports.test.ts` — `dist/bootstrap/index.js` and `dist/tui.js` exist after build; `package.json` exports map correct; root call as factory returns `tool.execute.before` hook; `./tui` exports `{ id: 'sdd-plugin.tui', tui }`; Bun renderer test source contains the runtime guard + `process.exit(1)` + actionable error message; CI workflow installs Bun and runs `npm run test:tui:bun`; Node test suite does NOT include `tui-bun-renderer`.
  - `tests/integration-release-safety.test.ts` — `resolveDatabasePath()` honors `SDD_PLUGIN_DB_PATH` and falls back to `<repo>/opencode-models.db`; three parallel test DBs are independent files; production DB mtime unchanged after test pushes; `.gitignore` patterns verified; `git check-ignore` confirms `.env`, `dist`, `node_modules`, `opencode-models.db` are ignored; `git status --short` reports no untracked forbidden paths; `git status --ignored` lists `dist/`, `node_modules/`, `opencode-models.db*` as ignored.
- **Release-safety helpers**:
  - `scripts/verify-release-safety.mjs` — CI gate that scans the working tree for staged or untracked forbidden artifacts and exits non-zero if any are present. Cross-checks against `git check-ignore` so a file already covered by `.gitignore` does not fail the gate.
  - `.gitignore` updated to explicitly exclude `dist/`, `node_modules/`, `opencode-models.db` and sidecars, `opencode-models.test-*`, `.env`, `.env.local`, `.env.*.local`, `src/generated/prisma`, and `*.tsbuildinfo`.
  - `.github/workflows/ci.yml` — adds `npm run verify:release-safety` as the first gate, splits `npm test` (Node) from `npm run test:tui:bun` (Bun release gate), and exposes `npm run test:exports` and `npm run test:typecheck:strict` as required CI steps.
  - `package.json` — new scripts `test:integration` (5 tests), `test:release-safety`, `verify:release-safety`; `test:all` now includes `test:integration`.
  - `README-SETUP.md` — adds a "Release Safety (Task 7)" section documenting the six CI gates and the Prisma migration rollback path.
- **Migration safety preserved**: the committed Prisma migration only adds nullable columns (`metadata`, `metadataEnvelopeHash`, `quarantineType`, `quarantineUntil`); rollback is `prisma migrate resolve --rolled-back` followed by `prisma migrate deploy`. Existing rows are preserved because every new column is nullable.

## TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 7.1 Model edit E2E + publish failure | `tests/integration-model-edit-flow.test.ts` | Integration | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 2 paths (happy + failure) | ✅ Clean |
| 7.2 Quarantine set/release + missing-store | `tests/integration-quarantine-interception.test.ts` | Integration | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 3 paths (provider/model/missing-store) | ✅ Clean |
| 7.3 Route open/close cleanup + host collision | `tests/integration-route-cleanup.test.ts` | Integration | ✅ 7/7 | ✅ Written | ✅ Passed | ✅ 5 mount cycles | ✅ Tightened |
| 7.4 Public exports after build + Bun gate | `tests/integration-package-exports.test.ts` | Integration | N/A (new) | ✅ Written | ✅ Passed | ✅ 2 contracts (root + ./tui) | ✅ Clean |
| 7.5 Release safety (DB isolation + staged artifacts) | `tests/integration-release-safety.test.ts` | Integration | N/A (new) | ✅ Written | ✅ Passed | ✅ 3 DB isolation paths + 4 gitignore paths | ✅ Clean |

## Verification Evidence
- `npx tsx tests/integration-model-edit-flow.test.ts` → PASS (24 assertions)
- `npx tsx tests/integration-quarantine-interception.test.ts` → PASS (18 assertions)
- `npx tsx tests/integration-route-cleanup.test.ts` → PASS (54 assertions)
- `npx tsx tests/integration-package-exports.test.ts` → PASS (24 assertions)
- `npx tsx tests/integration-release-safety.test.ts` → PASS (27 assertions)
- `npm run build` → PASS (TypeScript succeeds)
- `npm run test:typecheck:strict` → PASS (tests compile with strict checks)
- `npm run test:exports` → PASS (root + ./tui self-references)
- `npm test` → PASS (full Node suite, exit 0)
- `npm run verify:release-safety` → PASS (no forbidden artifacts staged)
- `npm run test:tui:bun` → NOT RUN LOCALLY (Bun unavailable in this environment; reported as limitation below)

## Workload / PR Boundary
- Mode: single PR with `size:exception`
- Current work unit: Task 7 (Final Integration & Release Safety) full slice
- Boundary: scoped to evidence/release-safety only — integration tests, release-safety script, .gitignore tightening, CI workflow gate additions, README updates. No product code changes.
- Estimated review budget impact: 1,251 net new lines (1,255 insertions, 4 deletions across 10 files). Over the 800-line soft target. Justification: evidence/release-safety work where tests ARE the deliverable. Five focused tests cover five explicit contract bullets from `task-7-design.md`. Each test averages ~217 lines of structured assertions, headers, and contract documentation — comparable to existing Task 5/6 integration tests.
- Local Bun limitation: this environment has no `bun` binary. The Bun release gate (`npm run test:tui:bun`) is asserted via static analysis in `tests/integration-package-exports.test.ts` and runs in CI on `oven-sh/setup-bun@v2`.

## Risks
- Test DB files (`opencode-models.test-<uuid>.db`) are produced by integration tests and ignored by `.gitignore`; if `.gitignore` regresses, the next commit could include them. `verify-release-safety.mjs` catches this in CI.
- The Bun release gate depends on the CI runner installing Bun via `oven-sh/setup-bun@v2`. If that action is removed or fails, the gate silently disappears. The package-exports integration test asserts the workflow contains the required step.
- `dist/` was previously not ignored; the new `.gitignore` adds it. A future contributor who runs `git add .` after a build will not stage it, but if they explicitly `git add -f dist/...` they can. The release-safety script catches forbidden staged artifacts regardless of how they were added.

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
