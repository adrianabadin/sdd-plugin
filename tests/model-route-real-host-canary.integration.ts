import { readFileSync } from "node:fs";
import path from "node:path";

import type { Manifest } from "../src/infrastructure/opencode/disk-agent-generator.js";
import { ModelRouteCanary, OpenCodeHttpCanaryTransport } from "../src/infrastructure/opencode/model-route-canary.js";
import { ModelRouteReadiness, REQUIRED_OPENCODE_VERSION } from 
"../src/infrastructure/opencode/model-route-readiness.js";
import { isOpenCodeVersionSupported, parseOpenCodeVersion } from "../src/domain/model-routing/opencode-compat.js";

const REQUIRED_COMMAND = "set OPENCODE_CANARY_REAL=1 && set OPENCODE_CANARY_URL=http://127.0.0.1:4096 && set OPENCODE_CANARY_BOOT_ID=<stable-boot-nonce> && set OPENCODE_CANARY_SIGNING_KEY=<shared-hmac-secret> && set OPENCODE_CANARY_PARENT_MODELS={<target>:<distinct-parent>} && npx tsx tests/model-route-real-host-canary.integration.ts";

async function main(): Promise<void> {
  if (process.env.OPENCODE_CANARY_REAL !== "1") {
    console.error(`BLOCKED: real-host canary is explicitly gated and was not run. Exact command: ${REQUIRED_COMMAND}`);
    process.exitCode = 2;
    return;
  }
  const workspaceRoot = path.resolve(process.env.OPENCODE_CANARY_WORKSPACE ?? process.cwd());
  const baseUrl = process.env.OPENCODE_CANARY_URL;
  const bootIdentity = process.env.OPENCODE_CANARY_BOOT_ID;
  const signingKey = process.env.OPENCODE_CANARY_SIGNING_KEY;
  // Unit 6: synthetic attestation overrides are rejected. The harness MUST
  // run against the real OpenCode host; it MUST NOT manufacture evidence
  // or an attestation. The real-host canary is the only readiness authority.
  if (!baseUrl || !bootIdentity || bootIdentity === "boot-default" || !signingKey || signingKey === "deterministic-key") {
    console.error(`BLOCKED: explicit OPENCODE_CANARY_URL, OPENCODE_CANARY_BOOT_ID, and OPENCODE_CANARY_SIGNING_KEY are required. Exact command: ${REQUIRED_COMMAND}`);
    process.exitCode = 2;
    return;
  }
  const parentModels = JSON.parse(process.env.OPENCODE_CANARY_PARENT_MODELS ?? "{}") as Record<string, string>;
  const manifest = JSON.parse(readFileSync(path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json"), "utf8")) as Manifest;
  if ((manifest.requiredOpenCodeVersion ?? "") !== REQUIRED_OPENCODE_VERSION) {
    throw new Error(`BLOCKED: manifest binds requiredOpenCodeVersion=${manifest.requiredOpenCodeVersion ?? "<missing>"} but real-host contract is ${REQUIRED_OPENCODE_VERSION}; regenerate descriptors first.`);
  }
  const healthResponse = await fetch(`${baseUrl.replace(/\/$/, "")}/global/health`);
  if (!healthResponse.ok) throw new Error(`BLOCKED: GET /global/health returned ${healthResponse.status}`);
  const health = await healthResponse.json() as { version?: string; data?: { version?: string } };
  const version = health.version ?? health.data?.version;
  if (typeof version !== "string" || !isOpenCodeVersionSupported(version)) {
    throw new Error(`BLOCKED: OpenCode >= ${REQUIRED_OPENCODE_VERSION} within major ${parseOpenCodeVersion(REQUIRED_OPENCODE_VERSION)?.major ?? "?"} required; observed ${version ?? "unobservable"}`);
  }
  const canary = new ModelRouteCanary({
    transport: new OpenCodeHttpCanaryTransport({ baseUrl }),
    selectParentModel: async (target) => parentModels[target] ?? null,
  });
  const evidence = await canary.verifyEveryRoute(manifest);
  if (evidence.length !== manifest.routes.length) {
    throw new Error(`BLOCKED: canary did not prove every route (${evidence.length}/${manifest.routes.length}); refusing to issue synthetic attestation.`);
  }
  const readiness = new ModelRouteReadiness({ workspaceRoot, signingKey: Buffer.from(signingKey, "utf8") });
  const attestation = readiness.issue({ manifest, evidence, openCodeVersion: version, bootIdentity, ttlMs: 15 * 60_000 });
  console.log(JSON.stringify({ status: "ATTESTED", hosts: evidence.length, nonce: attestation.nonce, expiresAt: attestation.expiresAt, openCodeVersion: version, bootIdentity }));
}

await main();
