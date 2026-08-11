import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Manifest, ManifestRouteEntry } from "../src/infrastructure/opencode/disk-agent-generator.js";
import {
  CanaryBlockedError,
  ModelRouteCanary,
  type CanaryEvidence,
  type CanaryFailure,
  type CanaryHostTransport,
  type CanarySession,
} from "../src/infrastructure/opencode/model-route-canary.js";

function buildRoute(index: number, hostName: string, providerId: string, modelId: string): ManifestRouteEntry {
  const agentRelative = `.opencode/agents/${hostName}.md`;
  const commandRelative = `.opencode/commands/${hostName}.md`;
  return {
    baseTemplate: "base",
    providerId,
    modelId,
    hostName,
    agentFile: { relativePath: agentRelative, sha256: "a".repeat(64), bytes: 1 },
    commandFile: { relativePath: commandRelative, sha256: "b".repeat(64), bytes: 1 },
  };
}

function buildManifest(workspaceRoot: string, routes: ReadonlyArray<ManifestRouteEntry>): Manifest {
  const body = {
    schemaVersion: 1 as const,
    generatorVersion: "1.0.0",
    generationEpoch: "epoch-1",
    workspaceIdentity: path.resolve(workspaceRoot),
    routingNamespace: "sdd-mr-v1",
    descriptorBudgetBytes: 4096,
    requiredOpenCodeVersion: "1.18.9",
    routes,
    fileHashes: routes.flatMap((route) => [route.agentFile.sha256, route.commandFile.sha256]).sort(),
  };
  return { ...body, manifestHash: "c".repeat(64) };
}

class FakeCanaryTransport implements CanaryHostTransport {
  readonly createSessionCalls: string[] = [];
  private readonly parentModelBySession = new Map<string, { providerID: string; modelID: string }>();
  private readonly commands: string[] = [];
  private childListCalls = 0;
  constructor() {}

  async createSession(input: { parentModel: string }): Promise<CanarySession> {
    const id = `sess-${this.createSessionCalls.length}`;
    this.createSessionCalls.push(`${input.parentModel}`);
    const [providerID, modelID] = input.parentModel.split("/");
    if (!providerID || !modelID) throw new CanaryBlockedError("PARENT_MODEL_UNAVAILABLE", `bad parent model ${input.parentModel}`);
    const model = { providerID, modelID };
    this.parentModelBySession.set(id, model);
    return { id, model };
  }

  async getSession(sessionId: string): Promise<CanarySession> {
    const model = this.parentModelBySession.get(sessionId) ?? { providerID: "wrong", modelID: "wrong" };
    return { id: sessionId, model };
  }

  async invokeCommand(input: { sessionId: string; command: string; arguments: string; parentModel: string }): Promise<void> {
    this.commands.push(input.command);
  }

  async listChildren(_parentSessionId: string): Promise<ReadonlyArray<CanarySession>> {
    this.childListCalls += 1;
    return this.childListCalls % 2 === 1 ? [] : [{ id: "child-proven" }];
  }

  async listMessages(_childSessionId: string): Promise<ReadonlyArray<unknown>> {
    return [
      { info: { role: "user", model: { providerID: "google", modelID: "antigravity-gemini-3.6-flash-tiered" } } },
      { info: { role: "assistant", providerID: "google", modelID: "antigravity-gemini-3.6-flash-tiered", finish: "stop", time: { completed: 1 } } },
    ];
  }

  recordCommand(_command: string): void { /* noop helper for debug */ }
}

class FlakyCreateSessionTransport implements CanaryHostTransport {
  readonly createSessionCalls: number[] = [];
  private readonly bySession = new Map<string, { providerID: string; modelID: string }>();
  private readonly childrenListed = new Map<string, number>();
  private counter = 0;
  private failNextCreateSession = true;
  constructor(private readonly routes: ReadonlyArray<ManifestRouteEntry>) {}

  async createSession(input: { parentModel: string }): Promise<CanarySession> {
    const callNum = this.createSessionCalls.length;
    this.createSessionCalls.push(callNum);
    const [providerID, modelID] = input.parentModel.split("/");
    if (!providerID || !modelID) throw new CanaryBlockedError("PARENT_MODEL_UNAVAILABLE", `bad parent`);
    if (this.failNextCreateSession) {
      this.failNextCreateSession = false;
      throw new CanaryBlockedError("CHILD_SESSION_MISSING", `transient upstream failure on attempt ${callNum + 1}`);
    }
    const id = `sess-${this.counter++}`;
    this.bySession.set(id, { providerID, modelID });
    this.childrenListed.set(id, 0);
    return { id, model: { providerID, modelID } };
  }

