# Task 6 Design: Quarantine Management

**Scope:** Add the Quarantines screen and immediate quarantine effects. SQLite remains the source of truth; no provider/model browser redesign.

## Architecture

Use a dedicated `QuarantineStore` beside the Task 5 model-config registry, shared through:

```ts
Symbol.for("sdd-plugin.quarantine-store.v1")
```

The store is a write-through runtime cache. Both bundles hydrate it from SQLite and publish only after a successful transaction. The main plugin consults it during task interception; if unavailable, interception safely skips the quarantine gate and falls back to existing behavior.

## Scope model

Quarantine entries have one explicit level:

- `provider`: blocks every model from a provider.
- `model`: blocks a model across providers.
- `modelProvider`: blocks one provider/model connection.

Resolution precedence is `provider > model > modelProvider`. A provider-level permanent quarantine therefore overrides a model-level TTL. TTL is active while `now < quarantineUntil`; release clears both quarantine columns.

## User flow

```text
Main menu -> Quarantines
  ├── list active/all entries
  ├── Add quarantine
  │   ├── choose level and target
  │   ├── choose TTL or permanent
  │   └── confirm
  └── Release quarantine -> confirmation -> persist -> publish
```

The list shows scope, target, status, expiry, and actions. Expired TTL entries are inactive and are not treated as blocking. Release and destructive changes require confirmation.

## Contracts

```ts
interface SetQuarantineCommand {
  level: "provider" | "model" | "modelProvider"
  providerId?: string
  modelId?: string
  type: "ttl" | "permanent"
  until: Date | null
}

interface QuarantineStore {
  hydrate(entries: QuarantineEntry[]): void
  publish(entry: QuarantineEntry): void
  release(target: QuarantineTarget): void
  isActive(providerId: string, modelId: string, now?: Date): boolean
  snapshot(): readonly QuarantineEntry[]
}
```

Persistence uses a dedicated `QuarantineWritePort` and use cases for list, set, and release. Writes are transactional and ordered:

```text
validate -> SQLite transaction -> QuarantineStore publish/release -> UI notice
```

Runtime publication failure keeps the database commit and causes the next interception to rehydrate from SQLite.

## UI and keyboard behavior

The screen uses the existing route mode and navigation stack. The list has one focused row; `up/down` moves cyclically, `Enter` opens details/actions, and `Esc` returns. Add/release forms use `Tab`/`Shift+Tab`, `Enter` confirms, and `Esc` cancels. Confirmation is explicit and defaults to cancel.

Loading, empty, expired-only, invalid-input, database-failure, and publish-warning states are rendered without throwing.

## Files

- Create `src/ports/quarantine-write.port.ts`.
- Create pure helpers under `src/domain/model/quarantine.ts` for TTL calculation and active/precedence resolution.
- Create `src/application/quarantine/` list/set/release use cases.
- Create `src/infrastructure/runtime/quarantine-store.ts`.
- Extend the Prisma adapter with transactional quarantine writes and list queries; no schema migration is required because fields already exist.
- Replace the Quarantines placeholder with `src/tui/QuarantinesScreen.tsx` and `src/tui/quarantine-view.ts`.
- Extend `src/tui/navigation.ts`, `src/tui/ModelControlCenter.tsx`, and `src/tui.ts` wiring.
- Add focused tests for domain resolution, store behavior, persistence, interception gating, and TUI actions.

## Test scenarios

- Provider, model, and modelProvider entries render and persist at their declared scope.
- Provider precedence overrides model and connection entries.
- TTL expires exactly at the injected clock boundary; permanent entries remain active.
- Release clears both quarantine fields and removes runtime blocking.
- Invalid target/TTL input blocks save without mutation.
- Database failure leaves the runtime store unchanged.
- Runtime publish failure keeps the database commit and rehydrates on next interception.
- Empty, expired-only, and malformed data render safe states.
- Two concurrent writes for the same target are serialized/deduplicated.

## Rollback and non-goals

No migration is needed. Rollback reverts the quarantine store/use cases/UI and leaves nullable existing columns untouched. Automatic quarantine, provider discovery changes, model metadata editing, and final packaging verification are out of scope.

## Risks

- Clock drift is mitigated with an injected clock.
- Cross-bundle drift is mitigated with a Symbol-keyed store and DB rehydration fallback.
- A missing store must never break task interception.
