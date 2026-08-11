import assert from "node:assert/strict";

import {
  getGlobalQuarantineStore,
  QuarantineStoreImpl,
} from "../src/infrastructure/runtime/quarantine-store.js";
import type { QuarantineEntry } from "../src/domain/model/quarantine.js";

async function runTests() {
  console.log("--- QuarantineStore Runtime Unit Tests ---");

  const store = new QuarantineStoreImpl();
  const baseDate = new Date("2026-07-21T12:00:00.000Z");
  const futureDate = new Date("2026-07-21T13:00:00.000Z");

  // 1. Initial snapshot is empty
  assert(store.snapshot().length === 0, "Initial snapshot must be empty");

  // 2. Hydrate
  const entries: QuarantineEntry[] = [
    { level: "provider", providerId: "anthropic", type: "permanent" },
    { level: "model", modelId: "gpt-4o", type: "ttl", until: futureDate },
  ];
  store.hydrate(entries);
  assert(store.snapshot().length === 2, "Hydrate must populate 2 entries");

  // 3. isActive precedence
  assert(store.isActive("anthropic", "claude-3-5-sonnet", baseDate) === true, "Anthropic provider level active");
  assert(store.isActive("openai", "gpt-4o", baseDate) === true, "GPT-4o model level active");
  assert(store.isActive("openai", "o1-preview", baseDate) === false, "Unquarantined model inactive");

  // 4. Publish
  store.publish({ level: "modelProvider", providerId: "openai", modelId: "o1-preview", type: "permanent" });
  assert(store.snapshot().length === 3, "Publish must add entry");
  assert(store.isActive("openai", "o1-preview", baseDate) === true, "Now active via connection quarantine");

  // 5. Release
  store.release({ level: "modelProvider", providerId: "openai", modelId: "o1-preview" });
  assert(store.isActive("openai", "o1-preview", baseDate) === false, "Inactive after release");
  assert(store.snapshot().length === 2, "Snapshot count reduced after release");

  // 6. Global symbol cross-bundle test
  const globalStore1 = getGlobalQuarantineStore();
  const globalStore2 = getGlobalQuarantineStore();
  assert(globalStore1 === globalStore2, "Global store must be a singleton across calls");
  const symbolKey = Symbol.for("sdd-plugin.quarantine-store.v1");
  // @ts-ignore
  assert(globalThis[symbolKey] === globalStore1, "Must be registered on globalThis via Symbol.for");

  console.log("✅ All QuarantineStore runtime tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
