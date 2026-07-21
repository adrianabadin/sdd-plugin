# Connected Model Refresh and Display Design

## Goal

Implement the first operational layer of the OpenCode plugin: every time a `task` tool execution is detected, refresh the locally persisted model catalog from the OpenCode SDK and display the connected models without changing task routing yet.

## Architecture

The plugin remains an OpenCode plugin entrypoint exporting hooks. The `tool.execute.before` hook intercepts `task` calls and invokes a model synchronization service before OpenCode dispatches the task.

The persistence layer uses Prisma and SQLite with normalized entities:

- `Provider`: provider identity, subscription metadata, global quarantine metadata, and provider-level block status.
- `Model`: model identity, benchmark scores, and global model quarantine metadata.
- `ModelProvider`: model/provider availability relationship and connection-level quarantine metadata.
- `ModelProviderPricing`: pricing data for a model/provider relationship.

The synchronization is idempotent. Providers, models, relationships, and pricing records are created or updated with `upsert`. Existing quarantine, subscription, benchmark, and pricing values are preserved unless explicit new data is available.

## Data Flow

1. OpenCode loads the plugin.
2. The plugin resolves the absolute SQLite database path and initializes Prisma.
3. A `task` tool call reaches `tool.execute.before`.
4. The plugin requests the current provider/model list from the OpenCode SDK.
5. Each SDK record is normalized into provider and model identifiers.
6. Prisma upserts `Provider`, `Model`, and `ModelProvider` records.
7. Pricing metadata is created or updated when SDK/provider metadata supplies it.
8. The plugin logs the refreshed connected model list through OpenCode's application logging API.
9. The original `task` arguments continue unchanged.

## Pricing Model

Pricing is attached to `ModelProvider`, because cost varies by provider for the same underlying model. The pricing entity stores:

- `inputPerMillion`
- `outputPerMillion`
- `cachedPerMillion`
- `currency`
- `effectiveFrom`
- `effectiveUntil`

`null` pricing fields mean the value is unknown. The plugin must not invent provider pricing. Pricing updates preserve the previous effective record when incoming data is missing.

## Subscription Metadata Strategy

Subscription information is not inferred from model names. It should be sourced in this order:

1. Explicit plugin configuration.
2. A local provider metadata configuration file.
3. Provider APIs that expose plan/quota information.
4. `null`, interpreted as API/pay-as-you-go.

For this slice, existing subscription values are preserved and no automatic inference is attempted.

## Error Handling

Synchronization errors are logged but must not prevent the intercepted `task` from executing. The first implementation is observational: it refreshes and displays data only.

## Testing and Verification

- Run `npx prisma db push`.
- Run `npx prisma generate`.
- Run `npx tsc`.
- Confirm the hook performs refresh logic only for `input.tool === "task"`.
- Confirm task arguments are not modified.
