# Tasks: Model Control Center TUI

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 1,200+ (multi-component TUI, persistence, quarantine, tests) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Navigation & Screens) → PR 2 (Detail & Persistence) → PR 3 (Quarantine & Release Safety) |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: size-exception
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Main menu, provider list, model list, search & pure navigation reducer | PR 1 | Base UI & screen stack |
| 2 | Model detail tabbed form, validation, Prisma write adapter, global registry | PR 2 | Persistence & live rehydration |
| 3 | Quarantine precedence/TTL, store, interception gate & release-safety gates | PR 3 | Quarantine & release verification |

## Phase 1: Navigation & Catalog Foundation

- [x] 1.1 Implement pure navigation reducer (`src/tui/navigation.ts`) supporting screen stack and modal keymaps with TDD tests (`tests/tui-navigation.test.ts`)
- [x] 1.2 Implement OpenCode dialog lifecycle integration (`src/tui.ts`) with `alt+shift+m` keymap shortcut and regression guard for `ctrl+alt+f` (`tests/tui-registration.test.ts`)
- [x] 1.3 Implement provider catalog and model search helpers (`src/tui/catalog-view.ts`) and screens (`src/tui/ProvidersScreen.tsx`, `src/tui/ModelsScreen.tsx`)

## Phase 2: Model Detail Editing & Persistence

- [x] 2.1 Implement model detail tabbed view merger (`src/tui/model-detail-view.ts`) and field editor state (`src/tui/model-detail-field-edit.ts`) with unit tests (`tests/tui-model-detail-view.test.ts`)
- [x] 2.2 Implement detail validation rules (`src/domain/model-detail/detail-validation.ts`) and metadata serialization (`src/domain/model-detail/metadata.ts`) with unit tests (`tests/tui-detail-validation.test.ts`, `tests/domain-metadata.test.ts`)
- [x] 2.3 Implement durable save use case (`src/application/save-model-detail/save-model-detail.use-case.ts`), Prisma transaction write adapter (`src/infrastructure/prisma/prisma-model-repository.adapter.ts`), and optimistic hash checks (`tests/use-case-save-model-detail.test.ts`, `tests/prisma-write-adapter.test.ts`)
- [x] 2.4 Implement global model config registry (`src/infrastructure/runtime/model-config-registry.ts`) and DB read-through bootstrap interception (`src/bootstrap/index.ts`, `tests/bootstrap-interception.test.ts`)

## Phase 3: Quarantine Management & Live Interception

- [x] 3.1 Implement quarantine domain TTL and precedence rules (`src/domain/model/quarantine.ts`) with unit tests (`tests/domain-quarantine.test.ts`)
- [x] 3.2 Implement quarantine application use cases (`src/application/quarantine/`), Prisma adapter persistence (`src/infrastructure/prisma/prisma-model-repository.adapter.ts`), and global quarantine store (`src/infrastructure/runtime/quarantine-store.ts`) with unit & integration tests (`tests/use-case-quarantine.test.ts`, `tests/prisma-quarantine-adapter.test.ts`, `tests/runtime-quarantine-store.test.ts`)
- [x] 3.3 Implement Quarantines TUI screen (`src/tui/QuarantinesScreen.tsx`), view helper (`src/tui/quarantine-view.ts`), and bootstrap interception gate (`src/bootstrap/index.ts`, `tests/bootstrap-interception.test.ts`)

## Phase 4: Integration Verification & Release Safety

- [x] 4.1 Verify end-to-end model edit and live rehydration flow (`tests/integration-model-edit-flow.test.ts`)
- [x] 4.2 Verify quarantine interception, release, and missing-store fallback (`tests/integration-quarantine-interception.test.ts`)
- [x] 4.3 Verify dialog lifecycle, keymap cleanup, and host collision regression guard (`tests/integration-route-cleanup.test.ts`)
- [x] 4.4 Verify package exports, self-reference imports, and Bun/OpenTUI renderer gate (`tests/integration-package-exports.test.ts`, `tests/tui-bun-renderer.test.ts`)
- [x] 4.5 Verify database path isolation and staged-artifact release safety script (`tests/integration-release-safety.test.ts`, `scripts/verify-release-safety.mjs`)

## Phase 5: Verification Remediation & Strict-TDD Assertion Hardening

- [x] 5.1 Replace non-failing `console.assert` checks with process-failing `node:assert` throwing assertions across quarantine test files (`tests/domain-quarantine.test.ts`, `tests/runtime-quarantine-store.test.ts`, `tests/use-case-quarantine.test.ts`, `tests/prisma-quarantine-adapter.test.ts`, `tests/tui-quarantine-view.test.ts`) so command execution accurately reflects test outcomes
- [x] 5.2 Add reliable interception-level quarantine precedence test (`tests/integration-quarantine-interception.test.ts`) verifying that when overlapping active provider, model, and modelProvider rules exist, the highest-precedence rule reliably blocks routing under `npm test`
- [x] 5.3 Add Bun TUI test assertion (`tests/tui-bun-renderer.test.ts` / `tests/c9-ctrls-save.bun.test.ts`) proving that submitting via Ctrl+S in `ModelControlCenter` forwards the complete edited draft payload along with the expected `expectedEnvelopeHash`
