import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ROUTED_HOST_NAME_PREFIX,
  formatCanonicalModelId,
  hashHostName,
} from "../src/domain/model-routing/model-route-host-naming.js";
import * as modelRouting from "../src/domain/model-routing/index.js";

function run(): void {
  console.log("--- model-route pure host naming ---");

  const canonical = Object.freeze({
    providerId: "google",
    modelId: "antigravity-gemini-3.6-flash-tiered",
  });

  assert.equal(
    formatCanonicalModelId(canonical),
    "google/antigravity-gemini-3.6-flash-tiered",
    "canonical formatting is providerId/modelId",
  );

  const expected = "sdd-mr-v1-0c7309e06a9d5324";
  assert.equal(hashHostName("sdd-mr-base", canonical), expected);
  assert.equal(hashHostName("sdd-mr-base", canonical), expected, "same input is deterministic");
  assert.match(expected, /^sdd-mr-v1-[a-f0-9]{16}$/);
  assert.equal(ROUTED_HOST_NAME_PREFIX, "sdd-mr-v1-");
  assert.notEqual(
    hashHostName("different-template", canonical),
    expected,
    "base template participates in the hash",
  );
  assert.notEqual(
    hashHostName("sdd-mr-base", { providerId: "openai", modelId: "gpt-4o" }),
    expected,
    "canonical identity participates in the hash",
  );

  assert.throws(() => hashHostName("", canonical), /base/i);
  assert.throws(
    () => formatCanonicalModelId({ providerId: "google/invalid", modelId: "gemini" }),
    /providerId/i,
  );

  assert.equal(modelRouting.hashHostName, hashHostName, "barrel exports hashHostName");
  assert.equal(
    modelRouting.formatCanonicalModelId,
    formatCanonicalModelId,
    "barrel exports canonical formatter",
  );

  const namingSource = readFileSync(
    new URL("../src/domain/model-routing/model-route-host-naming.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    namingSource,
    /OpenCodeConfig|AgentEntry|plugin_origins|permission/,
    "pure naming helper is detached from synthetic Config shapes",
  );

  // Suffix names: the variant fleet derives base + -low/-medium/-high host
  // names by string concatenation of the canonical hash. The base hash
  // is unchanged, and the suffixed names carry the level lexically so
  // the dispatcher can find them on disk.
  const hash = expected.slice(ROUTED_HOST_NAME_PREFIX.length);
  assert.equal(`${expected}-low`, `sdd-mr-v1-${hash}-low`, "low agent file name");
  assert.equal(`${expected}-medium`, `sdd-mr-v1-${hash}-medium`, "medium agent file name");
  assert.equal(`${expected}-high`, `sdd-mr-v1-${hash}-high`, "high agent file name");
  assert.match(`${expected}-low`, /^sdd-mr-v1-[a-f0-9]{16}-low$/, "low suffix format");
  assert.match(`${expected}-high`, /^sdd-mr-v1-[a-f0-9]{16}-high$/, "high suffix format");

  console.log("All pure host naming assertions passed.");
}

run();
