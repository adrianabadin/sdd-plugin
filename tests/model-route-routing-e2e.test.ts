/**
 * Rev 2 real-host routing E2E test.
 *
 * When `OPENCODE_E2E_ROUTING=1` is set, this test wires the live HTTP
 * transport into `ModelRouteTaskHook` and exercises the full pipeline
 * (parse -> resolve -> quarantine -> whitelist -> variant -> disk ->
 * audit -> rewrite). When the gate is absent (the default) it MUST
 * report BLOCKED with the exact env var recipe; it MUST NOT claim
 * success.
 *
 * Rev 2: no attestation, no manifest preconditions, no OpenCode
 * version check. The only required precondition is a generated
 * agent fleet (the `npm run generate:model-routes` CLI run before).
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { ModelRouteTaskHook } from "../src/infrastructure/opencode/model-route-task-hook.js";
import { ModelRouteResolver } from "../src/domain/model-routing/model-route-resolver.js";
import { RouteWhitelist, loadRouteWhitelist } from "../src/domain/model-routing/route-whitelist.js";
import { readVariantSnapshot } from "../src/infrastructure/opencode/variant-snapshot.js";
import { QuarantineStoreImpl } from "../src/infrastructure/runtime/quarantine-store.js";

const REQUIRED_COMMAND =
  "set OPENCODE_E2E_ROUTING=1 && set OPENCODE_E2E_URL=http://127.0.0.1:4096 " +
  "&& set OPENCODE_E2E_WORKSPACE=<path-to-workspace> " +
  "&& npx tsx tests/model-route-routing-e2e.test.ts";

async function main(): Promise<void> {
  if (process.env["OPENCODE_E2E_ROUTING"] !== "1") {
    console.error(`BLOCKED: full real-host routing E2E is explicitly gated. Exact command: ${REQUIRED_COMMAND}`);
    process.exit(2);
    return;
  }
  const baseUrl = process.env["OPENCODE_E2E_URL"];
  const workspaceRoot = process.env["OPENCODE_E2E_WORKSPACE"];
  if (!baseUrl || !workspaceRoot) {
    console.error(`BLOCKED: missing env vars. Required: ${REQUIRED_COMMAND}`);
    process.exit(2);
    return;
  }

  const healthResponse = await fetch(`${baseUrl.replace(/\/$/, "")}/global/health`);
  if (!healthResponse.ok) throw new Error(`BLOCKED: GET /global/health returned ${healthResponse.status}`);

  const whitelist: RouteWhitelist = loadRouteWhitelist(workspaceRoot);
  const variants = readVariantSnapshot(workspaceRoot);
  if (whitelist.size === 0) {
    throw new Error(`BLOCKED: whitelist is empty at ${workspaceRoot}; run npm run generate:model-routes first.`);
  }

  const quarantineStore = new QuarantineStoreImpl();
  const hook = new ModelRouteTaskHook({
    workspaceRoot,
    whitelist,
    variants,
    resolver: new ModelRouteResolver(whitelist, new Map()),
    quarantineStore,
    audit: { path: path.join(workspaceRoot, ".opencode", "sdd-model-routing", "audit.jsonl") },
    loadQuarantineEntries: async () => quarantineStore.snapshot(),
  });

  // Pick the first whitelisted route and exercise the full pipeline.
  const first = whitelist.routes()[0]!;
  const agentFile = path.join(workspaceRoot, ".opencode", "agents", `${first.hostName}.md`);
  if (!existsSync(agentFile)) {
    throw new Error(`BLOCKED: expected base agent at ${agentFile}; run npm run generate:model-routes first.`);
  }
  const output = {
    args: {
      subagent_type: `model-route:v1|sdd-mr-base|${first.providerId}/${first.modelId}`,
      prompt: "hello",
    },
  };
  await hook.execute({ tool: "task", callID: "e2e-1" }, output);
  if (output.args.subagent_type !== first.hostName) {
    throw new Error(`BLOCKED: routing pipeline did not rewrite subagent_type to ${first.hostName}`);
  }
  console.log(
    JSON.stringify({ status: "ROUTES_OK", routedAgent: first.hostName, canonical: `${first.providerId}/${first.modelId}` }),
  );
}

await main();
