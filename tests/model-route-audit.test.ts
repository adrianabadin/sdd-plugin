/**
 * Unit 5 (RED) — synchronous durable JSONL audit logger tests.
 *
 * Required behavior:
 *  - One JSON object per line, ending with a newline.
 *  - Each append is followed by fsync (synchronous flush).
 *  - File created with mode 0600 (owner-only).
 *  - Sanitizes sensitive keys (token, password, secret, apiKey, ...).
 *  - Bounded: field values are clamped to a max byte length.
 *  - AUDIT_WRITE_FAILED: any sync-failure (open, write, fsync) throws and
 *    the routing hook must fail-closed.
 */

import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ModelRouteAuditLogger, ModelRouteAuditLoggerError, type RoutingAuditEntry } from "../src/infrastructure/logging/model-route-audit.logger.js";

async function sleep(ms: number): Promise<void> { await new Promise<void>((r) => setTimeout(r, ms)); }
async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(50 * (attempt + 1)); }
  }
}

function baseEntry(overrides: Partial<RoutingAuditEntry> = {}): RoutingAuditEntry {
  return {
    stage: "routing.launch",
    status: "success",
    correlationId: "call-x",
    requestedAlias: "openai/gpt-4o",
    resolutionTier: "exact",
    resolvedProviderId: "openai",
    resolvedModelId: "gpt-4o",
    routedAgent: "sdd-mr-v1-abc",
    quarantineChecked: true,
    durationMs: 1,
    ...overrides,
  };
}

async function run(): Promise<void> {
  console.log("--- model-route audit logger (RED) ---");

  const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-audit-"));
  const logPath = path.join(tmp, "audit.jsonl");

  try {
    const logger = new ModelRouteAuditLogger({ path: logPath });
    await logger.append(baseEntry({
      correlationId: "call-1",
      requestedAlias: "google/antigravity-gemini-3.6-flash-tiered",
      resolvedProviderId: "google",
      resolvedModelId: "antigravity-gemini-3.6-flash-tiered",
      routedAgent: "sdd-mr-v1-0c7309e06a9d5324",
      durationMs: 12,
    }));

    const raw = readFileSync(logPath, "utf8");
    assert.ok(raw.endsWith("\n"), "audit line ends with newline");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 1, "one entry per line");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry["stage"], "routing.launch");
    assert.equal(entry["status"], "success");
    assert.equal(entry["routedAgent"], "sdd-mr-v1-0c7309e06a9d5324");
    assert.equal(entry["quarantineChecked"], true);
    assert.equal(typeof entry["ts"], "number");

    if (process.platform !== "win32") {
      const stat = statSync(logPath);
      assert.equal(stat.mode & 0o777, 0o600, "audit file mode is 0600");
    }

    // Sensitive keys are stripped at any depth.
    await logger.append(baseEntry({
      correlationId: "call-2",
      token: "sk-AAAAAAAAAAA",
      apiKey: "leaked",
      password: "topsecret",
      secret: "shh",
      cookie: "session=xyz",
      nested: { token: "nested-leak", safe: "ok" },
    }));
    const lines2 = readFileSync(logPath, "utf8").trim().split("\n");
    const entry2 = JSON.parse(lines2[1]!) as Record<string, unknown>;
    for (const forbidden of ["token", "apiKey", "password", "secret", "cookie"]) {
      assert.equal(entry2[forbidden], undefined, `${forbidden} is stripped`);
    }
    const nested = entry2["nested"] as Record<string, unknown> | undefined;
    assert.equal(nested?.["token"], undefined, "nested sensitive key is stripped");
    assert.equal(nested?.["safe"], "ok", "nested safe key is preserved");

    // Field bounding: long strings are clamped.
    const tooLong = "x".repeat(20_000);
    await logger.append(baseEntry({ correlationId: "call-3", requestedAlias: tooLong }));
    const lines3 = readFileSync(logPath, "utf8").trim().split("\n");
    const bounded = JSON.parse(lines3[2]!)["requestedAlias"] as string;
    assert.ok(bounded.length <= 4096, `requestedAlias clamped to <=4096 bytes (got ${bounded.length})`);

    // routing.blocked stage is honored.
    await logger.append(baseEntry({
      correlationId: "call-4",
      stage: "routing.blocked",
      status: "error",
      requestedAlias: "openai/gpt-4-turbo",
      resolvedModelId: "gpt-4-turbo",
      routedAgent: "sdd-mr-v1-xyz",
      errorClass: "QuarantinedModelError",
    }));
    const lines4 = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines4.length, 4);
    const entry4 = JSON.parse(lines4[3]!) as Record<string, unknown>;
    assert.equal(entry4["stage"], "routing.blocked");
    assert.equal(entry4["errorClass"], "QuarantinedModelError");

    // AUDIT_WRITE_FAILED: fsync failure surfaces as a typed error.
    if (process.platform !== "win32") {
      const badPath = path.join(tmp, "no-such-dir", "audit.jsonl");
      const failingLogger = new ModelRouteAuditLogger({ path: badPath });
      let caught: unknown = null;
      try {
        await failingLogger.append(baseEntry({ correlationId: "call-5" }));
      } catch (err) { caught = err; }
      assert.ok(caught instanceof ModelRouteAuditLoggerError, "audit failure surfaces as typed error");
      assert.equal((caught as ModelRouteAuditLoggerError).code, "AUDIT_WRITE_FAILED");
    }

    // Closing is idempotent.
    await logger.close();
    await logger.close();
    assert.ok(existsSync(logPath), "audit file persisted across close");

    console.log("All audit logger assertions passed.");
  } finally {
    await cleanupDir(tmp);
  }
}

run().catch((err: unknown) => { console.error(err); process.exit(1); });
