# Model Control Center Native Dialog Design

**Status:** Approved  
**Date:** 2026-07-23

## Context

The Model Control Center currently opens by navigating to a custom full-screen
OpenCode route. The route is stable after a fresh build, but replacing the host
screen does not preserve OpenCode's normal visual context. The user selected a
native dialog presentation instead.

## Goals

- Open Model Control Center through OpenCode's native dialog stack.
- Preserve the complete existing flow: main menu, providers, models, model
  detail, and quarantines.
- Preserve internal back navigation: Escape returns to the previous internal
  screen and closes the dialog only from the main menu.
- Keep existing catalog, metadata, quarantine, and model-use-case boundaries.
- Dispose dialog-scoped mode and keymap registrations when the dialog closes.

## Non-Goals

- Redesigning the individual screen content.
- Changing persistence, catalog discovery, or model-management behavior.
- Treating the previously observed Bun crash as reproducible; the rebuilt
  production route survived a 75-second real-host probe.

## Considered Approaches

### 1. Preserve the state machine inside one native dialog — selected

Open the existing `ModelControlCenter` tree through `api.ui.dialog.replace` and
retain its discriminated-union navigation state.

**Advantages:** smallest behavioral change, preserves all implemented screens,
keeps navigation rules centralized, and matches OpenCode's host-owned dialog
lifecycle.

**Trade-off:** the component must expose a close callback and return its active
screen reactively rather than calculating it once.

### 2. Rebuild every screen as a separate imperative dialog

Use a chain of `api.ui.dialog.replace` calls similar to the reference plugin.

**Rejected:** it would duplicate navigation transitions and unnecessarily
rewrite the existing screen state machine.

### 3. Keep the full-screen route and restyle it

**Rejected:** styling cannot preserve the host screen underneath because route
navigation intentionally replaces it.

## Architecture

The base-mode command remains the entry point. Its handler opens a native
dialog instead of navigating to `model-control-center`.

The dialog render callback:

1. Pushes the `model-control-center` mode.
2. Registers cleanup that pops the mode.
3. Mounts `ModelControlCenter` with its existing ports and use cases.
4. Passes an `onClose` callback that clears the host dialog.

`ModelControlCenter` retains its internal screen stack and dialog-scoped keymap
layer. Its active screen is exposed through a reactive accessor so stack and
tab changes update the visible frame.

The custom route registration and route-specific cleanup are removed.

## Navigation

- `Alt+Shift+M`: opens the native dialog.
- Arrow keys: update selection within the active screen.
- Enter: advances to the selected internal screen or action.
- Escape on a nested screen: dispatches the existing back transition.
- Escape on the main menu: invokes `onClose` and clears the native dialog.
- Closing the dialog through the host also disposes its mode and keymap layer.

## Data and Error Flow

Catalog and metadata dependencies remain unchanged. Existing loading, empty,
and error states continue to render through host UI components. The migration
does not introduce new persistence or network behavior.

If optional ports are unavailable, the current graceful fallback behavior is
preserved. Dialog cleanup must not depend on successful catalog or database
operations.

## Testing Strategy

Strict TDD applies.

1. Add a failing registration test proving the command opens
   `api.ui.dialog.replace` instead of navigating to a custom route.
2. Add behavior tests for nested Escape/back and root Escape/close.
3. Add a renderer test proving navigation changes visible content reactively.
4. Verify mode and keymap disposers run exactly once on close.
5. Run the production dialog through OpenTUI under Bun 1.3.14.
6. Build and run focused TUI, export, typecheck, and integration gates.
7. Launch OpenCode with an auto-open diagnostic plugin and verify native dialog
   styling, visible content, and runtime stability.

## Delivery

This is a focused migration. No commit is created automatically; repository
integration remains an explicit maintainer action.
