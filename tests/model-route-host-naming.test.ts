import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ROUTED_HOST_NAME_PREFIX,
  formatCanonicalModelId,
  hashHostName,
} from "../src/domain/model-routing/model-route-host-naming.js";
import * as modelRouting from "../src/domain/model-routing/index.js";
import {
  OpenCodeCompatError,
  assertOpenCodeCompatible,
} from "../src/domain/model-routing/opencode-compat.js";

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
  assert.equal(
    "buildRoutedHostSpecs" in modelRouting,
    false,
    "barrel does not retain staging-only routed-host orchestration",
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

  assert.doesNotThrow(() => assertOpenCodeCompatible("1.18.9"));
  assert.throws(
    () => assertOpenCodeCompatible("1.18.4"),
    OpenCodeCompatError,
    "exact compatibility gate refuses the legacy 1.18.4 runtime",
  );
  assert.throws(
    () => assertOpenCodeCompatible("1.18.5"),
    OpenCodeCompatError,
    "exact compatibility gate refuses anything other than 1.18.9",
  );
  assert.throws(
    () => assertOpenCodeCompatible("1.18.10"),
    OpenCodeCompatError,
    "exact compatibility gate refuses newer-than-1.18.9 runtime",
  );

  console.log("All pure host naming assertions passed.");
}

run();
