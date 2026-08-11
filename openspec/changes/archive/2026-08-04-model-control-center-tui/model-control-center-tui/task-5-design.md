# Task 5 Design: Durable Model-Detail Persistence & Live Runtime Application

**Change**: model-control-center-tui | **Scope**: persist Task 4 draft edits durably + apply to the running plugin without restart | **Base**: Task 4 draft/validation/dirty model, Task 2/3 navigation (unchanged)

## Technical Approach

Add a write path behind the existing port architecture: a `SaveModelDetailUseCase` validates the draft (domain-owned rules), then persists ALL editable fields in ONE Prisma `$transaction` with SQLite as source of truth, then publishes the effective config to a process-wide `globalThis` registry shared by `dist/tui.js` and `dist/bootstrap/index.js`. The main plugin's `task` interception reads registry-first with DB read-through fallback — edits apply immediately and survive process restarts.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Schema gap (Task 4 open question) | **Versioned JSON envelope**: add ONE `metadata String?` column to `Provider` and `Model`. Envelope `{version: 1, ...}`: Model owns contextWindow/maxOutputTokens/capabilities; Provider owns planName/periodicCost/includedUsage/overageRate | 8+ new typed columns across 2 tables; separate metadata table | Metadata is sparse, evolving, and never relationally filtered — typed columns cost a migration per new field; one envelope = one additive migration forever, corrupt-safe parse at adapter boundary. **Tradeoff accepted**: no DB-level constraints → validation owned by use case + pure parser |
| Write boundary | New `ModelDetailWritePort.saveModelDetail` + `SaveModelDetailUseCase`; Prisma adapter gains ONE transactional method | Reuse `ModelRepositoryPort` upserts | Refresh port has preserve-missing semantics keyed to SDK snapshots; manual save needs cross-entity atomicity + optimistic guard — a different contract |
| Validation ownership | Pure validators promoted from `src/tui/detail-validation.ts` to `src/domain/model-detail/`; tui file becomes a re-export shim; use case re-validates (never trust the UI) | TUI-only validation; duplicated rules | TUI validators = UX layer; use case = last line of defense; shim keeps Task 4 imports/tests green |
| Runtime bridge | `Symbol.for("sdd-plugin.model-config-registry.v1")` on `globalThis` → `{revision, entries: Map<"pid/mid", EffectiveModelConfig>, publish/get/subscribe}`, created by whichever bundle loads first | Event emitter module (breaks across bundle boundaries); file watch; SDK config write-back | Symbol registry follows the reference bundle-sharing pattern and avoids string-key collisions; both bundles share one process; registry is a write-through cache, SQLite stays source of truth |
| Ordering | validate → persist transaction → registry.publish → UI notify | Publish before persist | Durable-first: publish failure never rolls back a committed save; interception falls back to DB read |
| Pricing edits | Insert a NEW `ModelProviderPricing` row (`effectiveFrom = now()`) per save | Update latest in place | Schema is already versioned by `effectiveFrom`; history = free audit trail and rollback |
| Stale writes | Optimistic guard using a canonical metadata envelope hash stored separately on Provider/Model; count=0 → conflict, re-read, notice | Raw `updatedAt`; last-write-wins | Refresh currently bumps `updatedAt` unconditionally, so it would reject valid manual edits. A user-envelope hash is stable across SDK refreshes and detects competing manual saves |

## Data Flow

```
ctrl+s → validateDraft (domain) → SaveModelDetailUseCase
  → $transaction[provider+metadata, model+metadata, link upsert, pricing insert]  (guarded by envelope hash)
  → registry.publish(EffectiveModelConfig) → notice "Saved & applied"

task interception (main bundle, no restart):
  registry.get(pid/mid) ?? detailQuery.findModelDetail(pid,mid) → registry.publish → model allocation
```

## Interfaces / Contracts

```ts
// src/ports/model-detail-write.port.ts
export interface SaveModelDetailCommand {
  providerId: string; modelId: string;
  provider: { name: string; isBlocked: boolean; subscription: string | null; metadata: ProviderMetadata };
  model: { name: string; benchmarks: BenchmarkScores; metadata: ModelMetadata };
  pricing: { inputPerMillion: number | null; outputPerMillion: number | null;
             cachedPerMillion: number | null; currency: string } | null;
   expectedEnvelopeHash: string | null; // stable manual-save guard from loaded baseline
}
export interface ModelDetailWritePort {
  saveModelDetail(cmd: SaveModelDetailCommand): Promise<{ updatedAt: Date }>;
}

// src/infrastructure/runtime/model-config-registry.ts
export interface ModelConfigRegistry {
  readonly revision: number;
  publish(c: EffectiveModelConfig): void;
  get(providerId: string, modelId: string): EffectiveModelConfig | undefined;
  subscribe(fn: (c: EffectiveModelConfig) => void): () => void;
}
 export function getOrCreateModelConfigRegistry(): ModelConfigRegistry; // Symbol.for/globalThis-backed
```

