/**
 * RED — `routes.json` is the only routing authority.
 * `RouteWhitelist` is the deterministic host-name derivation primitive
 * the dispatch hook and resolver now share.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadRouteWhitelist } from "../src/domain/model-routing/route-whitelist.js";
import { hashHostName } from "../src/domain/model-routing/model-route-host-naming.js";

async function run(): Promise<void> {
  console.log("--- route whitelist loader (RED) ---");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-whitelist-"));
  try {
    const configDir = path.join(tmp, "config", "model-routing");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "routes.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatorVersion: "1.1.0",
        cap: 32,
        routes: [
          { baseTemplate: "sdd-mr-base", providerId: "openai", modelId: "gpt-5.6-sol" },
          { baseTemplate: "sdd-mr-base", providerId: "anthropic", modelId: "claude-opus-5" },
        ],
      }),
    );

    const whitelist = loadRouteWhitelist(tmp);

    assert.equal(whitelist.size, 2, "both routes are loaded");

    assert.equal(
      whitelist.findHostName("openai", "gpt-5.6-sol"),
      hashHostName("sdd-mr-base", { providerId: "openai", modelId: "gpt-5.6-sol" }),
      "host name is derived deterministically from the route",
    );

    assert.equal(
      whitelist.findHostName("openai", "not-in-routes"),
      null,
      "a model absent from routes.json has no host",
    );

    assert.deepEqual(
      whitelist.searchNormalized("opus", 8).map((c) => `${c.providerId}/${c.modelId}`),
      ["anthropic/claude-opus-5"],
      "fuzzy search only ever returns whitelisted routes",
    );

    console.log("  pass: whitelist size, host derivation, unknown lookup, and search");
    console.log("All route-whitelist assertions passed!");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
