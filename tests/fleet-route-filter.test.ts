/**
 * RED — `routes.json` is the only inclusion authority for fleet regeneration.
 * Connectivity and canary blocklists are gone; only permanent quarantines
 * exclude a route at generation time. TTL quarantines are dispatched against.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FilterFleetRoutesUseCase } from "../src/application/filter-fleet-routes/filter-fleet-routes.use-case.js";
import type { ModelRouteQuarantinePort } from "../src/ports/model-route-quarantine.port.js";
import type { QuarantineEntry } from "../src/domain/model/quarantine.js";
import type { RouteEntry } from "../src/infrastructure/opencode/disk-agent-generator.js";

class MockQuarantinePort implements ModelRouteQuarantinePort {
  constructor(private entries: QuarantineEntry[]) {}

  async listActive(): Promise<ReadonlyArray<QuarantineEntry>> {
    return this.entries;
  }
}

function makeRoute(providerId: string, modelId: string): RouteEntry {
  return { baseTemplate: "sdd-mr-base", providerId, modelId };
}

test("permanent quarantine excludes as PERMANENTLY_QUARANTINED", async () => {
  const filter = new FilterFleetRoutesUseCase(
    new MockQuarantinePort([
      { level: "model", modelId: "gpt-4o", type: "permanent", reason: "model block" },
    ]),
  );

  const res = await filter.execute({
    routes: [makeRoute("openai", "gpt-4o"), makeRoute("anthropic", "claude-opus-5")],
  });

  assert.equal(res.included.length, 1, "non-quarantined route included");
  assert.equal(res.included[0].modelId, "claude-opus-5", "the right route is included");
  assert.equal(res.excluded.length, 1, "permanently quarantined route excluded");
  assert.equal(res.excluded[0].reason, "PERMANENTLY_QUARANTINED", "reason is the single literal");
  assert.match(res.excluded[0].detail, /model block/, "detail carries the quarantine reason");
});

test("TTL quarantine does NOT exclude at generation time", async () => {
  const filter = new FilterFleetRoutesUseCase(
    new MockQuarantinePort([
      {
        level: "model",
        modelId: "gpt-4o",
        type: "ttl",
        until: new Date(Date.now() + 3600_000),
        reason: "temp outage",
      },
    ]),
  );

  const res = await filter.execute({
    routes: [makeRoute("openai", "gpt-4o")],
  });

  assert.equal(res.included.length, 1, "TTL-quarantined route is still included for generation");
  assert.equal(res.included[0].modelId, "gpt-4o");
  assert.equal(res.excluded.length, 0);
});

test("disconnected provider is included (NOT_CONNECTED is gone)", async () => {
  // The previous contract excluded routes whose provider was not in the Prisma catalog.
  // Rev 2 removes that filter entirely: routes.json is the only inclusion authority,
  // and a route with an unknown provider is generated as an agent that fails loudly
  // on use, instead of being silently dropped.
  const filter = new FilterFleetRoutesUseCase(new MockQuarantinePort([]));

  const res = await filter.execute({
    routes: [makeRoute("nowhere", "phantom-7")],
  });

  assert.equal(res.included.length, 1, "the route is included even though no provider is connected");
  assert.equal(res.excluded.length, 0, "no NOT_CONNECTED exclusion is emitted");
  assert.equal(res.included[0].modelId, "phantom-7");
});

test("FilterFleetRoutesInput no longer carries excludedCanonicalIds", async () => {
  // The new input type is structural; the test only needs to confirm that
  // an input matching the new shape compiles and runs without using the
  // removed field. This is enforced at compile time by the new input type
  // (see `filter-fleet-routes.input.ts`).
  const input: import("../src/application/filter-fleet-routes/filter-fleet-routes.input.js").FilterFleetRoutesInput = {
    routes: [makeRoute("anthropic", "claude-opus-5")],
  };
  assert.equal((input as { excludedCanonicalIds?: unknown }).excludedCanonicalIds, undefined,
    "excludedCanonicalIds is no longer part of the input type");

  const filter = new FilterFleetRoutesUseCase(new MockQuarantinePort([]));
  const res = await filter.execute(input);
  assert.equal(res.included.length, 1);
  assert.equal(res.excluded.length, 0);
});
