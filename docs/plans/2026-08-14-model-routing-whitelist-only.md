# Model Routing — Whitelist-Only + Effort Variants Implementation Plan

> **For the executing agent:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task-by-task. Do not batch phases.
>
> **Rev 2 (2026-08-14):** incorporates the approved effort-variant design (approach A: one generated subagent per model × normalized effort level; prefix-only routing; non-blocking warning for variant-less models).

**Goal:** Reduce model routing to a single rule — a Task dispatch is routed if and only if its canonical model appears in `config/model-routing/routes.json` and is not quarantined — and add natural-language effort selection (`low`/`medium`/`high`, default `low`) backed by per-variant generated subagents.

**Architecture:** `routes.json` is the only routing authority. Routed host agent names are derived deterministically from the route (`hashHostName`), one base agent plus one agent per normalized effort variant, so no manifest, catalog, attestation, or supervisor is consulted at dispatch. The plugin only ever targets generated files under the established prefixes (`sdd-mr-v1-*` agents, `sdd-mr-canary-v1-*` commands); the prefix alone never authorizes a route — the destination must map back to a whitelisted route and exist on disk. Quarantine is the only subtractive force: `permanent` removes the route at generation time, `ttl` leaves it generated but blocks it at dispatch time.

**Tech Stack:** TypeScript (NodeNext ESM), Node 24 + Bun, `tsx` test runner with `node:assert/strict`, Prisma 7.8 + libSQL (quarantine reads only), OpenCode SDK (variant discovery at generation time only).

---

## Authority model

```
routes.json          → decides WHICH models can be routed
variant snapshot     → decides WHICH effort levels each model exposes
quarantine permanent → removes the route before generation
quarantine ttl       → blocks the route at dispatch
(nothing else opines)
```

Dispatch order, replacing the previous 18-gate + 22-sub-gate pipeline:

```
parse (model + effort) → resolve(routes.json) → quarantine
  → pick agent (variant if available, else base + warning)
  → audit (best-effort) → rewrite subagent_type
```

## Effort model (NEW — approved approach A)

### Normalized levels

Exactly three normalized levels: `low`, `medium`, `high`. They are aliases over the model's **actual** OpenCode variant keys, never invented values.

Variant keys are ranked by the canonical effort order:

```
none < minimal < low < medium < high < xhigh < max
```

Mapping rules (per model, from its variant key set):

| Model variants | Generated agents | Mapping |
|---|---|---|
| 0 (no variants) | base only | any effort request → base agent + warning |
| 1 | base only | treated as "no variants" for effort purposes |
| 2 | `low`, `high` | `low` → lowest variant key, `high` → highest variant key |
| 3+ | `low`, `medium`, `high` | `low` → lowest, `high` → highest, `medium` → the key closest to the middle of the ranked list |

The generated agent's `variant:` frontmatter field always carries the **actual** variant key of the model (e.g. an Anthropic model with `high`/`max` gets `variant: high` for the normalized `low` agent and `variant: max` for the normalized `high` agent).

### Selection semantics

- **No effort mentioned → `low`.** Always.
- Effort may be requested two ways:
  - **Natural trigger** (same bounded parser family as model intent): `esfuerzo <nivel>`, `con esfuerzo <nivel>`, `effort <nivel>` — Spanish diacritic folding applies (`esfuerzo máximo` folds, but the level vocabulary is still the three normalized levels; unknown level words → clear error listing `low|medium|high`).
  - **Grammar extension** (optional 4th segment): `model-route:v1|sdd-mr-base|<modelReference>|<low|medium|high>`.
- Levels other than the three normalized ones (`xhigh`, `max`, `none`…) are NOT routable. The normalized tier is the whole vocabulary.

### No-variant models — non-blocking warning contract

- Dispatch is **never** blocked or cut because a model lacks variants.
- Behavior: route to the base agent, emit a warning.
- Warning surfaces in **both** places, without modifying the prompt bytes:
  1. `routing.audit.jsonl` — audit entry gets `effortRequested: <level>`, `effortApplied: null`, `effortFallbackReason: "MODEL_HAS_NO_VARIANTS"`.
  2. Logger warning (visible in the OpenCode session output): `[sdd-plugin.routing] model provider/model exposes no effort variants; dispatched base agent (requested: <level>)`.

### Naming scheme

```
base agent      .opencode/agents/sdd-mr-v1-<hash>.md
variant agents  .opencode/agents/sdd-mr-v1-<hash>-low.md
                .opencode/agents/sdd-mr-v1-<hash>-medium.md
                .opencode/agents/sdd-mr-v1-<hash>-high.md
canary command  .opencode/commands/sdd-mr-canary-v1-<hash>.md   (base only)
```

