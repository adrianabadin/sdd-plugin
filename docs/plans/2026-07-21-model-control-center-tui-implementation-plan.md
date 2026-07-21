# Model Control Center TUI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a native OpenCode TUI opened by `Ctrl+Alt+F` for browsing, editing, and immediately applying model metadata and managing quarantines.

**Architecture:** Keep the existing plugin factory and refresh pipeline intact. Add a separate TUI bundle with a registered route and plugin-specific keymap mode, backed by the existing Prisma/LibSQL repositories. Persist changes to SQLite first, then update a stable cross-bundle runtime registry so the main plugin observes edits without restart.

**Tech Stack:** TypeScript, OpenCode plugin TUI APIs, Solid/OpenTUI route components, Prisma, LibSQL/SQLite, existing project test runner.

---

## Task 1: Establish TUI bundle and host registration

**Files:**
- Create: `src/tui.ts`
- Modify: `package.json`
- Modify: build configuration or scripts discovered during implementation
- Test: `tests/tui-registration.test.ts`

### Step 1: Write the failing tests

Cover:

- The TUI bundle exposes a plugin-compatible entrypoint without changing the main plugin export.
- `Ctrl+Alt+F` registers a command that navigates to the Model Control Center route.
- Route cleanup removes the plugin-specific mode and bindings.

### Step 2: Run the focused tests

Run the repository's existing focused test command for `tests/tui-registration.test.ts`.

Expected: FAIL because the TUI entrypoint and route do not exist.

### Step 3: Implement the minimum route registration

- Register a route named for the Model Control Center.
- Register a base-mode command and `ctrl+alt+f` binding through `api.keymap.registerLayer`.
- Push a route-specific mode while the route is mounted and clean it up on unmount.
- Keep the root package export callable and expose the TUI only through the dedicated `./tui` export if the current package layout requires it.

### Step 4: Run focused tests and build

Run the focused TUI tests and the normal TypeScript/build command.

Expected: PASS; the main plugin loader still accepts the root export.

### Step 5: Commit the work unit

Use a focused conventional commit such as:

```text
feat: register model control center tui
```

---

## Task 2: Implement the main menu and keyboard navigation

**Files:**
- Modify: `src/tui.ts`
- Create: `src/tui/ModelControlCenter.tsx` or the route component path selected by the existing project conventions
- Test: `tests/tui-navigation.test.ts`

### Step 1: Write failing behavior tests

Cover:

- The initial menu contains `Models` and `Quarantines`.
- Arrow keys move the selection.
- `Enter` opens the selected section.
- `Esc` closes the route or returns to the previous screen.
- `Tab` and `Shift+Tab` switch detail sections in a deterministic order.

### Step 2: Run the focused tests

Expected: FAIL because the screens and navigation state do not exist.

### Step 3: Implement the navigation state machine

Use explicit screen state rather than implicit component nesting:

```text
main-menu -> providers -> models -> model-detail
main-menu -> quarantines
```

Model-detail tabs must use the fixed order:

```text
Overview -> Benchmarks -> Pricing -> Subscription
```

### Step 4: Run focused tests

Expected: PASS, including reverse navigation with `Shift+Tab`.

### Step 5: Commit the work unit

```text
feat: add model control center navigation
```

---

## Task 3: Add provider and model browsing

**Files:**
- Modify: `src/tui/ModelControlCenter.tsx`
- Modify: existing model/provider repository or query adapter identified from the current source
- Test: `tests/tui-model-browser.test.ts`

### Step 1: Write failing tests

Cover:

- Only connected providers are shown.
- Provider counts match the connected model catalog.
- Provider selection shows models for that provider.
- Search filters models without changing persisted data.
- Empty provider and empty search states render useful messages.

### Step 2: Run focused tests

Expected: FAIL until the browser reads the existing catalog boundary.

### Step 3: Implement read-only browsing

- Reuse the canonical connected-provider/model source already used by the refresh layer.
- Do not reintroduce global provider discovery paths rejected by the existing architecture.
- Keep sorting and filtering deterministic.

### Step 4: Run focused tests and typecheck

Expected: PASS.

### Step 5: Commit the work unit

```text
feat: browse connected model catalog in tui
```

---

## Task 4: Implement model detail and editable metadata forms

