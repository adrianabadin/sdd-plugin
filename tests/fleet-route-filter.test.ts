import assert from "node:assert/strict";
import { test } from "node:test";
import { FilterFleetRoutesUseCase } from "../src/application/filter-fleet-routes/filter-fleet-routes.use-case.js";
import type { ModelRouteCatalogPort, RouteCandidate } from "../src/ports/model-route-catalog.port.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../src/ports/quarantine-write.port.js";
import type { QuarantineEntry, QuarantineTarget } from "../src/domain/model/quarantine.js";
import type { RouteEntry } from "../src/infrastructure/opencode/disk-agent-generator.js";

class MockCatalogPort implements ModelRouteCatalogPort {
  constructor(private connectedKeys: Set<string>) {}

  async existsCanonical(providerId: string, modelId: string): Promise<boolean> {
    return this.connectedKeys.has(`${providerId}:${modelId}`);
  }

  async searchNormalized(_term: string, _limit: number): Promise<ReadonlyArray<RouteCandidate>> {
    return [];
  }
}

class MockQuarantinePort implements QuarantineWritePort {
  public listCallCount = 0;

  constructor(private entries: QuarantineEntry[]) {}

  async setQuarantine(_cmd: SetQuarantineCommand): Promise<QuarantineEntry> {
    throw new Error("Not implemented");
  }

  async releaseQuarantine(_target: QuarantineTarget): Promise<void> {
    throw new Error("Not implemented");
  }

  async listQuarantines(): Promise<QuarantineEntry[]> {
    this.listCallCount++;
    return this.entries;
  }
}

test("connected route included", async () => {
  const catalog = new MockCatalogPort(new Set(["anthropic:claude-3-5-sonnet"]));
  const quarantine = new MockQuarantinePort([]);
  const filter = new FilterFleetRoutesUseCase(catalog, quarantine);

  const route: RouteEntry = {
    baseTemplate: "general",
    providerId: "anthropic",
    modelId: "claude-3-5-sonnet",
  };

  const res = await filter.execute({ routes: [route] });
  assert.equal(res.included.length, 1);
  assert.equal(res.excluded.length, 0);
  assert.deepEqual(res.included[0], route);
});

test("disconnected or never-synced route excluded as NOT_CONNECTED", async () => {
  const catalog = new MockCatalogPort(new Set());
  const quarantine = new MockQuarantinePort([]);
  const filter = new FilterFleetRoutesUseCase(catalog, quarantine);

  const route: RouteEntry = {
    baseTemplate: "general",
    providerId: "openai",
    modelId: "gpt-4o",
  };

  const res = await filter.execute({ routes: [route] });
  assert.equal(res.included.length, 0);
  assert.equal(res.excluded.length, 1);
  assert.equal(res.excluded[0].reason, "NOT_CONNECTED");
});

test("permanent quarantine excluded as PERMANENTLY_QUARANTINED with precedence", async () => {
  const catalog = new MockCatalogPort(
    new Set(["openai:gpt-4o", "anthropic:claude-3-5-sonnet", "google:gemini-pro"]),
  );
  const quarantines: QuarantineEntry[] = [
    { level: "provider", providerId: "openai", type: "permanent", reason: "provider block" },
    { level: "model", modelId: "gpt-4o", type: "permanent", reason: "model block" },
    {
      level: "modelProvider",
      providerId: "openai",
      modelId: "gpt-4o",
      type: "permanent",
      reason: "modelProvider block",
    },
    { level: "model", modelId: "claude-3-5-sonnet", type: "permanent" },
  ];
  const quarantine = new MockQuarantinePort(quarantines);
  const filter = new FilterFleetRoutesUseCase(catalog, quarantine);

  const routes: RouteEntry[] = [
    { baseTemplate: "general", providerId: "openai", modelId: "gpt-4o" },
    { baseTemplate: "general", providerId: "anthropic", modelId: "claude-3-5-sonnet" },
  ];

  const res = await filter.execute({ routes });
  assert.equal(res.included.length, 0);
  assert.equal(res.excluded.length, 2);
  // Provider precedence wins over model and modelProvider
  assert.equal(res.excluded[0].reason, "PERMANENTLY_QUARANTINED");
  assert.match(res.excluded[0].detail, /provider/i);
  // Model precedence wins
  assert.equal(res.excluded[1].reason, "PERMANENTLY_QUARANTINED");
  assert.match(res.excluded[1].detail, /model/i);
});

