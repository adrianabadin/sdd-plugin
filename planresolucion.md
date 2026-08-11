# Plan: Per-Route Canary Isolation for Deterministic Model Routing

## 1. Problem statement

A single transient model failure aborts the entire supervisor boot, so routes that
*did* prove correct dispatch are discarded together with the one that failed.

Observed across five consecutive boots of the same 26-route fleet:

| Boot | Result | Failing route |
|------|--------|---------------|
| 1 | ready | — |
| 2 | ready | — |
| 3 | ready (killed by PTY timeout) | — |
| 4 | `CHILD_SESSION_MISSING` | `google/antigravity-gemini-3.6-flash-tiered` |
| 5 | `CANARY_METADATA_UNOBSERVABLE` | `openai/gpt-5.6-sol-fast` |

A different route fails each time, which is the signature of upstream API flakiness,
not of a defect in the routing code.

### Root cause (verified in source)

1. `ModelRouteCanary.verifyEveryRoute` iterates routes sequentially and lets the first
   `verifyRoute` rejection propagate — `src/infrastructure/opencode/model-route-canary.ts:256-263`.
2. The boot awaits that single call and has no per-route recovery —
   `src/infrastructure/runtime/windows-model-route-boot-manager.ts:448`.
3. `ModelRouteReadiness.issue` refuses to publish unless canary evidence covers
   **every** manifest route — `src/infrastructure/opencode/model-route-readiness.ts:138`
   and host-set equality at `:143`.

The failure domain is therefore the whole fleet. With 26 routes and a per-route
success probability of `p`, boot success is `p^26`; at `p = 0.95` that is ~26%.

### What must NOT change

The canary exists to prove that a routed host dispatches the model it claims and
that the host does not silently substitute another one. Attestation is the artifact
of that proof. Any design that lets an unproven route be dispatched reintroduces the
exact bug this subsystem exists to prevent. **The proof requirement per route is
non-negotiable; only the blast radius of a failure changes.**

## 2. Target model

The dispatch decision becomes four independent, deterministic gates:

1. Is the supervisor online? → fresh attestation + handshake.
2. Is the route in the attested manifest (whitelist)? → proven this boot.
3. Is the route quarantined? → explicit block with reason.
4. Otherwise → dispatch.

A route that fails its canary is excluded from the attested manifest and quarantined
with the canary error code as the reason. Every other route stays dispatchable.

## 3. Design

### 3.1 Failure domain = one route

`ModelRouteCanary` gains an outcome-collecting API. Per-route failures become data,
not control flow.

```ts
// src/infrastructure/opencode/model-route-canary.ts
export interface CanaryFailure {
  readonly hostName: string;
  readonly targetCanonicalId: string;
  readonly code: CanaryErrorCode;
  readonly message: string;
  readonly attempts: number;
}

export interface CanaryReport {
  readonly proven: ReadonlyArray<CanaryEvidence>;
  readonly blocked: ReadonlyArray<CanaryFailure>;
}

class ModelRouteCanary {
  async verifyRoutes(manifest: Manifest): Promise<CanaryReport>;
  async verifyEveryRoute(manifest: Manifest): Promise<ReadonlyArray<CanaryEvidence>>;
}
```

- `verifyRoutes` never rejects because of a per-route `CanaryBlockedError`; it records
  the failure and continues. Non-`CanaryBlockedError` rejections (programming errors)
  still propagate.
- `verifyEveryRoute` is reimplemented on top of `verifyRoutes` and throws when
  `blocked` is non-empty, preserving every existing caller and test.
- Bounded retry: each route is attempted `1 + canaryRetries` times (default
  `canaryRetries = 1`) before being recorded as blocked. This raises fleet
  completeness against transient upstream errors without weakening the proof —
  a route is excluded only after N *failed proofs*, and inclusion still requires a
  full successful proof.

### 3.2 Exclusion policy stays in the application layer

`FilterFleetRoutesUseCase` already owns route-exclusion policy and emits typed
reasons (`NOT_CONNECTED`, `PERMANENTLY_QUARANTINED`) —
`src/application/filter-fleet-routes/filter-fleet-routes.use-case.ts:24-55`.

