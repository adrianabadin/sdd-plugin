# Model Control Center TUI Design

## Status

Draft approved for planning. Implementation has not started.

## Goal

Provide a native OpenCode TUI opened with `Ctrl+Alt+F` for browsing and manually configuring connected model metadata and managing quarantines.

## User flow

```text
Ctrl+Alt+F
  ├── Models
  │   ├── Connected providers
  │   ├── Provider model list and search
  │   └── Model detail
  │       ├── Overview
  │       ├── Benchmarks
  │       ├── Pricing
  │       └── Subscription
  └── Quarantines
```

Model detail sections are navigated with `Tab` and `Shift+Tab`. Forms use `Enter` to edit or confirm, `Ctrl+S` to save, and `Esc` to cancel or go back.

## UI architecture

The implementation uses OpenCode's native plugin TUI route and a plugin-specific mode:

- Register `Ctrl+Alt+F` through `api.keymap.registerLayer`.
- Navigate to a plugin route for the Model Control Center.
- Push a plugin-specific mode while the route is active.
- Register route-specific bindings for navigation, editing, saving, and closing.
- Keep the TUI in a separate `dist/tui.js` bundle, isolated from the main plugin entrypoint.

The UI copy remains English to match the existing technical project conventions.

## Immediate runtime application

Saving a form performs the following sequence:

1. Validate the edited values.
2. Persist the change in SQLite through the existing Prisma/LibSQL repository boundary.
3. Update the shared runtime state used by the plugin.
4. Display a success or validation message.

The next model-routing or task-interception operation must observe the new values without restarting OpenCode. SQLite remains the durable source of truth; the shared runtime state is an immediate-consistency bridge between the TUI bundle and the main plugin bundle.

## Model metadata

The editor must support, at minimum:

- Provider and model identifiers.
- Display name and status.
- Context-window and maximum-output limits.
- Capabilities: text, vision, tools, and reasoning.
- Benchmark values: MMLU, GPQA, SWE-bench, HumanEval, Math, BBH, MT-Bench, and other schema-supported metrics.
- Pricing: input, output, cached-input, currency, and pricing unit.
- Subscription: enabled state, type, plan, periodic cost, included usage, and overage pricing.

Incomplete metadata is shown with a warning indicator so manually configured gaps are visible.

## Quarantine management

Quarantines are presented in a unified table with explicit scope:

- Provider-wide quarantine.
- Model-specific quarantine.
- Provider/model connection quarantine.

Each entry shows target, expiration, status, and actions to inspect, create, or release a quarantine. Destructive or release actions require confirmation.

## Runtime and persistence constraints

- The OpenCode root plugin export must remain a callable plugin factory.
- TUI exports must remain isolated through the package export for `./tui`.
- The implementation must preserve the existing Bun-compatible Prisma LibSQL adapter.
- Cross-bundle state sharing must use a stable mechanism, such as a `globalThis` registry, while every durable update is written to SQLite.
- Keymap collision behavior for `Ctrl+Alt+F` must be tested against the host binding before release.

## Error handling

- Invalid numeric, pricing, benchmark, or subscription values remain in the editor and show an inline validation error.
- Database failures leave the editor open, show a failure notification, and do not update runtime state.
- Runtime-state update failures are logged and followed by a database re-read on the next operation.
- Closing with unsaved changes prompts for save, discard, or cancel.

## Verification scope

- Shortcut opens and closes the route without affecting normal input.
- Provider and model search are deterministic and keyboard navigable.
- `Tab` and `Shift+Tab` move between sections and form fields correctly.
- Save persists every supported metadata group.
- Saved values are observed immediately by the main plugin path.
- Quarantine scope, expiration, release, and confirmation behavior are covered.
- Main plugin loading remains valid when the TUI bundle is present.
