# Task 7 Design: Final Integration and Packaging

**Scope:** Validate and harden the completed Model Control Center TUI without adding product features.

## Acceptance flows

```text
Alt+Shift+M
  -> Models
  -> connected provider
  -> model
  -> detail tab/edit
  -> Ctrl+S
  -> SQLite transaction
  -> globalThis registry
  -> next task observes updated configuration
```

The acceptance suite also covers:

```text
Main menu -> Quarantines -> set/release -> SQLite -> QuarantineStore -> interception gate
```

## Packaging contract

- The package root MUST remain a callable server/plugin factory.
- `package.json.exports["./tui"]` MUST resolve the TUI module `{ id, tui }`.
- Public export tests MUST use package self-references after build, not source or direct `dist` paths.
- TUI rendering MUST be validated under Bun/OpenTUI through the dedicated renderer test.
- Node tests MAY cover host contracts and pure logic, but MUST NOT claim to validate native OpenTUI rendering.

## Verification matrix

| Gate | Command/environment | Required result |
|---|---|---|
| Build | `npm run build` | TypeScript succeeds |
| Strict test typecheck | `npm run test:typecheck:strict` | Tests compile with library checks enabled |
| Host/TUI logic | `npm run test:tui` | Navigation, lifecycle, catalog, detail, quarantine tests pass |
| Public exports | `npm run test:exports` after build | Root and `./tui` self-references load |
| Node regression | `npm test` | All non-native suites pass |
| Native renderer | `npm run test:tui:bun` under Bun | Captured frame contains the route title/message |
| CI | `.github/workflows/ci.yml` | Node and Bun gates are required |

## Runtime and collision checks

- Register the **verified-free** mnemonic `alt+shift+m` ("Model") in the base layer only. The legacy `ctrl+alt+f` is known to collide with OpenCode 1.18.4's built-in `messages_page_down` (the host keymap owns that binding), so it MUST NOT be re-registered by the plugin. Integration tests assert `alt+shift+m` is bound on the base layer AND that `ctrl+alt+f` is absent from every layer (regression guard).
- Verify route-specific layers and modes are removed on route leave and plugin unload.
- Open and close the route repeatedly to detect duplicate registrations or stale globalThis listeners.
- Verify a missing registry/store never breaks task interception; SQLite read-through remains the fallback.

## Database and release safety

- Apply the committed Prisma migration only to the configured project database.
- Use the shared database-path resolver; tests MUST use isolated test databases.
- Confirm `.env`, production databases, `node_modules`, `dist`, and generated artifacts are not staged.
- Verify migration rollback and that nullable metadata/quarantine fields preserve existing rows.

## Test-first integration scenarios

- A full model edit persists and is visible to the next task without restart.
- A publish failure still leaves the durable save and rehydrates on the next interception.
- A quarantine blocks the correct scope and release removes the block immediately.
- Repeated route open/close cycles leave no mode, keymap, listener, or registry leak.
- Public root/TUI exports remain callable/loadable after build.
- Unsupported Node native-render execution fails clearly while CI executes the Bun gate.

## Rollback and non-goals

Rollback is a commit-level revert followed by the documented Prisma migration rollback. No PR creation, push, merge, or new product behavior is part of this task. Remaining work is limited to evidence, packaging, and release safety.
