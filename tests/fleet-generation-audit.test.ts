import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ModelRouteAuditLogger,
  type ModelRouteAuditEntry,
} from "../src/infrastructure/logging/model-route-audit.logger.js";

const TEST_DIR = path.resolve("./scratch/test-audit-fleet");

test("generation.route.excluded appends valid warning event", async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  const logPath = path.join(TEST_DIR, "audit.jsonl");
  const logger = new ModelRouteAuditLogger({ path: logPath });

  const entry: ModelRouteAuditEntry = {
    stage: "generation.route.excluded",
    status: "warning",
    correlationId: "test-corr-1",
    providerId: "openai",
    modelId: "gpt-4o",
    baseTemplate: "general",
    reason: "NOT_CONNECTED",
    detail: "Not present in persistent catalog",
    durationMs: 12,
  };

  await logger.append(entry);
  await logger.close();

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.stage, "generation.route.excluded");
  assert.equal(parsed.status, "warning");
  assert.equal(parsed.correlationId, "test-corr-1");
  assert.equal(parsed.providerId, "openai");
  assert.equal(parsed.modelId, "gpt-4o");
  assert.equal(parsed.baseTemplate, "general");
  assert.equal(parsed.reason, "NOT_CONNECTED");
  assert.equal(parsed.detail, "Not present in persistent catalog");
  assert.equal(typeof parsed.durationMs, "number");
  // Ensure no fabricated routing fields like requestedAlias or routedAgent exist
  assert.equal(parsed.requestedAlias, undefined);
  assert.equal(parsed.routedAgent, undefined);
});

test("generation.fleet.empty appends warning event with exact fields and no detail", async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  const logPath = path.join(TEST_DIR, "audit.jsonl");
  const logger = new ModelRouteAuditLogger({ path: logPath });

  const entry: ModelRouteAuditEntry = {
    stage: "generation.fleet.empty",
    status: "warning",
    correlationId: "test-corr-empty",
    excludedCount: 3,
    durationMs: 5,
  };

  await logger.append(entry);
  await logger.close();

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.stage, "generation.fleet.empty");
  assert.equal(parsed.status, "warning");
  assert.equal(parsed.correlationId, "test-corr-empty");
  assert.equal(parsed.excludedCount, 3);
  assert.equal(parsed.durationMs, 5);
  assert.equal("detail" in parsed, false);
  assert.equal(parsed.requestedAlias, undefined);
});

test("existing routing audit entry retains shape", async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  const logPath = path.join(TEST_DIR, "audit.jsonl");
  const logger = new ModelRouteAuditLogger({ path: logPath });

  const entry: ModelRouteAuditEntry = {
    stage: "routing.launch",
    status: "success",
    correlationId: "route-corr-1",
    requestedAlias: "claude",
    resolutionTier: "exact",
    resolvedProviderId: "anthropic",
    resolvedModelId: "claude-3-5-sonnet",
    routedAgent: "sdd-mr-v1-abc",
    quarantineChecked: true,
    durationMs: 4,
  };

  await logger.append(entry);
  await logger.close();

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.stage, "routing.launch");
  assert.equal(parsed.status, "success");
  assert.equal(parsed.routedAgent, "sdd-mr-v1-abc");
});

test("sanitizer strips secrets and audit write failure propagates", async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  const logPath = path.join(TEST_DIR, "audit.jsonl");
  const logger = new ModelRouteAuditLogger({ path: logPath });

  const entry = {
    stage: "generation.route.excluded",
    status: "warning",
    correlationId: "secret-test",
    providerId: "openai",
    modelId: "gpt-4o",
    baseTemplate: "general",
    reason: "NOT_CONNECTED",
    durationMs: 1,
    apiKey: "super-secret-key",
  } as unknown as ModelRouteAuditEntry;

  await logger.append(entry);
  await logger.close();

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.apiKey, undefined);

  // Closed logger failure propagates
  await assert.rejects(
    async () => logger.append(entry),
    (err: Error) => err.name === "ModelRouteAuditLoggerError",
  );
});