test("TTL-only quarantine is included", async () => {
  const catalog = new MockCatalogPort(new Set(["openai:gpt-4o"]));
  const quarantines: QuarantineEntry[] = [
    {
      level: "model",
      modelId: "gpt-4o",
      type: "ttl",
      until: new Date(Date.now() + 3600000),
      reason: "temp outage",
    },
  ];
  const quarantine = new MockQuarantinePort(quarantines);
  const filter = new FilterFleetRoutesUseCase(catalog, quarantine);

  const route: RouteEntry = { baseTemplate: "general", providerId: "openai", modelId: "gpt-4o" };
  const res = await filter.execute({ routes: [route] });
  assert.equal(res.included.length, 1);
  assert.equal(res.excluded.length, 0);
});

test("order is preserved and listQuarantines called exactly once", async () => {
  const catalog = new MockCatalogPort(new Set(["p1:m1", "p2:m2", "p3:m3"]));
  const quarantine = new MockQuarantinePort([
    { level: "provider", providerId: "p2", type: "permanent" },
  ]);
  const filter = new FilterFleetRoutesUseCase(catalog, quarantine);

  const routes: RouteEntry[] = [
    { baseTemplate: "t1", providerId: "p1", modelId: "m1" },
    { baseTemplate: "t2", providerId: "p2", modelId: "m2" },
    { baseTemplate: "t3", providerId: "p3", modelId: "m3" },
  ];

  const res = await filter.execute({ routes });
  assert.equal(quarantine.listCallCount, 1);
  assert.equal(res.included.length, 2);
  assert.equal(res.included[0].providerId, "p1");
  assert.equal(res.included[1].providerId, "p3");
  assert.equal(res.excluded.length, 1);
  assert.equal(res.excluded[0].route.providerId, "p2");
});

test("connectivity checked before quarantine", async () => {
  const catalog = new MockCatalogPort(new Set()); // disconnected
  const quarantine = new MockQuarantinePort([
    { level: "provider", providerId: "p1", type: "permanent" },
  ]);
  const filter = new FilterFleetRoutesUseCase(catalog, quarantine);

  const route: RouteEntry = { baseTemplate: "t1", providerId: "p1", modelId: "m1" };
  const res = await filter.execute({ routes: [route] });
  assert.equal(res.excluded.length, 1);
  assert.equal(res.excluded[0].reason, "NOT_CONNECTED");
});

test("excludedCanonicalIds route excluded as CANARY_BLOCKED", async () => {
  const catalog = new MockCatalogPort(new Set(["openai:gpt-4o"]));
  const quarantine = new MockQuarantinePort([]);
  const filter = new FilterFleetRoutesUseCase(catalog, quarantine);

  const route: RouteEntry = { baseTemplate: "general", providerId: "openai", modelId: "gpt-4o" };

  const res = await filter.execute({
    routes: [route],
    excludedCanonicalIds: new Set(["openai/gpt-4o"]),
  });
  assert.equal(res.included.length, 0);
  assert.equal(res.excluded.length, 1);
  assert.equal(res.excluded[0].reason, "CANARY_BLOCKED");
  assert.equal(res.excluded[0].route.providerId, "openai");
});

test("NOT_CONNECTED takes precedence over CANARY_BLOCKED", async () => {
  const catalog = new MockCatalogPort(new Set()); // disconnected
  const quarantine = new MockQuarantinePort([]);
  const filter = new FilterFleetRoutesUseCase(catalog, quarantine);

  const route: RouteEntry = { baseTemplate: "general", providerId: "openai", modelId: "gpt-4o" };

  const res = await filter.execute({
    routes: [route],
    excludedCanonicalIds: new Set(["openai/gpt-4o"]),
  });
  assert.equal(res.included.length, 0);
  assert.equal(res.excluded.length, 1);
  assert.equal(res.excluded[0].reason, "NOT_CONNECTED");
});

test("TTL-only quarantine remains included when exclusion set does not contain the route", async () => {
  const catalog = new MockCatalogPort(new Set(["openai:gpt-4o"]));
  const quarantines: QuarantineEntry[] = [
    {
      level: "model",
      modelId: "gpt-4o",
      type: "ttl",
      until: new Date(Date.now() + 3600000),
      reason: "temp outage",
    },
  ];
  const quarantine = new MockQuarantinePort(quarantines);
  const filter = new FilterFleetRoutesUseCase(catalog, quarantine);

  const route: RouteEntry = { baseTemplate: "general", providerId: "openai", modelId: "gpt-4o" };
  const res = await filter.execute({
    routes: [route],
    excludedCanonicalIds: new Set(["google/gemini-pro"]),
  });
  assert.equal(res.included.length, 1);
  assert.equal(res.excluded.length, 0);
  assert.deepEqual(res.included[0], route);
});