`<hash>` is the existing `hashHostName` digest — unchanged, so variant names are a pure suffix extension and old base names stay stable.

The `cap` in `routes.json` counts **routes (models)**, not generated files. 18 routes may legitimately produce ~50–70 files.

### Variant data source

- Variants are read **once at generation time** via the OpenCode SDK provider/model walk (same nested `provider.models` walk the model-refresh code already does; each model entry exposes `variants` keys gated by `capabilities.reasoning`).
- The result is persisted to `.opencode/sdd-model-routing/variants.json`:
  ```json
  { "providerId/modelId": { "levels": { "low": "high", "high": "max" } } }
  ```
  (mapping normalized level → actual variant key; absent entry = no variants)
- Dispatch NEVER queries the SDK. If `variants.json` is missing or stale, dispatch treats models as variant-less (base + warning) — routing still works.

### Error contract

| Code | Meaning | Raised at |
|---|---|---|
| `ROUTE_NOT_WHITELISTED` | canonical model is not in `routes.json` | dispatch |
| `QUARANTINED_MODEL` | active quarantine (any level) | dispatch |
| `ROUTED_AGENT_UNAVAILABLE` | whitelisted, but the target `.md` is missing on disk | dispatch |
| `EFFORT_LEVEL_UNKNOWN` | effort word is not `low\|medium\|high` | dispatch (parse) |
| `RouteUnknownError` / `RouteAmbiguousError` | reference could not be resolved to exactly one whitelist entry | dispatch |

Note: a whitelisted model **without** variants is NOT an error — it is the warning path above.

Removed entirely: `ROUTING_NOT_CONFIGURED`, `TASK_HOOK_BOOT_IDENTITY_MISSING`, `TASK_HOOK_SIGNING_KEY_MISSING`, `ATTESTATION_UNAVAILABLE`, `ATTESTATION_EXPIRED`, `ATTESTATION_MISMATCH`, `READINESS_SIGNING_KEY_MISSING`, `CATALOG_ROUTE_MISSING`, every `CanaryBlockedError` code, `ACL_RESTRICTION_FAILED`, and all foreign-agent provenance errors.

### Behavioural changes the operator will notice

1. Routing works in a plain `opencode` session. No supervisor, no env vars, no `secrets.json`.
2. OpenCode version is never checked. A version bump can no longer break routing.
3. A route in `routes.json` whose provider is not connected now **generates an agent that fails loudly on use**, instead of being silently dropped from the fleet.
4. Audit (`.opencode/sdd-model-routing/routing.audit.jsonl`) is still written but is best-effort: an audit failure logs and continues instead of blocking the dispatch.
5. Saying "usá Claude Opus 5" now lands on the `-low` variant agent by default; "con esfuerzo high" lands on `-high`.
6. Models without variants always work; asking effort of them logs a warning and uses the base agent.

---

## Phase 0 — Failing tests for the new contract

### Task 0.1: Whitelist loader tests

**Files:**
- Test: `tests/route-whitelist.test.ts` (create)

**Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadRouteWhitelist } from "../src/domain/model-routing/route-whitelist.js";
import { hashHostName } from "../src/domain/model-routing/model-route-host-naming.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-whitelist-"));
const configDir = path.join(tmp, "config", "model-routing");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, "routes.json"),
  JSON.stringify({
    schemaVersion: 1,
    generatorVersion: "1.1.0",
    cap: 32,
    routes: [
      { baseTemplate: "sdd-mr-base", providerId: "openai", modelId: "gpt-5.6-sol" },
      { baseTemplate: "sdd-mr-base", providerId: "anthropic", modelId: "claude-opus-5" },
    ],
  }),
);

const whitelist = loadRouteWhitelist(tmp);