**Files:**
- Create or modify: `src/tui/model-editor.ts` and detail components under `src/tui/`
- Modify: existing Prisma model repository and DTO/validation boundary
- Test: `tests/tui-model-editor.test.ts`

### Step 1: Write failing tests

Cover editing and validation for:

- Identity and display fields.
- Context and output limits.
- Text, vision, tools, and reasoning capabilities.
- Benchmark metrics supported by the schema.
- Input, output, and cached-input pricing.
- Currency and pricing unit.
- Subscription enabled state, type, plan, periodic cost, included usage, and overage pricing.

Include invalid negative numbers, malformed prices, unsupported subscription combinations, and incomplete values.

### Step 2: Run focused tests

Expected: FAIL because the editor and validation boundary do not exist.

### Step 3: Implement typed form state and validation

- Keep draft form state separate from persisted model state.
- Preserve invalid input in the editor so users can correct it.
- Show incomplete metadata warnings without treating optional metadata as a save failure.
- Require confirmation when closing with unsaved changes.

### Step 4: Run focused tests

Expected: PASS for valid and invalid form cases.

### Step 5: Commit the work unit

```text
feat: edit model metadata in tui
```

---

## Task 5: Persist edits and apply them immediately at runtime

**Files:**
- Create: `src/runtime/model-config-registry.ts`
- Modify: existing Prisma/LibSQL model repository
- Modify: main plugin refresh/interception path
- Test: `tests/tui-runtime-apply.test.ts`

### Step 1: Write failing tests

Cover:

- A valid save writes all changed fields to SQLite.
- Runtime state is updated only after persistence succeeds.
- The main plugin observes the changed value without process restart.
- A database failure leaves runtime state unchanged.
- A runtime-registry failure triggers a safe database re-read on the next operation.

### Step 2: Run focused tests

Expected: FAIL because the cross-bundle runtime bridge does not exist.

### Step 3: Implement the durable-first save flow

Use this ordering:

```text
validate -> transactionally persist -> update globalThis registry -> notify UI
```

Use a stable `Symbol.for(...)` key or equivalent registry namespace shared by the main and TUI bundles. Keep the registry payload small and versioned. SQLite remains the source of truth; registry updates are an immediate-consistency optimization.

### Step 4: Run focused tests and the existing persistence suite

Expected: PASS without modifying production database paths used by existing tests.

### Step 5: Commit the work unit

```text
feat: apply tui model edits immediately
```

---

## Task 6: Add quarantine screens and actions

**Files:**
- Create or modify: `src/tui/quarantine-view.tsx`
- Modify: existing quarantine repository/service
- Test: `tests/tui-quarantine.test.ts`

### Step 1: Write failing tests

Cover provider, model, and provider/model connection scopes; expiration; permanent quarantine; release confirmation; and empty states.

### Step 2: Run focused tests

Expected: FAIL until the quarantine view is connected to persistence.

### Step 3: Implement the unified quarantine table

- Display scope, target, expiration, and status.
- Support create, inspect, and release actions.
- Require confirmation for release and destructive changes.
- Reuse the existing quarantine fields and repository boundary.

### Step 4: Run focused tests

Expected: PASS.

### Step 5: Commit the work unit

```text
feat: manage model quarantines in tui
```

---

## Task 7: Verify packaging, collisions, and end-to-end behavior

**Files:**
- Modify: `package.json` or build configuration if required
- Test: `tests/tui-integration.test.ts`
- Test: existing verification suites

### Step 1: Add integration coverage

Verify the complete flow:

```text
Ctrl+Alt+F -> Models -> provider -> model -> edit -> Ctrl+S -> runtime observes change
```

Also verify opening Quarantines and returning to the main menu.

### Step 2: Verify host shortcut behavior

Run the integration test against the supported OpenCode host API and document whether `Ctrl+Alt+F` overrides or coexists with the host binding. Do not silently change the requested shortcut.

### Step 3: Run all verification gates

Run the repository's test, typecheck, and build commands. Confirm the main plugin export remains callable and the `./tui` bundle is generated.

### Step 4: Review the final diff

Check that the change is scoped to the TUI, runtime bridge, persistence adapters, tests, and package/build metadata. Do not include generated databases or secrets.

### Step 5: Commit the final verification work unit

```text
test: verify model control center tui integration
```
