import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Manifest } from "../src/infrastructure/opencode/disk-agent-generator.js";
import {
  CanaryBlockedError,
  ModelRouteCanary,
  OpenCodeHttpCanaryTransport,
  type CanaryHostTransport,
} from "../src/infrastructure/opencode/model-route-canary.js";
import {
  AttestationMismatchError,
  ModelRouteReadiness,
  REQUIRED_OPENCODE_VERSION,
} from "../src/infrastructure/opencode/model-route-readiness.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripSignature(value: Record<string, unknown>): Record<string, unknown> {
  const { signature: _omitted, ...rest } = value;
  return rest;
}

function fixture(routeCount = 2): { root: string; manifest: Manifest } {
  const root = path.join(tmpdir(), `sdd-mr-ready-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(path.join(root, ".opencode", "sdd-model-routing"), { recursive: true });
  const routes = Array.from({ length: routeCount }, (_, index) => {
    const agentRelative = path.join(".opencode", "agents", `sdd-mr-v1-${index}.md`);
    const commandRelative = path.join(".opencode", "commands", `sdd-mr-canary-v1-${index}.md`);
    mkdirSync(path.dirname(path.join(root, agentRelative)), { recursive: true });
    mkdirSync(path.dirname(path.join(root, commandRelative)), { recursive: true });
    const agent = `agent-${index}`;
    const command = `command-${index}`;
    writeFileSync(path.join(root, agentRelative), agent);
    writeFileSync(path.join(root, commandRelative), command);
    return {
      baseTemplate: "base",
      providerId: `provider-${index}`,
      modelId: `model-${index}`,
      hostName: `sdd-mr-v1-host-${index}`,
      agentFile: { relativePath: agentRelative, sha256: sha256(agent), bytes: agent.length },
      commandFile: { relativePath: commandRelative, sha256: sha256(command), bytes: command.length },
    };
  });
  const body = {
    schemaVersion: 1 as const,
    generatorVersion: "1.1.0",
    generationEpoch: "epoch-1",
    workspaceIdentity: path.resolve(root),
    routingNamespace: "sdd-mr-v1",
    descriptorBudgetBytes: 4096,
    requiredOpenCodeVersion: REQUIRED_OPENCODE_VERSION,
    routes,
    fileHashes: routes.flatMap((route) => [route.agentFile.sha256, route.commandFile.sha256]).sort(),
  };
  const manifest: Manifest = { ...body, manifestHash: sha256(JSON.stringify(body)) };
  writeFileSync(path.join(root, ".opencode", "sdd-model-routing", "manifest.json"), JSON.stringify(manifest));
  return { root, manifest };
}

function transportFor(manifest: Manifest, mutate?: (hostIndex: number, messages: unknown[]) => unknown[]): CanaryHostTransport & { commands: string[] } {
  const commands: string[] = [];
  let childListCalls = 0;
  const parentModelBySession = new Map<string, { providerID: string; modelID: string }>();
  return {
    commands,
    async createSession(input) {
      const [providerID, modelID] = input.parentModel.split("/");
      const id = "parent-session";
      const model = { providerID, modelID };
      parentModelBySession.set(id, model);
      return { id, model };
    },
    async getSession(id) {
      const model = parentModelBySession.get(id) ?? { providerID: "provider-x", modelID: "model-x" };
      return { id, model };
    },
    async invokeCommand(input) { commands.push(input.command); },
    async listChildren() {
      childListCalls += 1;
      return childListCalls % 2 === 1 ? [] : manifest.routes.map((_, index) => ({ id: `child-${index}` }));
    },
    async listMessages(childId) {
      const index = Number(childId.split("-").at(-1));
      const route = manifest.routes[index]!;
      // Role-aware 1.18.9 metadata: user identity is nested under info.model;
      // assistant identity is direct and must carry non-empty finish + time.completed.
      const messages: unknown[] = [
        { info: { role: "user", model: { providerID: route.providerId, modelID: route.modelId } } },
        {
          info: {
            role: "assistant",
            providerID: route.providerId,
            modelID: route.modelId,
            finish: "stop",
            time: { completed: 1_700_000_000_000 },
          },
        },
      ];
      return mutate?.(index, messages) ?? messages;
    },
  };
}

async function assertSessionPayload(): Promise<void> {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const transport = new OpenCodeHttpCanaryTransport({
    baseUrl: "http://127.0.0.1:4891/",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ data: { id: "parent-session" } }), { status: 200 });
    },
  });

  await transport.createSession({ parentModel: "provider/parent-model" });
  assert.deepEqual(requests, [{
    url: "http://127.0.0.1:4891/session",
    body: { title: "sdd model routing canary (provider/parent-model)", model: { providerID: "provider", id: "parent-model" } },
  }]);
  await assert.rejects(
    transport.createSession({ parentModel: "provider/parent/model" }),
    (error: unknown) => error instanceof CanaryBlockedError && error.code === "PARENT_MODEL_UNAVAILABLE",
  );
}

async function assertCommandAckDoesNotWaitForCompletion(): Promise<void> {
  let aborted = false;
  const transport = new OpenCodeHttpCanaryTransport({
    baseUrl: "http://127.0.0.1:4891/",
    commandAckTimeoutMs: 5,
    fetchImpl: (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("The operation timed out", "TimeoutError"));
      });
    }),
  });

  const started = Date.now();
  await transport.invokeCommand({
    sessionId: "parent-session",
    command: "sdd-mr-canary-v1-host",
    arguments: "sdd-model-routing-canary:sdd-mr-v1-host",
    parentModel: "provider/parent-model",
  });
  assert.equal(aborted, true, "command acknowledgement timeout aborts the HTTP wait");
  assert.ok(Date.now() - started < 1_000, "command polling starts without waiting for conversational completion");
}

async function run(): Promise<void> {
  console.log("--- model route canary + readiness ---");
  await assertSessionPayload();
  await assertCommandAckDoesNotWaitForCompletion();
  const { root, manifest } = fixture();
  try {
    const transport = transportFor(manifest);
    const canary = new ModelRouteCanary({
      transport,
      timeoutMs: 1_000,
      selectParentModel: async (target) => target === "provider-0/model-0" ? "provider-x/model-x" : "provider-y/model-y",
    });
    const evidence = await canary.verifyEveryRoute(manifest);
    assert.equal(evidence.length, manifest.routes.length, "every manifest route is canaried without sampling");
    assert.deepEqual(transport.commands.sort(), ["sdd-mr-canary-v1-0", "sdd-mr-canary-v1-1"]);
    assert.ok(evidence.every((entry) => entry.parentCanonicalId !== entry.targetCanonicalId));
    assert.ok(evidence.every((entry) => entry.childSessionId.startsWith("child-")));

    let delayedMessageCalls = 0;
    const delayedTransport = transportFor(manifest);
    const delayedMessages = delayedTransport.listMessages.bind(delayedTransport);
    const eventualTransport: CanaryHostTransport = {
      ...delayedTransport,
      async listMessages(childId) {
        delayedMessageCalls += 1;
        const messages = await delayedMessages(childId);
        return delayedMessageCalls === 1 ? messages.slice(0, 1) : messages;
      },
    };
    const eventualEvidence = await new ModelRouteCanary({
      transport: eventualTransport,
      timeoutMs: 1_000,
      selectParentModel: async () => "provider-x/model-x",
    }).verifyEveryRoute(manifest);
    assert.equal(eventualEvidence.length, manifest.routes.length, "canary polls until completed metadata is observable");

    await assert.rejects(
      new ModelRouteCanary({ transport, timeoutMs: 1_000, selectParentModel: async (target) => target }).verifyEveryRoute(manifest),
      (error: unknown) => error instanceof CanaryBlockedError && error.code === "PARENT_MODEL_UNAVAILABLE",
    );
    await assert.rejects(
      new ModelRouteCanary({ ...({ transport: { ...transport, listChildren: async () => [] } }), timeoutMs: 1_000, selectParentModel: async () => "other/model" }).verifyEveryRoute(manifest),
      (error: unknown) => error instanceof CanaryBlockedError && error.code === "CHILD_SESSION_MISSING",
    );
    // Flattened legacy user message structure must be rejected under 1.18.9
    // (user identity is nested under info.model, not flattened). Because the
    // sibling child has observable metadata that simply does not match the
    // route target, the route-level verdict is MISMATCH (not UNOBSERVABLE);
    // the route is blocked either way.
    const mismatch = transportFor(manifest, (index, messages) => index === 0
      ? [{ info: { role: "user", providerID: "fallback", modelID: "parent" } }, messages[1]]
      : messages);
    await assert.rejects(
      new ModelRouteCanary({ transport: mismatch, timeoutMs: 1_000, selectParentModel: async () => "other/model" }).verifyEveryRoute(manifest),
      (error: unknown) => error instanceof CanaryBlockedError && (error.code === "CANARY_METADATA_MISMATCH" || error.code === "CANARY_METADATA_UNOBSERVABLE"),
      "flattened legacy user info is rejected under 1.18.9 (must be nested under info.model)",
    );
    // Single-child setup isolates UNOBSERVABLE: flattened user structure on
    // every observable child yields CANARY_METADATA_UNOBSERVABLE.
    let singleChildCalls = 0;
    const singleChildTransport: CanaryHostTransport = {
      async createSession(input) {
        const [providerID, modelID] = input.parentModel.split("/");
        return { id: "p", model: { providerID, modelID } };
      },
      async getSession(input_id) { return { id: input_id, model: { providerID: "other", modelID: "model" } }; },
      async invokeCommand() { /* noop */ },
      async listChildren() {
        singleChildCalls += 1;
        return singleChildCalls % 2 === 1 ? [] : [{ id: "c-0" }];
      },
      async listMessages() {
        return [
          { info: { role: "user", providerID: "flat", modelID: "legacy" } },
          { info: { role: "assistant", providerID: "p", modelID: "m", finish: "stop", time: { completed: 1 } } },
        ];
      },
    };
    const singleRouteManifest: Manifest = { ...manifest, routes: [manifest.routes[0]!] };
    await assert.rejects(
      new ModelRouteCanary({ transport: singleChildTransport, timeoutMs: 1_000, selectParentModel: async () => "other/model" }).verifyEveryRoute(singleRouteManifest),
      (error: unknown) => error instanceof CanaryBlockedError && error.code === "CANARY_METADATA_UNOBSERVABLE",
      "flattened legacy user info on every child yields CANARY_METADATA_UNOBSERVABLE",
    );
    // Nested user info that resolves to a different canonical ID is a real
    // mismatch (not merely unobservable metadata).
    const nestedMismatch = transportFor(manifest, (index, messages) => index === 0
      ? [{ info: { role: "user", model: { providerID: "fallback", modelID: "parent" } } }, messages[1]]
      : messages);
    await assert.rejects(
      new ModelRouteCanary({ transport: nestedMismatch, timeoutMs: 1_000, selectParentModel: async () => "other/model" }).verifyEveryRoute(manifest),
      (error: unknown) => error instanceof CanaryBlockedError && error.code === "CANARY_METADATA_MISMATCH",
      "nested user info with wrong canonical ID is rejected as a mismatch",
    );
    // Assistant identity without non-empty finish + time.completed is
    // unobservable under 1.18.9 (must prove completion).
    const incomplete = transportFor(manifest, (_index, messages) => [
      messages[0],
      { info: { role: "assistant", providerID: "provider-0", modelID: "model-0", finish: "stop" } },
    ]);
    await assert.rejects(
      new ModelRouteCanary({ transport: incomplete, timeoutMs: 1_000, selectParentModel: async () => "other/model" }).verifyEveryRoute(manifest),
      (error: unknown) => error instanceof CanaryBlockedError && error.code === "CANARY_METADATA_UNOBSERVABLE",
      "assistant identity without time.completed is unobservable",
    );
    // Flattened legacy assistant info is also unobservable.
    const flatAssistant = transportFor(manifest, (_index, messages) => [
      messages[0],
      { info: { role: "assistant", model: { providerID: "provider-0", modelID: "model-0" }, finish: "stop", time: { completed: 1 } } },
    ]);
    await assert.rejects(
      new ModelRouteCanary({ transport: flatAssistant, timeoutMs: 1_000, selectParentModel: async () => "other/model" }).verifyEveryRoute(manifest),
      (error: unknown) => error instanceof CanaryBlockedError && error.code === "CANARY_METADATA_UNOBSERVABLE",
      "flattened legacy assistant info is rejected under 1.18.9 (must be direct on info)",
    );

    let now = 1_000;
    const readiness = new ModelRouteReadiness({ workspaceRoot: root, now: () => now, nonce: () => "nonce-1", signingKey: Buffer.from("explicit-key", "utf8") });
    const attestation = readiness.issue({
      manifest,
      evidence,
      openCodeVersion: REQUIRED_OPENCODE_VERSION,
      bootIdentity: "boot-a",
      ttlMs: 500,
    });
    assert.equal(attestation.openCodeVersion, REQUIRED_OPENCODE_VERSION);
    assert.equal(attestation.workspaceIdentity, manifest.workspaceIdentity);
    assert.equal(attestation.generationEpoch, manifest.generationEpoch);
    assert.equal(attestation.manifestHash, manifest.manifestHash);
    assert.deepEqual(attestation.fileHashes, [...manifest.fileHashes].sort());
    assert.equal(attestation.bootIdentity, "boot-a");
    assert.equal(attestation.nonce, "nonce-1");
    assert.equal(attestation.verifierVersion, "1.0.0");
    assert.equal(readiness.verify({ manifest, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a" }).nonce, "nonce-1");
    const stored = readFileSync(path.join(root, ".opencode", "sdd-model-routing", "attestation.json"), "utf8");
    assert.equal(JSON.parse(stored).nonce, "nonce-1", "attestation persists under owned routing directory");

    // 1.18.4 attestations are explicitly rejected as stale under the 1.18.9 contract.
    assert.throws(
      () => readiness.issue({ manifest, evidence, openCodeVersion: "1.18.4", bootIdentity: "boot-a", ttlMs: 500 }),
      /unsupported OpenCode version 1\.18\.4/,
      "issuing an attestation with 1.18.4 is rejected",
    );
    // Older 1.18.4 attestation bodies (stale on disk) are rejected on verify.
    const stale = JSON.parse(stored) as Record<string, unknown>;
    stale["openCodeVersion"] = "1.18.4";
    stale["signature"] = createHmac("sha256", Buffer.from("explicit-key")).update(JSON.stringify(stripSignature(stale))).digest("hex");
    writeFileSync(path.join(root, ".opencode", "sdd-model-routing", "attestation.json"), JSON.stringify(stale, null, 2));
    assert.throws(
      () => readiness.verify({ manifest, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a" }),
      AttestationMismatchError,
      "verify rejects an on-disk attestation still pinned to 1.18.4",
    );
// Re-issue a valid 1.18.9 attestation for the rest of the suite.
    const reissued = readiness.issue({ manifest, evidence, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a", ttlMs: 500 });
    assert.equal(reissued.openCodeVersion, REQUIRED_OPENCODE_VERSION);

    // Semver gate: patch/minor updates within the same major are transparent
    // (a routine runtime update must not force a supervisor re-boot).
    const patched = readiness.issue({ manifest, evidence, openCodeVersion: "1.18.18", bootIdentity: "boot-a", ttlMs: 500 });
    assert.equal(patched.openCodeVersion, "1.18.18", "attestation records the real emitting version");
    assert.equal(
      readiness.verify({ manifest, openCodeVersion: "1.18.18", bootIdentity: "boot-a" }).nonce,
      "nonce-1",
      "patch update verifies against the same minor without regeneration",
    );
    const minorBump = readiness.issue({ manifest, evidence, openCodeVersion: "1.19.0", bootIdentity: "boot-a", ttlMs: 500 });
    assert.equal(
      readiness.verify({ manifest, openCodeVersion: "1.19.0", bootIdentity: "boot-a" }).nonce,
      "nonce-1",
      "minor update within the same major verifies",
    );
    const newerPatch = readiness.issue({ manifest, evidence, openCodeVersion: "1.19.1", bootIdentity: "boot-a", ttlMs: 500 });
    assert.throws(
      () => readiness.verify({ manifest, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a" }),
      /drifted beyond patch/,
      "minor drift between the issuing and verifying runtimes requires a re-issue",
    );
    assert.throws(
      () => readiness.issue({ manifest, evidence, openCodeVersion: "2.0.0", bootIdentity: "boot-a", ttlMs: 500 }),
      /unsupported OpenCode version 2\.0\.0/,
      "a newer major is never silently accepted: the SDK surface is only audited inside one major",
    );
    // Restore the REQUIRED-version attestation for the rest of the suite.
    readiness.issue({ manifest, evidence, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a", ttlMs: 500 });

    for (const changed of [
      { openCodeVersion: "1.18.10", bootIdentity: "boot-a" },
      { openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-b" },
    ]) {
      assert.throws(() => readiness.verify({ manifest, ...changed }), AttestationMismatchError);
    }
    now = 1_501;
    assert.throws(() => readiness.verify({ manifest, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a" }), /ATTESTATION_EXPIRED/);
    now = 1_100;
    const lockPath = path.join(root, ".opencode", "sdd-model-routing", "generator.lock");
    writeFileSync(lockPath, "active");
    assert.throws(() => readiness.verify({ manifest, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a" }), /generator lock/);
    unlinkSync(lockPath);
    const journalPath = path.join(root, ".opencode", "sdd-model-routing", "journal");
    mkdirSync(journalPath, { recursive: true });
    writeFileSync(path.join(journalPath, "pending.bak"), "pending");
    assert.throws(() => readiness.verify({ manifest, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a" }), /journal/);
    rmSync(journalPath, { recursive: true, force: true });
    const changedWorkspace = { ...manifest, workspaceIdentity: path.join(root, "other") };
    assert.throws(() => readiness.verify({ manifest: changedWorkspace, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a" }), AttestationMismatchError);
    const changedEpoch = { ...manifest, generationEpoch: "epoch-2" };
    assert.throws(() => readiness.verify({ manifest: changedEpoch, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a" }), AttestationMismatchError);
    const changedManifest = { ...manifest, manifestHash: "0".repeat(64) };
    assert.throws(() => readiness.verify({ manifest: changedManifest, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a" }), AttestationMismatchError);
    writeFileSync(path.join(root, manifest.routes[0]!.agentFile.relativePath), "drift");
    assert.throws(() => readiness.verify({ manifest, openCodeVersion: REQUIRED_OPENCODE_VERSION, bootIdentity: "boot-a" }), AttestationMismatchError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("model route canary + readiness: ok");
}

await run();
