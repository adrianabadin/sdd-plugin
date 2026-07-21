# Task 2 Design: Main Menu & Keyboard Navigation

**Change**: model-control-center-tui | **Scope**: navigation foundation only | **Route**: native OpenCode TUI route `model-control-center` from Task 1 (unchanged)

## Technical Approach

One host route, one internal screen state machine. The host route `model-control-center` renders a single root component (`ModelControlCenter`) that holds screen state in Solid signals and dispatches keyboard commands through a mode-scoped keymap layer. Screens are internal states, NOT additional host routes — this keeps host registration (Task 1) stable and lets Esc/history live entirely inside the plugin.

## Screen / State Contract (user-visible)

On `Ctrl+Alt+F` the user sees the **Model Control Center main menu**:

```
Model Control Center
> Models
  Quarantines

↑/↓ move · Enter open · Esc close
```

- `Models` and `Quarantines` are the only menu entries, in fixed order.
- Selecting an entry and pressing `Enter` pushes the corresponding screen (`providers` via Models; `quarantines`). Unimplemented screens render a clearly labeled placeholder panel ("Coming in Task N") so push/pop navigation is testable end-to-end now.
- `Esc` returns to the previous screen; on the main menu it exits the route back to the route captured on entry.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Screen modeling | Discriminated-union state machine + stack, pure reducer `transition(state, event)` | Component nesting, one host route per screen | Deterministic, unit-testable without a renderer; host route stays single (Task 1 contract) |
| Keyboard ownership | Second `keymap.registerLayer` scoped to mode `"model-control-center"`, registered in route render, disposed via `onCleanup` | Global base-mode layer; per-component `useKeyboard` | Mode is already pushed by Task 1, so bindings only fire while the route is active; zero host collisions |
| Screen components | Thin Solid components per screen; all navigation logic in the reducer | Logic inside components | Matches project hexagonal style: pure core, thin adapters |
| Exit target | Capture `api.route.current.name` on entry; Esc at root navigates there | Hardcode `"home"` | Works regardless of where the user opened the TUI from |

### State machine

```
Screen = { name:"main-menu" }
       | { name:"providers" }
       | { name:"models", providerId }
       | { name:"model-detail", providerId, modelId, tab: DetailTab }
       | { name:"quarantines" }
DetailTab = "overview" | "benchmarks" | "pricing" | "subscription"  (fixed cyclic order)

main-menu --Enter(Models)--> providers --Enter--> models --Enter--> model-detail
main-menu --Enter(Quarantines)--> quarantines
any screen --Esc--> previous stack entry; empty stack --> exit route
```

Task 2 implements `main-menu` fully; `providers`/`models`/`model-detail`/`quarantines` exist in the union and reducer but render placeholders.

## Keyboard Binding & Focus Rules

Owned by the mode-scoped layer (`mode: "model-control-center"`, priority above the base layer):

| Key | Command | Behavior |
|---|---|---|
| `up` / `down` | `mcc.nav.up` / `mcc.nav.down` | Move menu selection, cyclic wrap; no-op outside list screens |
| `enter` | `mcc.nav.activate` | Activate selection: push target screen |
| `esc` | `mcc.nav.back` | Pop stack; at root, navigate to captured exit route |
| `tab` | `mcc.nav.tab-next` | Advance `DetailTab` cyclic (overview→benchmarks→pricing→subscription); **no-op on main menu** |
| `shift+tab` | `mcc.nav.tab-prev` | Reverse tab order; **no-op on main menu** |

Focus rules: exactly one focused element per screen (the menu list on main-menu; the tab strip on model-detail). No focus trapping, no global Tab capture — Tab only acts when the current screen declares a tab order, keeping host behavior intact elsewhere.

## Data Flow

```
key event → keymap layer → command run() → dispatch(event)
          → transition(screen, event) (pure) → Solid signal update
          → root component re-renders active screen
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/tui/navigation.ts` | Create | Screen union, DetailTab order, pure `transition()` reducer, stack helpers |
| `src/tui/ModelControlCenter.tsx` | Create | Route root: signals, dispatch, mode-scoped keymap layer, screen switch |
| `src/tui/MainMenu.tsx` | Create | Menu list render + selection highlight |
| `src/tui.ts` | Modify | Route render mounts `ModelControlCenter` instead of `renderPlaceholderRoute` |
| `tests/tui-navigation.test.ts` | Create | tsx assertion script (repo convention) |

## Rendering / Loading / Empty / Error (menu only)

| State | Render |
|---|---|
| Loading | One-frame "Loading…" while the root mounts; menu is static so this is transient |
| Ready | Menu with selection cursor on first entry |
| Empty | Defensive: if the section list is ever empty, show "No sections available" + Esc hint |
| Error | Reducer returning an invalid transition renders an error panel with "Esc to close"; navigation never throws |

## Test-First Scenarios (`tests/tui-navigation.test.ts`)

- **Given** the route is mounted, **when** it renders, **then** the menu shows `Models` and `Quarantines` in order with `Models` selected.
- **Given** the main menu, **when** `down` is dispatched, **then** selection moves to `Quarantines`; **when** `down` again, **then** it wraps to `Models`.
- **Given** `Models` selected, **when** `enter`, **then** state is `providers` and its placeholder renders.
- **Given** a pushed screen, **when** `esc`, **then** state returns to `main-menu` with prior selection preserved.
- **Given** the main menu (empty stack), **when** `esc`, **then** the route navigates to the entry-captured route.
- **Given** `model-detail` with tab `overview`, **when** `tab`, **then** tab becomes `benchmarks`; **when** `shift+tab` from `overview`, **then** it wraps to `subscription`.
- **Given** the main menu, **when** `tab`/`shift+tab`, **then** state is unchanged.
- **Given** route leave, **when** Solid cleanup runs, **then** the keymap layer is disposed (mirrors Task 1 mode pop).

## Migration / Rollout

No migration. Rollback: revert the single commit; Task 1 route/placeholder remains valid because all Task 2 surface area is additive except swapping the route render body.

## Risks

- Keymap layer mode scoping depends on the host honoring `mode: "model-control-center"` layers — mitigated by the disposal test and Task 1's proven mode push/pop.
- Tab capture could shadow host Tab if the layer leaks; mitigated by scoping Tab to screens with a declared tab order and by cleanup tests.

## Non-Goals (explicit)

Providers screen content, model list/search, model-detail content and forms, metadata persistence, cross-bundle runtime bridge, and quarantines implementation are **out of scope** — later tasks own them.

## Open Questions

- None blocking. Confirm host supports `shift+tab` key string normalization during implementation; if not, bind the host-canonical spelling.