Extend its input rather than inventing a parallel mechanism:

```ts
// src/application/filter-fleet-routes/filter-fleet-routes.input.ts
export interface FilterFleetRoutesInput {
  readonly routes: ReadonlyArray<RouteEntry>;
  readonly excludedCanonicalIds?: ReadonlySet<string>; // NEW
}
export type ExclusionReason =
  | "NOT_CONNECTED"
  | "PERMANENTLY_QUARANTINED"
  | "CANARY_BLOCKED"; // NEW
```

Precedence order inside the loop: `NOT_CONNECTED` → `PERMANENTLY_QUARANTINED` →
`CANARY_BLOCKED`. TTL-quarantine semantics are deliberately left untouched
(`tests/fleet-route-filter.test.ts` asserts TTL-only quarantines remain included).

`RegenerateFleetAgentsInput` gains the matching optional passthrough
`excludeCanonicalIds`, forwarded to the filter —
`src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.ts:44-45`.

### 3.3 Boot sequence

Current: `regenerate → secrets → lock → serve → sync → readback → canary → issue → ready`.

New steps are inserted between canary and issue:

```
canary(verifyRoutes) → report{proven, blocked}
  if proven.length == 0                  -> fail closed CANARY_FLEET_EMPTY
  if blocked.length > 0:
      audit  boot.route.canary_blocked   (one entry per blocked route)
      quarantine TTL per blocked route   (QuarantineWritePort.setQuarantine)
      release boot lock                  (boot lock IS generator.lock)
      regenerate fleet excluding blocked (generator takes its own lock)
      re-read manifest from disk
      assert manifest.routes host set == proven host set   -> else fail closed
issue(manifest, evidence = proven)
re-acquire lock -> writeControlRecord -> writeHandshake -> ready
```

Lock detail: the boot lock path and the generator lock path are the same file —
`windows-model-route-boot-manager.ts:263`. `ModelRouteReadiness.issue` already refuses
to publish while that lock exists, and the boot already releases and re-acquires it
around `issue()`. The regeneration step therefore runs inside that same
lock-released window, immediately before `issue()`.

Quarantine record written per blocked route:

```ts
{ level: "modelProvider", providerId, modelId,
  type: "ttl", until: now + CANARY_QUARANTINE_TTL_MS /* default 15 min */,
  reason: `canary ${code}` }
```

TTL (not permanent) is correct for transient upstream failures: the entry expires and
the route is re-canaried on a later boot without operator intervention.

### 3.4 Dispatch side

The hook gate order already runs quarantine before readiness
(`tests/model-route-task-hook.test.ts`: "active quarantine blocks before rewrite").
Because §3.3 writes a quarantine entry for every blocked route, dispatching one
yields `QuarantinedModelError` carrying `canary <CODE>` as the reason — precise and
actionable — instead of a generic unknown-route error. No new gate is required.

### 3.5 Observability

- stdout on ready: `boot: state=ready bootIdentity=<id> routes=24/26 blocked=2`.
- `model-route-boot status`: attested route count plus blocked hosts and reasons.
- New exit code `9` = `CANARY_FLEET_EMPTY`. Exit code `4` is retained for
  transport-level canary failures that are not attributable to one route.
  Codes are defined in `src/cli/model-route-boot.ts:197-218`.

## 4. Work units (TDD, RED first)

### WU1 — Canary outcome collection
- Files: `src/infrastructure/opencode/model-route-canary.ts`
- Test (new): `tests/model-route-canary-isolation.test.ts`
  1. `verifyRoutes` returns proven + blocked and does not reject when one route fails.
  2. Blocked entry carries `hostName`, `targetCanonicalId`, `code`, `message`, `attempts`.
  3. Route failing once then succeeding is proven when `canaryRetries = 1`.
  4. Route failing every attempt appears exactly once in `blocked`.
  5. `verifyEveryRoute` still throws when any route is blocked (backwards compatibility).
  6. Non-`CanaryBlockedError` rejections propagate untouched.