assert.equal(whitelist.size, 2, "both routes are loaded");
assert.equal(
  whitelist.findHostName("openai", "gpt-5.6-sol"),
  hashHostName("sdd-mr-base", { providerId: "openai", modelId: "gpt-5.6-sol" }),
  "host name is derived deterministically from the route",
);
assert.equal(
  whitelist.findHostName("openai", "not-in-routes"),
  null,
  "a model absent from routes.json has no host",
);
assert.deepEqual(
  whitelist.searchNormalized("opus", 8).map((c) => `${c.providerId}/${c.modelId}`),
  ["anthropic/claude-opus-5"],
  "fuzzy search only ever returns whitelisted routes",
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("All route-whitelist assertions passed!");
```

**Step 2: Run it and confirm it fails**

Run: `npx tsx tests/route-whitelist.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/model-routing/route-whitelist.js'`

**Step 3: Commit the red test**

```bash
git add tests/route-whitelist.test.ts
git commit -m "test: add failing route whitelist loader contract"
```

### Task 0.2: Effort normalization tests (NEW)

**Files:**
- Test: `tests/effort-normalization.test.ts` (create)

Aim: `normalizeEffortLevels(variantKeys: string[])` returns `{ low, medium?, high? }` with **actual** keys.

Cases:

1. `[]` → `{}` (no levels).
2. `["high", "max"]` → `{ low: "high", high: "max" }` — 2 variants, lowest/highest.
3. `["minimal", "low", "medium", "high", "xhigh"]` → `{ low: "minimal", medium: "medium", high: "xhigh" }` — middle-most of 5 is index 2.
4. `["low", "medium", "high"]` → identity mapping.
5. `["none", "minimal", "low"]` → `{ low: "none", medium: "minimal", high: "low" }`.
6. Unknown keys (e.g. `"turbo"`) are ignored, not crashed on.
7. Determinism: same input → same output (run twice, deepEqual).

Run: `npx tsx tests/effort-normalization.test.ts` → FAIL (module missing).

```bash
git add tests/effort-normalization.test.ts
git commit -m "test: add failing effort normalization contract"
```

### Task 0.3: Effort intent parser tests (NEW)

**Files:**
- Test: `tests/effort-intent.test.ts` (create)

Aim: extend the bounded natural parser with effort extraction. Contract:

1. `"usá opus 5 con esfuerzo high"` → `{ modelRef: "opus 5", effort: "high" }`.
2. `"usando glm 5.2"` → `{ modelRef: "glm 5.2", effort: "low" }` — default low.
3. `"usando opus con esfuerzo máximo"` → `EFFORT_LEVEL_UNKNOWN` error listing `low|medium|high` ("máximo" folds to "maximo", which is not a level).
4. `"effort medium usando terra"` → `{ modelRef: "terra", effort: "medium" }` — order-independent.
5. `"con esfuerzo high"` with no model trigger → no effort extracted either (effort only pairs with a model intent; a bare effort phrase is not a routing trigger).
6. Original prompt bytes are never mutated by parsing (assert the input string is untouched).

Run: `npx tsx tests/effort-intent.test.ts` → FAIL.

```bash
git add tests/effort-intent.test.ts
git commit -m "test: add failing effort intent parser contract"
```

### Task 0.4: Rewrite the hook contract tests

**Files:**
- Modify: `tests/model-route-task-hook.test.ts`

Delete the assertions for gates that no longer exist: missing/expired attestation, required `bootIdentity`, required `signingKey`, off-manifest rejection.

Add these cases, all constructed with **no** `bootIdentity`, **no** `signingKey`, **no** `manifest.json`, and **no** `attestation.json` on disk:

1. Whitelisted + not quarantined + no effort mentioned → `subagent_type` becomes `sdd-mr-v1-<hash>-low` (default low); `prompt` and `model` unchanged byte-for-byte.
2. Whitelisted + effort `high` + model has variants → `subagent_type` becomes `sdd-mr-v1-<hash>-high`.
3. Whitelisted + effort `medium` + model has only 2 levels → falls back to that model's `high` mapping? **No** — if the model exposes no `medium` level, the request maps to the nearest available level **within the model's levels** using the same closest-distance rule as normalization, and the audit records `effortFallbackReason: "LEVEL_NOT_EXPOSED"`. The dispatch is NOT blocked.
4. Whitelisted + effort + model has NO variants → `subagent_type` becomes base `sdd-mr-v1-<hash>`; a warning was logged (inject the logger, assert the call) and the audit entry carries `effortFallbackReason: "MODEL_HAS_NO_VARIANTS"`.
5. Not whitelisted → throws `ROUTE_NOT_WHITELISTED`; `subagent_type` untouched.
6. Whitelisted but TTL-quarantined → throws `QUARANTINED_MODEL`, message carries the quarantine reason.
7. Whitelisted, quarantine expired → routes normally (to `-low`).
8. Whitelisted but the target `.md` (including the `-low` suffix) is absent → throws `ROUTED_AGENT_UNAVAILABLE`.
9. No grammar and no natural trigger → byte-for-byte passthrough, no audit entry.
10. Grammar 4-segment form `model-route:v1|sdd-mr-base|openai/gpt-5.6-sol|high` → routes to `-high`.
11. Audit sink throws → the dispatch still rewrites `subagent_type` (audit is best-effort).
12. The hook writes nothing to disk except the audit line.

Run: `npx tsx tests/model-route-task-hook.test.ts` → expect FAIL.

```bash
git add tests/model-route-task-hook.test.ts
git commit -m "test: rewrite task hook contract for whitelist + effort routing"
```

### Task 0.5: Fleet filter tests

**Files:**
- Modify: `tests/fleet-route-filter.test.ts`

Assertions:
1. A route with an active **permanent** quarantine is excluded with reason `PERMANENTLY_QUARANTINED`.
2. A route with an active **ttl** quarantine is **included** (dispatch enforces it, not generation).
3. A route whose provider is absent from the Prisma catalog is **included** (the `NOT_CONNECTED` filter is gone).
4. `excludedCanonicalIds` is no longer part of the input type.

Run: `npx tsx tests/fleet-route-filter.test.ts` → expect FAIL on 3 and 4.

```bash
git add tests/fleet-route-filter.test.ts
git commit -m "test: routes.json is the only inclusion authority in fleet filtering"
```

### Task 0.6: Variant fleet generation tests (NEW)

**Files:**
- Test: `tests/variant-fleet-generation.test.ts` (create)

Against a temp workspace with a fake variant snapshot:

1. Model with 3 variants → base + `-low` + `-medium` + `-high` agent files, each with correct `variant:` frontmatter (actual keys).
2. Model with 2 variants → base + `-low` + `-high` (no `-medium`).
3. Model with 0 variants → base only.
4. Every generated file declares `model: provider/modelId` and keeps `mode: subagent`, `hidden: true`, `permission.task.'*': deny`.
5. Only ONE canary command per model (base hash, no suffixes).
6. Sweep removes stale variant files of removed routes (`sdd-mr-v1-<hash>-*` of a route no longer in `routes.json`).
7. `variants.json` is written next to the manifest.

Run: `npx tsx tests/variant-fleet-generation.test.ts` → FAIL.

```bash
git add tests/variant-fleet-generation.test.ts
git commit -m "test: add failing variant fleet generation contract"
```

---

## Phase 1 — `routes.json` as the routing authority

### Task 1.1: Create the whitelist loader

**Files:**
- Create: `src/domain/model-routing/route-whitelist.ts`
- Modify: `src/domain/model-routing/index.ts` (export it)

**Implementation:**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

import { hashHostName, type RoutedHostName } from "./model-route-host-naming.js";

export interface WhitelistedRoute {
  readonly baseTemplate: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly hostName: RoutedHostName;
}

export const DEFAULT_ROUTES_CONFIG_RELATIVE = path.join("config", "model-routing", "routes.json");

export class RouteWhitelist {
  private readonly byCanonical: ReadonlyMap<string, WhitelistedRoute>;

  constructor(routes: ReadonlyArray<WhitelistedRoute>) {
    const map = new Map<string, WhitelistedRoute>();
    for (const route of routes) map.set(`${route.providerId}/${route.modelId}`, route);
    this.byCanonical = map;
  }

  get size(): number {
    return this.byCanonical.size;
  }

  findHostName(providerId: string, modelId: string): RoutedHostName | null {
    return this.byCanonical.get(`${providerId}/${modelId}`)?.hostName ?? null;
  }

  existsCanonical(providerId: string, modelId: string): boolean {
    return this.byCanonical.has(`${providerId}/${modelId}`);
  }

  /** Substring match over `provider/model`, lowercased. Deterministically sorted. */
  searchNormalized(reference: string, limit: number): ReadonlyArray<WhitelistedRoute> {
    const needle = reference.trim().toLowerCase();
    if (needle.length === 0) return [];
    const hits = [...this.byCanonical.values()].filter((route) =>
      `${route.providerId}/${route.modelId}`.toLowerCase().includes(needle),
    );
    hits.sort((a, b) =>
      a.providerId !== b.providerId
        ? a.providerId < b.providerId ? -1 : 1
        : a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0,
    );
    return hits.slice(0, limit);
  }
}

export function loadRouteWhitelist(workspaceRoot: string, configPath?: string): RouteWhitelist {
  const resolved = configPath ?? path.join(path.resolve(workspaceRoot), DEFAULT_ROUTES_CONFIG_RELATIVE);
  const raw = JSON.parse(readFileSync(resolved, "utf8")) as {
    routes?: ReadonlyArray<{ baseTemplate?: unknown; providerId?: unknown; modelId?: unknown }>;
  };
  const routes: WhitelistedRoute[] = [];
  for (const entry of raw.routes ?? []) {
    const { baseTemplate, providerId, modelId } = entry;
    if (typeof baseTemplate !== "string" || typeof providerId !== "string" || typeof modelId !== "string") continue;
    if (baseTemplate.length === 0 || providerId.length === 0 || modelId.length === 0) continue;
    routes.push({ baseTemplate, providerId, modelId, hostName: hashHostName(baseTemplate, { providerId, modelId }) });
  }
  return new RouteWhitelist(routes);
}
```

Run: `npx tsx tests/route-whitelist.test.ts` → PASS.

```bash
git add src/domain/model-routing/route-whitelist.ts src/domain/model-routing/index.ts
git commit -m "feat(routing): derive routable hosts from routes.json"
```

### Task 1.2: Effort normalization module (NEW)

**Files:**
- Create: `src/domain/model-routing/effort-levels.ts`
- Modify: `src/domain/model-routing/index.ts`

**Implementation sketch:**

```ts
export type NormalizedEffortLevel = "low" | "medium" | "high";
export const NORMALIZED_LEVELS = ["low", "medium", "high"] as const;

const EFFORT_RANK: Readonly<Record<string, number>> = {
  none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6,
};

export interface EffortLevelMapping {
  readonly low: string;
  readonly medium?: string;
  readonly high: string;
}

/** Rank known keys ascending; ignore unknown keys. */
function rankKeys(variantKeys: ReadonlyArray<string>): string[] { /* … */ }

/**
 * 0 or 1 usable keys → {} (no levels).
 * 2 keys → { low: first, high: last }.
 * 3+ keys → { low: first, medium: middle-most, high: last }.
 */
export function normalizeEffortLevels(variantKeys: ReadonlyArray<string>): Partial<EffortLevelMapping> { /* … */ }

/** Nearest available level when the requested one is not exposed. */
export function nearestLevel(requested: NormalizedEffortLevel, mapping: Partial<EffortLevelMapping>): NormalizedEffortLevel | null { /* … */ }
```

Run: `npx tsx tests/effort-normalization.test.ts` → PASS.

```bash
git add src/domain/model-routing/effort-levels.ts
git commit -m "feat(routing): normalize model variant keys to low/medium/high"
```

### Task 1.3: Variant snapshot loader (NEW)

**Files:**
- Create: `src/infrastructure/opencode/variant-snapshot.ts`
- Modify: `src/infrastructure/opencode/index.ts`

API:

```ts
export interface VariantSnapshot { readonly levels: Partial<EffortLevelMapping> } // keyed by canonical id
export function readVariantSnapshot(workspaceRoot: string): ReadonlyMap<string, VariantSnapshot>;
export function writeVariantSnapshot(workspaceRoot: string, data: ReadonlyMap<string, VariantSnapshot>): void; // generation time only
export async function collectVariantsFromSdk(client: OpenCodeClient): Promise<Map<string, string[]>>; // walks provider.models, gated by capabilities.reasoning
```

Dispatch-side `readVariantSnapshot` returns an empty map on missing/corrupt file (models behave as variant-less → base + warning; routing never breaks).

```bash
git add src/infrastructure/opencode/variant-snapshot.ts
git commit -m "feat(routing): variant snapshot read/write with SDK collection"
```

### Task 1.4: Point the resolver at the whitelist

**Files:**
- Modify: `src/domain/model-routing/model-route-resolver.ts:50-95`
- Modify: `tests/model-route-resolver.test.ts`

Replace the `ModelRouteCatalogPort` constructor dependency with `RouteWhitelist`. Tier 1 calls `whitelist.existsCanonical`, Tier 3 calls `whitelist.searchNormalized`. Both become synchronous, so `resolve()` may stay `async` for call-site compatibility but no longer awaits I/O. `RouteUnknownError` and `RouteAmbiguousError` are unchanged.

Extend the natural-intent extraction to also return `effort` (Task 0.3 contract) — the resolver itself stays model-only; effort parsing lives in `natural-model-intent.ts` so the hook receives both fields from one parse pass.

Run: `npx tsx tests/model-route-resolver.test.ts && npx tsx tests/effort-intent.test.ts` → PASS.

```bash
git commit -am "refactor(routing): resolve identities against the routes.json whitelist"
```

---

## Phase 2 — Slim down and extend `ModelRouteTaskHook`

**Files:**
- Modify: `src/infrastructure/opencode/model-route-task-hook.ts` (569 → ~260 lines)

**Delete:**
- Imports of `ModelRouteReadiness`, `AttestationExpiredError`, `AttestationMismatchError`, `REQUIRED_OPENCODE_VERSION`, `Manifest`
- `AttestationUnavailableError`, `TaskHookBootIdentityMissingError`, `TaskHookSigningKeyMissingError`
- Options `manifestPath`, `attestationPath`, `openCodeVersion`, `bootIdentity`, `signingKey` and their constructor validation
- `readManifest()` and `manifestHostNameFor()`
- Both readiness blocks

**Keep, unchanged:**
- Grammar path and natural-intent path structure, including byte-for-byte passthrough
- Quarantine reconcile + check + reason resolution
- Audit stages `routing.launch`, `routing.blocked`, `routing.natural.launch`, `routing.natural.blocked`

**Add — whitelist + effort selection:**

```ts
export class RouteNotWhitelistedError extends Error { /* code = ROUTE_NOT_WHITELISTED */ }
export class EffortLevelUnknownError extends Error { /* code = EFFORT_LEVEL_UNKNOWN */ }
```

Selection flow in both paths:

```ts
const hostName = this.whitelist.findHostName(canonical.providerId, canonical.modelId);
if (hostName === null) { /* block + throw ROUTE_NOT_WHITELISTED */ }

const mapping = this.variants.get(`${canonical.providerId}/${canonical.modelId}`)?.levels ?? {};
const requested = parsedEffort ?? "low";           // default low
let targetAgent = hostName;                        // base
let appliedLevel: NormalizedEffortLevel | null = requested;
let fallbackReason: string | null = null;

if (Object.keys(mapping).length === 0) {
  fallbackReason = "MODEL_HAS_NO_VARIANTS";
  appliedLevel = null;
  this.warnNoVariants(canonical, requested);       // logger.warning — visible, non-blocking
} else {
  const chosen = mapping[requested] ? requested : nearestLevel(requested, mapping);
  if (!mapping[requested]) fallbackReason = "LEVEL_NOT_EXPOSED";
  targetAgent = `${hostName}-${chosen}` as RoutedHostName;
}

const agentFile = path.join(this.workspaceRoot, ".opencode", "agents", `${targetAgent}.md`);
if (!existsSync(agentFile)) { /* block + throw ROUTED_AGENT_UNAVAILABLE */ }

output.args = { ...output.args, subagent_type: targetAgent };
// audit entry gains: effortRequested: requested, effortApplied: appliedLevel, effortFallbackReason
```

Make the audit best-effort (try/catch around every `append`; log and continue).

Run: `npx tsx tests/model-route-task-hook.test.ts` → PASS.

```bash
git commit -am "refactor(routing): drop attestation gates, add effort variant selection"
```

---

## Phase 3 — Slim down the bootstrap composition root

**Files:**
- Modify: `src/bootstrap/index.ts`

**Delete:**
- `ROUTING_BOOT_ID_ENV` / `ROUTING_SIGNING_KEY_ENV`
- `resolveRoutingBootIdentity` / `resolveRoutingSigningKey`
- Both `ROUTING_NOT_CONFIGURED` blocks
- The lease `setInterval` and its imports
- Imports of `loadOrCreateRoutingSecrets`, `renewRoutingLease`, `LEASE_RENEWAL_MS`, `PrismaModelRouteCatalogAdapter`

**Keep:** `PrismaModelRouteQuarantineAdapter` + `loadQuarantineEntries` and `getGlobalQuarantineStore()`.

Both hook constructions become:

```ts
const routingHook = new ModelRouteTaskHook({
  workspaceRoot,
  whitelist: loadRouteWhitelist(workspaceRoot),
  variants: readVariantSnapshot(workspaceRoot),
  resolver: new ModelRouteResolver(loadRouteWhitelist(workspaceRoot), aliases),
  quarantineStore: getGlobalQuarantineStore(),
  audit: { path: auditPath },
  loadQuarantineEntries: async () => routingQuarantineAdapter.listActive(),
});
```

Load the whitelist once per hook invocation so an edit to `routes.json` takes effect without restarting OpenCode. `variants.json` is read once per hook invocation too (cheap local file).

Run: `npx tsx tests/bootstrap-clean-startup.test.ts && npx tsx tests/bootstrap-interception.test.ts` → PASS.

```bash
git commit -am "refactor(bootstrap): wire routing without boot identity or signing key"
```

---

## Phase 4 — Delete the attestation, canary and supervisor stack

**Files to delete:**

```
src/infrastructure/opencode/model-route-readiness.ts
src/infrastructure/opencode/model-route-canary.ts
src/infrastructure/opencode/foreign-agent-scan.ts
src/infrastructure/opencode/foreign-agent-sources.ts
src/infrastructure/opencode/foreign-agent-errors.ts
src/infrastructure/opencode/resolved-agent-config-guard.ts
src/infrastructure/runtime/model-route-secrets.ts
src/infrastructure/runtime/model-route-lease.ts
src/infrastructure/runtime/model-route-handshake.ts
src/infrastructure/runtime/model-route-boot-control.ts
src/infrastructure/runtime/windows-model-route-boot-manager.ts
src/infrastructure/runtime/windows-acl.ts
src/cli/model-route-boot.ts
src/cli/model-route-boot-stop-output.ts
src/domain/model-routing/opencode-compat.ts
src/ports/model-route-catalog.port.ts
src/infrastructure/prisma/model-route-catalog.adapter.ts
```

Then remove the corresponding re-exports from `src/infrastructure/opencode/index.ts`, `src/infrastructure/runtime/` barrels, `src/domain/model-routing/index.ts`, and `src/ports/index.ts`.

**Runtime artifacts to delete from the workspace** (no longer read by anything):

```powershell
Remove-Item -ErrorAction SilentlyContinue .opencode/sdd-model-routing/attestation.json, .opencode/sdd-model-routing/boot-control.json, .opencode/sdd-model-routing/handshake.json, .opencode/sdd-model-routing/lease.json, .opencode/sdd-model-routing/secrets.json
```

Verify nothing still imports the deleted modules:

Run: `npx tsc --project tsconfig.json --noEmit`
Expected: no `TS2307` module-not-found errors.

```bash
git commit -am "refactor(routing): remove attestation, canary and supervisor stack"
```

---

## Phase 5 — Generator, fleet filter, and variant fleet

### Task 5.1: `FilterFleetRoutesUseCase`

**Files:**
- Modify: `src/application/filter-fleet-routes/filter-fleet-routes.use-case.ts`
- Modify: `src/application/filter-fleet-routes/filter-fleet-routes.input.ts`

Drop the `catalogPort` constructor dependency and the `NOT_CONNECTED` branch. Drop the `CANARY_BLOCKED` branch and `excludedCanonicalIds` from the input type. The use case reduces to: load quarantines, exclude the ones where `type === "permanent"` resolves active, include everything else.

`ExcludedReason` becomes the single literal `"PERMANENTLY_QUARANTINED"`.

Run: `npx tsx tests/fleet-route-filter.test.ts` → PASS.

### Task 5.2: `RegenerateFleetAgentsUseCase`

**Files:**
- Modify: `src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.ts`
- Modify: `src/application/regenerate-fleet-agents/regenerate-fleet-agents.input.ts`

Remove the `catalogPort` constructor parameter and `input.excludeCanonicalIds`. Keep the `generation.route.excluded` and `generation.fleet.empty` audit entries.

**Add:** before generating, call `collectVariantsFromSdk` (best-effort; on failure, reuse the existing `variants.json`, else empty) and `writeVariantSnapshot` the result.

### Task 5.3: `DiskAgentGenerator` — variant fleet

**Files:**
- Modify: `src/infrastructure/opencode/disk-agent-generator.ts`
- Modify: `src/infrastructure/opencode/routed-agent-definition.ts`

- Delete `assertNoForeignAgentDefinitions` and the `foreign-agent-*` imports
- Delete the `REQUIRED_OPENCODE_VERSION` import and the `requiredOpenCodeVersion` manifest field
- **Extend generation:** for each included route, read its `EffortLevelMapping` from the variant snapshot and emit base + one agent per level, with frontmatter:

  ```yaml
  ---
  description: Deterministic routed host for provider/model (host, effort low → variant high).
  mode: subagent
  hidden: true
  model: provider/model
  variant: high          # actual variant key; omitted on the base agent
  permission:
    task:
      '*': deny
  ---
  ```

- **Extend sweep:** stale cleanup covers `sdd-mr-v1-<hash>*.md` (prefix-scoped glob including suffixed variants) and `sdd-mr-canary-v1-<hash>.md`
- Keep the exclusive lock, journal, atomic descriptor writes, and path-traversal guards — these are crash-safety, not access control
- One canary command per model (base hash only)

### Task 5.4: Composition root for the CLI

**Files:**
- Modify: `src/cli/model-route-agents.ts`

Construct `RegenerateFleetAgentsUseCase` with only the quarantine port and the audit logger.

Run: `npm run generate:model-routes` then confirm the variant fleet:

```powershell
npx tsx src/cli/model-route-agents.ts . config/model-routing/routes.json
(Get-ChildItem .opencode/agents/sdd-mr-v1-*.md).Count
(Get-ChildItem .opencode/agents/sdd-mr-v1-*-low.md).Count
```
Expected: total ≥ 18 (one base per route, plus `-low`/`-medium`/`-high` for each model with variants, minus permanently quarantined routes).

```bash
git commit -am "feat(generator): base + effort variant fleet from routes.json and variant snapshot"
```

---

## Phase 6 — Tests, scripts and documentation

### Task 6.1: Delete obsolete suites

```
tests/model-route-canary-readiness.test.ts
tests/model-route-canary-isolation.test.ts
tests/model-route-secrets.test.ts
tests/model-route-lease.test.ts
tests/model-route-handshake.test.ts
tests/model-route-boot-control.test.ts
tests/model-route-boot-ordering.test.ts
tests/model-route-boot-partial-fleet.test.ts
tests/model-route-boot-composition.test.ts
tests/model-route-process-supervisor.test.ts
tests/windows-boot-manager.test.ts
tests/model-route-real-host-canary.integration.ts
tests/foreign-agent-scan.test.ts
tests/foreign-agent-sources.test.ts
tests/foreign-agent-errors.test.ts
tests/foreign-agent-parser-dependencies.test.ts
tests/foreign-agent-guard-generator.test.ts
tests/foreign-agent-guard-readiness.test.ts
tests/foreign-agent-guard-bootstrap.test.ts
tests/foreign-agent-guard-task-hook.test.ts
tests/foreign-agent-config-hook.test.ts
tests/resolved-agent-config-guard.test.ts
```

### Task 6.2: Update the surviving suites

- `tests/model-route-host-naming.test.ts` — delete the `assertOpenCodeCompatible` matrix, keep the `hashHostName` assertions, add suffix-name assertions (`sdd-mr-v1-<hash>-low`)
- `tests/model-route-disk-generator.test.ts` — drop the `requiredOpenCodeVersion` assertion, add variant-file assertions
- `tests/model-route-routing-e2e.test.ts` — drop version/manifest preconditions; the E2E needs only a generated fleet (now including variants)
- `tests/model-route-cli.test.ts` — delete the boot-CLI exit-code cases, keep the generator cases
- `tests/natural-model-routing-task-hook.test.ts` — extend with effort-trigger cases from Task 0.3/0.4

### Task 6.3: `package.json` scripts

- `test:fleet-regeneration` — remove `model-route-boot-ordering` and `model-route-boot-composition`, add `variant-fleet-generation`
- `test:model-routes` — remove `canary-readiness`, `boot-control`, `process-supervisor`, `handshake`, `canary-isolation`, `boot-partial-fleet`, `secrets`, `lease`; add `route-whitelist`, `model-route-resolver`, `effort-normalization`, `effort-intent`
- `canary:model-routes:real` — delete
- `test:all` — **add `npm run test:model-routes`**. It is currently absent, which is why this entire family never ran in the main gate.

### Task 6.4: `tsconfig.test.json`

Remove every deleted test from `include`. Add `tests/route-whitelist.test.ts`, `tests/effort-normalization.test.ts`, `tests/effort-intent.test.ts`, `tests/variant-fleet-generation.test.ts`.

### Task 6.5: Documentation

- Rewrite `docs/windows-natural-routing-operations.md`: the operating procedure collapses to "edit `routes.json` → `npm run generate:model-routes` → open OpenCode". Document the effort selection (`low` default; `con esfuerzo high`; grammar 4th segment) and the no-variant warning. Delete the boot/status/stop, canary-evidence and incident sections.
- Update `AGENTS.md`: remove the `model-route-boot start` supervisor instructions and the attestation claims. Document the extended grammar `model-route:v1|sdd-mr-base|<modelReference>[|<low|medium|high>]` and the natural effort triggers.

```bash
git commit -am "chore: align tests, scripts and docs with whitelist + effort variant routing"
```

---

## Verification

Run in order; every command must pass before the change is considered done.

```bash
npm run generate:model-routes
npm run test:model-routes
npm run test:typecheck:strict
npm run build
npm run test:persistence:guard
```

Then a live check in a plain OpenCode session started **without** any supervisor:

1. Dispatch with `subagent_type = "model-route:v1|sdd-mr-base|openai/gpt-5.6-sol"` → runs on `openai/gpt-5.6-sol` at its `low`-mapped variant; audit shows `effortApplied: "low"`.
2. Natural prompt "…usando gpt 5.6 sol con esfuerzo high" → subagent runs on the `-high` variant agent.
3. Quarantine that model with a 1-hour TTL from the TUI, dispatch again → `QUARANTINED_MODEL`.
4. Release the quarantine, dispatch again → routes normally.
5. Dispatch with a model absent from `routes.json` → `ROUTE_NOT_WHITELISTED`.
6. Ask effort on a known variant-less model → work completes on the base agent and a `[sdd-plugin.routing] … no effort variants` warning is visible.
7. Confirm `routing.audit.jsonl` recorded each outcome including `effortRequested`/`effortApplied`/`effortFallbackReason`.

## Estimated size

Roughly **−4,900 / +900** lines (Rev 2 adds ~450 lines over Rev 1 for effort parsing, normalization, variant snapshot, and variant fleet generation). The bulk is still deletion.

## Rollback

The whole change is contained in one branch. `git revert` restores the attestation stack; the only non-code state that disappears is `.opencode/sdd-model-routing/{attestation,handshake,lease,secrets,boot-control}.json`, all of which are regenerated by the old supervisor on demand. `variants.json` is regenerable at any time by rerunning the generator.