  async getSession(sessionId: string): Promise<CanarySession> {
    const model = this.bySession.get(sessionId) ?? { providerID: "wrong", modelID: "wrong" };
    return { id: sessionId, model };
  }

  async invokeCommand(): Promise<void> { /* noop */ }
  async listChildren(parentSessionId: string): Promise<ReadonlyArray<CanarySession>> {
    const callCount = (this.childrenListed.get(parentSessionId) ?? 0) + 1;
    this.childrenListed.set(parentSessionId, callCount);
    return callCount === 1 ? [] : [{ id: "child-0" }];
  }

  async listMessages(): Promise<ReadonlyArray<unknown>> {
    return [
      { info: { role: "user", model: { providerID: "google", modelID: "antigravity-gemini-3.6-flash-tiered" } } },
      { info: { role: "assistant", providerID: "google", modelID: "antigravity-gemini-3.6-flash-tiered", finish: "stop", time: { completed: 1 } } },
    ];
  }
}

class AlwaysFailTransport implements CanaryHostTransport {
  readonly createSessionCalls: number[] = [];
  constructor(_routes: ReadonlyArray<ManifestRouteEntry>) {}
  async createSession(_input: { parentModel: string }): Promise<CanarySession> {
    this.createSessionCalls.push(this.createSessionCalls.length);
    throw new CanaryBlockedError("CHILD_SESSION_MISSING", "transient upstream failure (always-failing transport)");
  }
  async getSession(_sessionId: string): Promise<CanarySession> {
    return { id: "x", model: { providerID: "google", modelID: "antigravity-gemini-3.6-flash-tiered" } };
  }
  async invokeCommand(): Promise<void> { /* noop */ }
  async listChildren(): Promise<ReadonlyArray<CanarySession>> {
    return [];
  }
  async listMessages(): Promise<ReadonlyArray<unknown>> {
    return [];
  }
}

class BuggyTransport implements CanaryHostTransport {
  readonly createSessionCalls = 0;
  async createSession(_input: { parentModel: string }): Promise<CanarySession> {
    throw new Error("programming error: transport exploded");
  }
  async getSession(): Promise<CanarySession> { return { id: "x" }; }
  async invokeCommand(): Promise<void> { /* noop */ }
  async listChildren(): Promise<ReadonlyArray<CanarySession>> { return []; }
  async listMessages(): Promise<ReadonlyArray<unknown>> { return []; }
}

async function scenario1VerifyRoutesReturnsProvenAndBlocked(): Promise<void> {
  const route0 = buildRoute(0, "sdd-mr-v1-host-0", "google", "antigravity-gemini-3.6-flash-tiered");
  const route1 = buildRoute(1, "sdd-mr-v1-host-1", "openai", "gpt-4o");
  const manifest = buildManifest("/tmp/sdd-mr-iso-1", [route0, route1]);
  const transport = new FakeCanaryTransport();
  const canary = new ModelRouteCanary({
    transport,
    timeoutMs: 1_000,
    selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "anthropic/claude-haiku-4-5" : null,
  });

  const report = await canary.verifyRoutes(manifest);
  assert.equal(report.proven.length, 1, "one route passed the canary");
  assert.equal(report.blocked.length, 1, "one route was blocked");
  assert.equal(report.proven[0]!.hostName, route0.hostName);
  assert.equal(report.blocked[0]!.hostName, route1.hostName);
  assert.equal(report.blocked[0]!.targetCanonicalId, "openai/gpt-4o");
  console.log("  pass: verifyRoutes returns proven + blocked without rejecting on per-route failure");
}

async function scenario2BlockedEntryShape(): Promise<void> {
  const route = buildRoute(0, "sdd-mr-v1-host-shape", "openai", "gpt-4o");
  const manifest = buildManifest("/tmp/sdd-mr-iso-2", [route]);
  const transport = new FakeCanaryTransport();
  const canary = new ModelRouteCanary({
    transport,
    timeoutMs: 1_000,
    selectParentModel: async () => null,
  });

  const report = await canary.verifyRoutes(manifest);
  assert.equal(report.proven.length, 0);
  assert.equal(report.blocked.length, 1);

  const failure: CanaryFailure = report.blocked[0]!;
  assert.equal(failure.hostName, route.hostName);
  assert.equal(failure.targetCanonicalId, "openai/gpt-4o");
  assert.equal(failure.code, "PARENT_MODEL_UNAVAILABLE");
  assert.equal(typeof failure.message, "string");
  assert.ok(failure.message.length > 0, "blocked message is non-empty");
  assert.equal(failure.attempts, 2, "default canaryRetries=1 means 1+1=2 attempts recorded");
  console.log("  pass: blocked entry carries hostName, targetCanonicalId, code, message, attempts");
}

