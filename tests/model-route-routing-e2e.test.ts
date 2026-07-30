/**
 * Unit 5 (RED) — full real-host routing E2E test.
 *
 * When `OPENCODE_E2E_ROUTING=1` is set, this test wires the live HTTP
 * transport into `ModelRouteTaskHook` and exercises the full pipeline
 * (parse → resolve → quarantine → attestation → audit → rewrite). When
 * the gate is absent (the default) it MUST report BLOCKED with the exact
 * env var recipe; it MUST NOT claim success.
 *
 * Unit 6 contract: this harness MUST consume a real canary-issued
 * attestation. It MUST NOT manufacture evidence or an attestation. If no
 * real attestation exists on disk, the run is BLOCKED.
 *
 * Design: 0695919c-2264-4e0d-a3fb-f7d4190661fc.
 */

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

import { ModelRouteTaskHook } from "../src/infrastructure/opencode/model-route-task-hook.js";
import { ModelRouteResolver } from "../src/domain/model-routing/model-route-resolver.js";
import { PrismaModelRouteCatalogAdapter } from "../src/infrastructure/prisma/model-route-catalog.adapter.js";
import { PrismaModelRouteQuarantineAdapter } from "../src/infrastructure/prisma/model-route-quarantine.adapter.js";
import { REQUIRED_OPENCODE_VERSION } from "../src/infrastructure/opencode/model-route-readiness.js";
import { QuarantineStoreImpl } from "../src/infrastructure/runtime/quarantine-store.js";

const REQUIRED_COMMAND = "set OPENCODE_E2E_ROUTING=1 && set OPENCODE_E2E_URL=http://127.0.0.1:4096 && set OPENCODE_E2E_BOOT_ID=<stable-boot-nonce> && set OPENCODE_E2E_SIGNING_KEY=<shared-hmac-secret> && set OPENCODE_E2E_DB_PATH=<path-to-db> && set OPENCODE_E2E_WORKSPACE=<path-to-workspace> && npx tsx tests/model-route-routing-e2e.test.ts";

async function main(): Promise<void> {
  if (process.env["OPENCODE_E2E_ROUTING"] !== "1") {
    console.error(`BLOCKED: full real-host routing E2E is explicitly gated. Exact command: ${REQUIRED_COMMAND}`);
    process.exit(2);
    return;
  }
  const baseUrl = process.env["OPENCODE_E2E_URL"];
  const bootIdentity = process.env["OPENCODE_E2E_BOOT_ID"];
  const signingKey = process.env["OPENCODE_E2E_SIGNING_KEY"];
  const dbPath = process.env["OPENCODE_E2E_DB_PATH"];
  const workspaceRoot = process.env["OPENCODE_E2E_WORKSPACE"];
  if (!baseUrl || !bootIdentity || bootIdentity === "boot-default" || !signingKey || signingKey === "deterministic-key" || !dbPath || !workspaceRoot) {
    console.error(`BLOCKED: missing or insecure env vars. Required: ${REQUIRED_COMMAND}`);
    process.exit(2);
    return;
  }

  const healthResponse = await fetch(`${baseUrl.replace(/\/$/, "")}/global/health`);
  if (!healthResponse.ok) throw new Error(`BLOCKED: GET /global/health returned ${healthResponse.status}`);
  const health = await healthResponse.json() as { version?: string; data?: { version?: string } };
  const runtimeVersion = health.version ?? health.data?.version;
  if (runtimeVersion !== REQUIRED_OPENCODE_VERSION) {
    throw new Error(`BLOCKED: exact OpenCode ${REQUIRED_OPENCODE_VERSION} required; observed ${runtimeVersion ?? "unobservable"}`);
  }

  execSync("npx prisma db push --accept-data-loss", { stdio: "ignore", env: { ...process.env, DATABASE_URL: `file:${dbPath}` } });
  const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${dbPath}` }) });

  const manifestPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`BLOCKED: expected manifest at ${manifestPath}; run npm run generate:model-routes first`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as import("../src/infrastructure/opencode/disk-agent-generator.js").Manifest;
  if ((manifest.requiredOpenCodeVersion ?? "") !== REQUIRED_OPENCODE_VERSION) {
    throw new Error(`BLOCKED: manifest requiredOpenCodeVersion=${manifest.requiredOpenCodeVersion ?? "<missing>"}; regenerate descriptors with npm run generate:model-routes first.`);
  }
  const expected = manifest.routes[0];
  if (!expected) throw new Error("BLOCKED: manifest has no routes");

  const attestationPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "attestation.json");
  // Unit 6: refuse to manufacture evidence or an attestation. Real-host
  // canary is the only readiness authority; if no real attestation exists,
  // the run is BLOCKED.
  if (!existsSync(attestationPath)) {
    throw new Error(`BLOCKED: no real canary-issued attestation at ${attestationPath}. Run npm run canary:model-routes:real against the real OpenCode host first; synthetic attestations are not acceptable release evidence.`);
  }

  const quarantineStore = new QuarantineStoreImpl();
  const quarantineAdapter = new PrismaModelRouteQuarantineAdapter(prisma);
  const hook = new ModelRouteTaskHook({
    workspaceRoot,
    manifestPath,
    attestationPath,
    openCodeVersion: runtimeVersion,
    bootIdentity,
    signingKey,
    resolver: new ModelRouteResolver(new PrismaModelRouteCatalogAdapter(prisma), new Map()),
    quarantineStore,
    audit: { path: path.join(workspaceRoot, ".opencode", "sdd-model-routing", "audit.jsonl") },
    loadQuarantineEntries: async () => quarantineAdapter.listActive(),
  });

  const output = { args: { subagent_type: `model-route:v1|sdd-mr-base|${expected.providerId}/${expected.modelId}`, prompt: "hello" } };
  await hook.execute({ tool: "task", callID: "e2e-1" }, output);
  if (output.args.subagent_type !== expected.hostName) {
    throw new Error(`BLOCKED: routing pipeline did not rewrite subagent_type to ${expected.hostName}`);
  }
  console.log(JSON.stringify({ status: "ATTESTED", routedAgent: expected.hostName, canonical: `${expected.providerId}/${expected.modelId}`, openCodeVersion: runtimeVersion }));
}

await main();
