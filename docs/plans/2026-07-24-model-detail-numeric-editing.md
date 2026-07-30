# Model Detail Numeric Editing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `test-driven-development` and execute each task RED-GREEN. Preserve the existing dirty working tree and do not commit.

**Goal:** Allow users to edit numeric Benchmark and Pricing fields from the Model Control Center TUI instead of leaving `null` unchanged.

**Architecture:** Keep the existing modeless priority-200 keymap and immutable `DetailDraft`. Add an explicit numeric edit session owned by `ModelControlCenter`: Enter starts editing the focused supported field, numeric keys update a buffer, Enter commits through `updateField`, and Escape cancels. Centralize the supported tab/index-to-draft-field mapping so rendering and mutation cannot drift.

**Tech Stack:** TypeScript, SolidJS, OpenCode TUI keymap API, OpenTUI Solid renderer, existing assertion-script tests.

**Scope:** Benchmarks and Pricing numeric fields only. Text, boolean, Overview, and Subscription editing remain unchanged.

---

### Task 1: Specify the numeric edit session

**Files:**
- Create or modify a focused pure TUI helper under `src/tui/`
- Test in a focused TUI test file under `tests/`

1. Write failing tests for starting from `null`, appending digits, accepting one decimal separator, Backspace, Escape cancellation, and Enter commit.
2. Run the focused test and confirm RED failures are caused by the missing edit-session behavior.
3. Implement the smallest pure buffer/session functions needed by the tests.
4. Run the focused test and confirm GREEN.

### Task 2: Map focused Benchmark/Pricing fields to draft updates

**Files:**
- Modify: `src/tui/ModelDetailScreen.tsx`
- Modify: `src/tui/model-detail-view.ts` only if its public update contract needs a typed field identifier
- Create or modify a shared field-descriptor module under `src/tui/`
- Test the descriptor/update behavior under `tests/`

1. Write failing tests proving each Benchmark and Pricing field index maps to the correct `DetailDraft` path.
2. Confirm RED.
3. Centralize descriptors and reuse them for screen rendering and edit commits.
4. Confirm GREEN and preserve current field order and labels.

### Task 3: Connect real key commands to the draft

**Files:**
- Modify: `src/tui/ModelControlCenter.tsx`
- Modify: `src/tui/ModelDetailScreen.tsx`
- Modify relevant TUI registration/navigation tests

1. Write failing behavior tests for `Enter -> 1 -> 2 -> . -> 5 -> Enter`, asserting a focused `null` numeric field becomes `12.5` in the rendered/draft state.
2. Add failing tests proving Escape cancels and a second decimal separator does not corrupt the draft.
3. Run tests and confirm RED before production changes.
4. Add edit-session state and keymap commands/bindings for `0`-`9`, `.`, Backspace, Enter, and Escape.
5. While editing, intercept Enter/Escape before normal navigation; outside editing, preserve all existing navigation behavior.
6. Commit a valid parsed number via `updateField`; keep invalid/incomplete input in the buffer and surface validation without mutating the draft.
7. Render an explicit editing indicator/buffer and update the keyboard help text.
8. Run focused tests and confirm GREEN.

### Task 4: Regression and host-boundary verification

**Files:**
- Modify only tests required to prove behavior

1. Run focused numeric-edit tests.
2. Run `npm run test:tui`.
3. Run `npm run test:tui:bun`.
4. Run `npm run test:integration`.
5. Run `npm run test:typecheck:strict` and `npm run build`.
6. Exercise the real TUI keyboard path when the existing PTY fixture supports entering model detail; otherwise report that host-level evidence remains manual and do not overclaim it.
7. Inspect `git diff` and verify no unrelated dirty files were overwritten.

### Acceptance Criteria

- A `null` Benchmark or Pricing value can be changed using only the keyboard.
- Enter starts and commits editing; Escape cancels; Backspace edits the buffer.
- Only digits and one decimal separator are accepted.
- Committing updates the immutable draft and makes the tab dirty; `Ctrl+S` keeps its existing validation/persistence semantics.
- Navigation outside edit mode is unchanged.
- No text, boolean, Overview, or Subscription editing is added.
- Regression tests prove the previously missing keystroke-to-draft boundary.