async function scenario3RetryThenSucceedProven(): Promise<void> {
  const route = buildRoute(0, "sdd-mr-v1-host-retry", "google", "antigravity-gemini-3.6-flash-tiered");
  const manifest = buildManifest("/tmp/sdd-mr-iso-3", [route]);
  const transport = new FlakyCreateSessionTransport([route]);
  const canary = new ModelRouteCanary({
    transport,
    timeoutMs: 1_000,
    canaryRetries: 1,
    selectParentModel: async () => "anthropic/claude-haiku-4-5",
  });

  const report = await canary.verifyRoutes(manifest);
  assert.equal(report.proven.length, 1, "route eventually proven after one retry");
  assert.equal(report.blocked.length, 0);
  assert.ok(transport.createSessionCalls.length >= 2, "failure path must trigger a fresh createSession call (retry is not a no-op)");
  const evidence: CanaryEvidence = report.proven[0]!;
  assert.equal(evidence.hostName, route.hostName);
  assert.equal(evidence.targetCanonicalId, "google/antigravity-gemini-3.6-flash-tiered");
  assert.equal(evidence.parentCanonicalId, "anthropic/claude-haiku-4-5");
  console.log("  pass: route failing once then succeeding is proven when canaryRetries = 1");
}

async function scenario4AlwaysFailingAppearsOnce(): Promise<void> {
  const route = buildRoute(0, "sdd-mr-v1-host-always", "openai", "gpt-4o");
  const manifest = buildManifest("/tmp/sdd-mr-iso-4", [route]);
  const transport = new AlwaysFailTransport([route]);
  const canary = new ModelRouteCanary({
    transport,
    timeoutMs: 1_000,
    canaryRetries: 3,
    selectParentModel: async () => "anthropic/claude-haiku-4-5",
  });

  const report = await canary.verifyRoutes(manifest);
  assert.equal(report.proven.length, 0);
  assert.equal(report.blocked.length, 1, "exactly one blocked entry per always-failing route");
  assert.equal(report.blocked[0]!.hostName, route.hostName);
  assert.equal(report.blocked[0]!.attempts, 4, "1 + canaryRetries=3 means 4 attempts recorded");
  assert.ok(transport.createSessionCalls.length >= 4, "retry budget was actually consumed by the transport");
  console.log("  pass: route failing every attempt appears exactly once in blocked");
}

async function scenario5VerifyEveryRouteStillThrows(): Promise<void> {
  const route0 = buildRoute(0, "sdd-mr-v1-host-r0", "google", "antigravity-gemini-3.6-flash-tiered");
  const route1 = buildRoute(1, "sdd-mr-v1-host-r1", "openai", "gpt-4o");
  const manifest = buildManifest("/tmp/sdd-mr-iso-5", [route0, route1]);
  const transport = new FakeCanaryTransport();
  const canary = new ModelRouteCanary({
    transport,
    timeoutMs: 1_000,
    selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "anthropic/claude-haiku-4-5" : null,
  });

  await assert.rejects(
    canary.verifyEveryRoute(manifest),
    (error: unknown) => error instanceof CanaryBlockedError && error.code === "PARENT_MODEL_UNAVAILABLE",
    "verifyEveryRoute still throws the original CanaryBlockedError when any route is blocked",
  );
  console.log("  pass: verifyEveryRoute still throws when any route is blocked (backwards compatibility)");
}

async function scenario6NonCanaryBlockedErrorPropagates(): Promise<void> {
  const route = buildRoute(0, "sdd-mr-v1-host-prog", "google", "antigravity-gemini-3.6-flash-tiered");
  const manifest = buildManifest("/tmp/sdd-mr-iso-6", [route]);
  const transport = new BuggyTransport();
  const canary = new ModelRouteCanary({
    transport,
    timeoutMs: 1_000,
    canaryRetries: 5,
    selectParentModel: async () => "anthropic/claude-haiku-4-5",
  });

  await assert.rejects(
    canary.verifyRoutes(manifest),
    (error: unknown) => error instanceof CanaryBlockedError === false && error instanceof Error && error.message === "programming error: transport exploded",
    "non-CanaryBlockedError rejections propagate untouched even with retries available",
  );
  console.log("  pass: non-CanaryBlockedError rejections propagate untouched");
}

async function run(): Promise<void> {
  console.log("--- model route canary isolation (WU1) ---");
  mkdirSync("/tmp/sdd-mr-iso", { recursive: true });
  await scenario1VerifyRoutesReturnsProvenAndBlocked();
  await scenario2BlockedEntryShape();
  await scenario3RetryThenSucceedProven();
  await scenario4AlwaysFailingAppearsOnce();
  await scenario5VerifyEveryRouteStillThrows();
  await scenario6NonCanaryBlockedErrorPropagates();
  console.log("model route canary isolation: ok");
}

await run();