`PersistedModelDetail` gains `providerMetadata`, `modelMetadata`, `updatedAt`, and envelope hashes; `mergeModelDetail` maps them (drops the "pending schema (Task 5)" flags). Provider and Model gain nullable `metadataEnvelopeHash` columns that refresh never mutates.

## File Changes

| File | Action | Description |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `metadata String?` to Provider + Model (one additive migration) |
| `src/domain/model-detail/metadata.ts` | Create | Envelope types, version constant, corrupt-safe parse/serialize |
| `src/domain/model-detail/detail-validation.ts` | Create (move) | Pure validators promoted from tui |
| `src/tui/detail-validation.ts` | Modify | Re-export shim (Task 4 compat) |
| `src/ports/model-detail-write.port.ts` | Create | Write contract above |
| `src/ports/model-detail-query.port.ts` | Modify | Add metadata + updatedAt to `PersistedModelDetail` |
| `src/application/save-model-detail/` | Create | Use case: validate → command → port → publish |
| `src/infrastructure/prisma/prisma-model-repository.adapter.ts` | Modify | Implement write port via `$transaction`; extend `findModelDetail` |
| `src/infrastructure/runtime/model-config-registry.ts` | Create | globalThis registry |
| `src/infrastructure/runtime/database-path.ts` | Create | Shared DB path resolution — **fixes tui.ts (cwd) vs bootstrap (dist-relative) divergence** |
| `src/bootstrap/index.ts` | Modify | Interception consumes registry with DB read-through fallback |
| `src/tui.ts` | Modify | Shared db path; wire save use case + registry |
| `src/tui/ModelControlCenter.tsx` | Modify | save-intent → use case; conflict re-read; success/warn notices |
| `src/tui/model-detail-view.ts` | Modify | Map metadata fields in `mergeModelDetail` |
| `src/index.ts` | Review/remove | Remove or isolate the legacy duplicate plugin entry so package exports have one authoritative runtime path |

## Testing Strategy (Given/When/Then — tsx assertion-script convention)

| # | Given | When | Then |
|---|---|---|---|
| 1 | Valid dirty draft | ctrl+s | Transaction commits, registry revision bumps, `get` returns new values, "Saved & applied" notice |
| 2 | Adapter throws on write | save | No publish, draft intact, baseline unchanged, error notice + `detail.save.failure` trace |
| 3 | `registry.publish` throws | save | DB commit kept, warn notice, `runtime.publish.failure` trace, later interception still reads DB |
| 4 | Only capabilities edited (no prior metadata) | save | Envelope v1 created, other metadata defaults, unrelated columns untouched |
| 5 | Committed save | fresh process (empty registry) + task interception | Effective config rehydrated from SQLite — no restart data loss |
| 6 | Concurrent SDK refresh bumps `updatedAt` but not user metadata hash | save | Save succeeds and preserves unrelated SDK fields |
| 7 | Baseline envelope hash stale from another manual save | save | Rejected with conflict notice, form re-reads persisted state |
| 8 | Runtime registry publish throws after DB commit | next task interception | DB read-through rehydrates the registry and applies the saved configuration |

## Observability

Reuse `ModelRefreshTraceLogger` with new stages: `detail.save.start/finish/failure`, `runtime.publish.*`, `runtime.hydrate.*`, all with correlationId.

## Migration / Rollback

Additive schema change via a committed Prisma migration adding nullable `metadata` and `metadataEnvelopeHash` columns to Provider and Model; back up `opencode-models.db` before applying. Rollback: revert commit + drop the four nullable columns — no data loss outside the new metadata. No feature flag: the write path is additive and interception degrades to pre-Task-5 behavior when metadata is absent.

## Non-Goals

Quarantine list/release UI, provider browser changes, final packaging verification, writing back to OpenCode SDK config (one-way DB→runtime only), relational queries over metadata fields.

## Open Questions

None blocking. Envelope v2 evolution rules deferred until a second metadata consumer exists.
