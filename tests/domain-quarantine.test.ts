import {
  isQuarantineActive,
  resolveQuarantinePrecedence,
  type QuarantineEntry,
} from "../src/domain/model/quarantine.js";

async function runTests() {
  console.log("--- Quarantine Domain Helpers Unit Tests ---");

  const baseDate = new Date("2026-07-21T12:00:00.000Z");
  const pastDate = new Date("2026-07-21T11:59:59.000Z");
  const futureDate = new Date("2026-07-21T12:00:01.000Z");

  // Test 1: TTL boundary active check
  const ttlActive: QuarantineEntry = {
    level: "provider",
    providerId: "openai",
    type: "ttl",
    until: futureDate,
  };
  const ttlExpired: QuarantineEntry = {
    level: "provider",
    providerId: "openai",
    type: "ttl",
    until: pastDate,
  };
  const permanent: QuarantineEntry = {
    level: "provider",
    providerId: "openai",
    type: "permanent",
  };

  console.assert(isQuarantineActive(ttlActive, baseDate) === true, "TTL future must be active");
  console.assert(isQuarantineActive(ttlExpired, baseDate) === false, "TTL past must be inactive");
  console.assert(isQuarantineActive(ttlExpired, pastDate) === false, "TTL exact boundary must be inactive");
  console.assert(isQuarantineActive(permanent, baseDate) === true, "Permanent must be active");

  // Test 2: Precedence resolution: provider > model > modelProvider
  const entries: QuarantineEntry[] = [
    {
      level: "modelProvider",
      providerId: "openai",
      modelId: "gpt-4o",
      type: "ttl",
      until: futureDate,
    },
    {
      level: "model",
      modelId: "gpt-4o",
      type: "ttl",
      until: futureDate,
    },
    {
      level: "provider",
      providerId: "openai",
      type: "permanent",
    },
  ];

  const resolved = resolveQuarantinePrecedence(entries, "openai", "gpt-4o", baseDate);
  console.assert(resolved !== null, "Must resolve an entry");
  console.assert(resolved?.level === "provider", "Provider level must override model and connection");

  // Test 3: Model overrides modelProvider if provider is inactive
  const entriesNoProvider: QuarantineEntry[] = [
    {
      level: "modelProvider",
      providerId: "openai",
      modelId: "gpt-4o",
      type: "ttl",
      until: futureDate,
    },
    {
      level: "model",
      modelId: "gpt-4o",
      type: "permanent",
    },
  ];
  const resolvedModel = resolveQuarantinePrecedence(entriesNoProvider, "openai", "gpt-4o", baseDate);
  console.assert(resolvedModel?.level === "model", "Model level must override connection");

  // Test 4: Returns null if no active quarantine
  const resolvedNone = resolveQuarantinePrecedence([ttlExpired], "openai", "gpt-4o", baseDate);
  console.assert(resolvedNone === null, "Must return null if entry expired");

  console.log("✅ All domain quarantine helper tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