### WU2 — Filter + regeneration exclusion passthrough
- Files: `filter-fleet-routes.input.ts`, `filter-fleet-routes.use-case.ts`,
  `regenerate-fleet-agents.input.ts`, `regenerate-fleet-agents.use-case.ts`
- Test (extend): `tests/fleet-route-filter.test.ts`, `tests/fleet-agent-regeneration.test.ts`
  1. `excludedCanonicalIds` produces `reason: "CANARY_BLOCKED"`.
  2. `NOT_CONNECTED` takes precedence over `CANARY_BLOCKED`.
  3. TTL-only quarantine remains included (regression guard).
  4. Regeneration forwards the exclusion set and sweeps the removed host files.

### WU3 — Boot partial-fleet readiness
- Files: `src/infrastructure/runtime/windows-model-route-boot-manager.ts`
- Test (new): `tests/model-route-boot-partial-fleet.test.ts`
  1. 3 routes, 1 canary failure → state `ready`; manifest holds 2 routes; attestation
     covers exactly those 2; handshake published.
  2. A TTL quarantine is written for the blocked route with the canary code as reason.
  3. An audit entry `boot.route.canary_blocked` is appended per blocked route.
  4. All routes fail → boot fails `CANARY_FLEET_EMPTY`; no attestation, no handshake,
     lock released, env restored.
  5. Manifest/evidence set equality is asserted after regeneration; a mismatch fails closed.
  6. No blocked routes → byte-identical behaviour to today (no extra regeneration).

### WU4 — Dispatch reason surfacing
- Test (extend): `tests/model-route-task-hook.test.ts`
  1. Dispatching a canary-blocked route raises `QuarantinedModelError` whose reason
     contains the canary code, and the quarantine gate fires before readiness.

### WU5 — CLI surface
- Files: `src/cli/model-route-boot.ts`
- Test (extend): `tests/model-route-cli.test.ts`
  1. Ready line reports `routes=<proven>/<configured> blocked=<n>`.
  2. `CANARY_FLEET_EMPTY` maps to exit code 9 with a diagnostic message.
  3. `status` lists blocked hosts with reasons.

### WU6 — Registration and verification
- Register `tests/model-route-canary-isolation.test.ts` and
  `tests/model-route-boot-partial-fleet.test.ts` in the `test:model-routes` script
  (`package.json:37`), mirroring the existing stop-control regression guard which
  asserts its own presence in that script.

## 5. Verification

```
npx tsx tests/model-route-canary-isolation.test.ts
npx tsx tests/model-route-boot-partial-fleet.test.ts
npm run test:model-routes
npx tsx tests/windows-boot-manager.test.ts
npx tsc --project tsconfig.test.json --noEmit
npm run build
```

Live acceptance: boot the supervisor against an isolated port and confirm it reaches
`ready` while at least one route is blocked, then dispatch a *proven* route and a
*blocked* route:

```
$env:SDD_OPENCODE_BASE_URL="http://127.0.0.1:4098"
node node_modules/tsx/dist/cli.mjs src/cli/model-route-boot.ts start .
```

Expected: proven route dispatches; blocked route fails closed with
`QUARANTINED: canary <CODE>`; the fleet no longer requires 26/26 to serve traffic.

## 6. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Regeneration after canary changes `manifestHash`; attestation must bind the reduced manifest | Re-read the manifest from disk after regeneration and pass that object to `issue()`; WU3 test 5 asserts set equality |
| A route required by the SDD model profile gets blocked | Report it on stdout; dispatch fails closed with the quarantine reason. Deterministic and diagnosable, never a silent substitution |
| TTL quarantine entries accumulate | TTL default 15 min; entries expire and the route is re-canaried on a later boot |
| Retry masks a genuinely broken route | Retries only add attempts; inclusion still requires a complete successful proof. A permanently broken route is blocked on every boot and is visible in the audit log |
| Second regeneration races the generator lock | Regeneration runs inside the existing lock-released window before `issue()`; the generator acquires its own lock as usual |

## 7. Non-goals

- Weakening or removing the per-route dispatch proof.
- Allowing dispatch of a route absent from the attested manifest.
- Changing TTL-quarantine filter semantics at generation time.
- Multi-instance OpenCode support (separate, still-open architectural item).
