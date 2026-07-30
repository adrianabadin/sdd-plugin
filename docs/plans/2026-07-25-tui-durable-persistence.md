# TUI Durable Persistence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILLS: use `test-driven-development`, `systematic-debugging`, and `verification-before-completion`. Execute RED-GREEN task by task. Preserve the current dirty tree and do not commit.

**Goal:** Make Model Detail Save persist every editable Benchmark and Pricing value to one canonical user-data SQLite database and verify the committed data before reporting success.

**Architecture:** Replace bundle-relative database discovery with a platform-stable user-data resolver plus a one-time atomic migration from the current project database. Extend the write contract to all eight benchmark fields. Save runs one write transaction, rereads through an independent Prisma connection, compares the requested snapshot, and only then publishes runtime state and clears the dirty marker.

**Tech Stack:** TypeScript ESM, SolidJS/OpenTUI, Prisma + LibSQL/SQLite, tsx assertion scripts, Bun renderer tests.

**Constraints:** Work on the user-approved current dirty `main`; preserve unrelated changes; no commit/push/reset/stash/clean; no silent in-memory Save fallback.

---

### Task 1: Establish one canonical user-data database

**Files:**
- Modify: `src/infrastructure/runtime/database-path.ts`
- Modify composition roots that construct Prisma clients: `src/tui.ts`, `src/bootstrap/index.ts`
- Test: `tests/runtime-database-path.test.ts`
- Test built artifact path behavior in an existing/new focused test

1. Write failing tests proving the resolver is independent of `cwd`, `import.meta.url` bundle depth, and project installation location.
2. Define test overrides (`SDD_PLUGIN_DB_PATH`, then `SDD_PLUGIN_DATA_DIR`) and a platform user-data default. On Windows use `%LOCALAPPDATA%/sdd-plugin/opencode-models.db`; implement equivalent XDG/macOS fallbacks.
3. Add a one-time initialization/migration function. If the destination is absent and the current project database exists, copy to a temporary file in the destination directory and atomically rename it. Never overwrite an existing destination.
4. If neither destination nor a valid migration source exists, fail initialization with a structured persistence error; never create or accept an empty schema-less database silently.
5. Make TUI and bootstrap use the same resolver/initializer contract.
6. Run focused path/migration tests to GREEN.

### Task 2: Align Prisma runtime versions and preserve real errors

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Add/modify a focused error-normalization helper and tests under `src/infrastructure/` / `tests/`
- Modify: `src/tui.ts`, `src/tui/ModelControlCenter.tsx`

1. Add a failing dependency assertion proving `prisma`, `@prisma/client`, and `@prisma/adapter-libsql` resolve to the same exact version.
2. Align the three packages without unrelated upgrades.
3. Add tests for unknown/DriverAdapter errors that preserve message, stack, and structured `cause` instead of relying on `String(err)`.
4. Log/trace the resolved database path without exposing secrets.
5. Remove silent dependency-construction swallowing. Surface an explicit persistence-unavailable state.
6. Run dependency, typecheck, and focused error tests to GREEN.

### Task 3: Persist all editable Benchmark and Pricing fields

**Files:**
- Modify: `src/ports/model-detail-write.port.ts`
- Modify: `src/application/save-model-detail/save-model-detail.use-case.ts`
- Modify: `src/infrastructure/prisma/prisma-model-repository.adapter.ts`
- Modify: `src/tui/ModelControlCenter.tsx`
- Modify domain validation/types as required
- Test: save use-case, Prisma adapter, and integration model-edit tests

1. Write failing tests for `gpqa`, `math`, `bbh`, `mtBench`, and `multineedle` in addition to `mmlu`, `humaneval`, and `sweBench`.
2. Extend `SaveModelDetailInput` and `SaveModelDetailCommand` to carry all eight optional numeric fields.
3. Map the complete immutable draft in `handleSaveIntent`.
4. Write all eight fields in the existing transaction, preserving `null` intentionally.
5. Keep Pricing input/output/cached/currency transactional behavior unchanged except for verification support.
6. Run use-case, adapter, and integration tests to GREEN.

### Task 4: Add an independent read-after-write persistence postcondition

**Files:**
- Modify: `src/application/save-model-detail/save-model-detail.use-case.ts`
- Modify: relevant ports/result types
- Modify composition roots to inject an independently constructed verification query connection
- Modify cleanup/disposal to close both Prisma clients exactly once
- Test use-case and real temporary SQLite integration

1. Write failing tests proving registry publication and UI success cannot occur until a verification query returns every requested field.
2. Add mismatch tests: missing benchmark, wrong Pricing value, query failure, and unavailable verifier must all fail Save.
3. After the write transaction resolves, query the same model through an independent Prisma connection.
4. Compare every requested Benchmark and Pricing field using explicit null/number/currency semantics.
5. Return the verified persisted snapshot; do not return synthetic `now`-only success data.
6. Publish runtime state only after verification succeeds.
7. On failure, preserve the draft and dirty state and expose a structured error.
8. Add a temporary-database test that disconnects the writer, opens a fresh client, and proves all fields survive.
9. Run focused and integration tests to GREEN.

### Task 5: Make Save semantics honest in the TUI

**Files:**
- Modify: `src/tui/ModelControlCenter.tsx`
- Modify: `src/tui/ModelDetailScreen.tsx` only for notices/help text
- Modify: `tests/tui-numeric-editing.test.ts`
- Add/modify a built-TUI persistence integration test

1. Write failing registered-command tests for active numeric buffer + Ctrl+S: valid input is committed before Save; invalid/incomplete input blocks Save.
2. Remove the memory-only fallback that marks the baseline clean when persistence is unavailable.
3. Keep the draft dirty until verified persistence returns.
4. Show `Persisted and verified` only after readback equality; show the normalized root cause otherwise.
5. Add a built `dist/tui.js` test using a temporary user-data directory/database that triggers Save and verifies data through a fresh client.
6. Confirm Enter/Tab never initiate the query; they only manage editing/navigation.
7. Run Bun registered-command and built-artifact persistence tests to GREEN.

### Task 6: Full regression and durability verification

1. Run focused path, migration, save-use-case, adapter, and built-TUI persistence tests.
2. Run `npm run test:tui`.
3. Run `npm run test:tui:bun`.
4. Run `npm run test:integration`.
5. Run `npm run test:typecheck:strict`.
6. Run `npm run build`.
7. Run `git diff --check` and inspect the scoped diff for unrelated overwrites.
8. Against a temporary database, verify SQLite `foreign_keys=ON` and a durable synchronous mode; disconnect all clients and perform a final fresh-client readback.
9. Perform a fresh-context spec/reliability review. Fix all CRITICAL/WARNING findings and re-review.

### Acceptance Criteria

- TUI and bootstrap resolve exactly the same canonical user-data database.
- Existing project data migrates once without overwriting an existing user-data database.
- A schema-less/empty database cannot be treated as ready.
- All eight Benchmark fields and all Pricing fields persist.
- Ctrl+S commits a valid active numeric buffer before saving.
- Save success requires transaction completion plus independent readback equality.
- Any mismatch/error leaves the draft dirty and prevents runtime publication/success notice.
- Persistence unavailable never degrades to a clean in-memory baseline.
- Real Prisma/SQLite causes are visible and actionable.
- Prisma package versions are aligned.
- Fresh-client temporary-DB and built-TUI tests prove persistence across reconnects.
