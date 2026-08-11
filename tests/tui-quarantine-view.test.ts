import assert from "node:assert/strict";
import { deriveQuarantineView } from "../src/tui/quarantine-view.js";
import type { QuarantineEntry } from "../src/domain/model/quarantine.js";

async function runTests() {
  console.log("--- TUI Quarantine View Derivation Unit Tests ---");

  const baseDate = new Date("2026-07-21T12:00:00.000Z");
  const futureDate = new Date("2026-07-21T12:30:00.000Z");
  const pastDate = new Date("2026-07-21T11:00:00.000Z");

  const entries: QuarantineEntry[] = [
    { level: "modelProvider", providerId: "openai", modelId: "gpt-4o", type: "ttl", until: futureDate },
    { level: "provider", providerId: "anthropic", type: "permanent" },
    { level: "model", modelId: "claude-3-5-sonnet", type: "ttl", until: pastDate },
  ];

  const view = deriveQuarantineView(entries, baseDate);

  // 1. All entries transformed
  assert(view.items.length === 3, "View items count matches entries length");

  // 2. Sorting & Status
  // Anthropic provider (permanent) active -> first
  const item0 = view.items[0];
  assert(item0?.level === "provider", "Provider level first");
  assert(item0?.targetLabel === "anthropic", "Provider targetLabel is providerId");
  assert(item0?.statusLabel === "ACTIVE (Permanent)", "Status label for permanent");
  assert(item0?.isActive === true, "Permanent is active");

  // OpenAI gpt-4o connection (active TTL) -> second
  const item1 = view.items[1];
  assert(item1?.level === "modelProvider", "Active TTL connection second");
  assert(item1?.targetLabel === "openai/gpt-4o", "Connection targetLabel is provider/model");
  assert(item1?.isActive === true, "Future TTL is active");

  // Claude 3.5 model (expired TTL) -> third
  const item2 = view.items[2];
  assert(item2?.level === "model", "Expired model last");
  assert(item2?.statusLabel.includes("EXPIRED"), "Status label reflects expired");
  assert(item2?.isActive === false, "Past TTL is inactive");

  // Empty entries handling
  const emptyView = deriveQuarantineView([], baseDate);
  assert(emptyView.items.length === 0, "Empty input produces empty view items");
  assert(emptyView.isEmpty === true, "isEmpty flag is set");

  console.log("✅ All TUI Quarantine View tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
