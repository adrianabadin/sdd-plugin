/**
 * Unit & integration tests for catalog view derivation module (`src/tui/catalog-view.ts`).
 */
import {
  buildProviderSummaries,
  filterModels,
  type CatalogView,
  type ProviderSummary,
} from "../src/tui/catalog-view.js";
import type { ConnectedModelInfo } from "../src/domain/model/connected-model.js";

const failures: string[] = [];

function assert(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error("  FAIL: " + message);
  } else {
    console.log("  pass: " + message);
  }
}

async function main(): Promise<void> {
  console.log("\n--- TUI Catalog View Derivation Test ---");

  // 1. Provider Summaries Derivation & ProviderId Code-Unit Sorting
  console.log("\n1. Testing Provider Summaries Derivation & Sorting...");
  const sampleModels: ConnectedModelInfo[] = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
    },
    {
      providerId: "anthropic",
      modelId: "claude-3-5-sonnet",
      modelName: "Claude 3.5 Sonnet",
    },
    {
      providerId: "openai",
      modelId: "o1-mini",
      modelName: "o1 mini",
    },
    {
      providerId: "google",
      modelId: "gemini-1.5-pro",
      modelName: "Gemini 1.5 Pro",
    },
  ];

  const summaries = buildProviderSummaries(sampleModels);
  assert(summaries.length === 3, "Only connected providers with models are returned (3 providers)");
  assert(
    JSON.stringify(summaries.map((s) => s.providerId)) === JSON.stringify(["anthropic", "google", "openai"]),
    "Providers sorted by providerId ascending code-unit order (anthropic -> google -> openai)"
  );
  assert(summaries[0]?.modelCount === 1, "Anthropic has 1 model");
  assert(summaries[1]?.modelCount === 1, "Google has 1 model");
  assert(summaries[2]?.modelCount === 2, "OpenAI has 2 models");

  // Zero-model providers check
  const emptySummaries = buildProviderSummaries([]);
  assert(emptySummaries.length === 0, "Empty connected models returns empty provider summaries");

  // 2. Model Sorting: modelName.toLowerCase() asc, modelId tie-break
  console.log("\n2. Testing Model Sorting...");
  const unsortedModels: ConnectedModelInfo[] = [
    { providerId: "test", modelId: "b-model", modelName: "beta model" },
    { providerId: "test", modelId: "a-model", modelName: "Alpha Model" },
    { providerId: "test", modelId: "alpha-2", modelName: "alpha model" }, // tie-break modelName lowercase
  ];

  const sortedModels = filterModels(unsortedModels, "");
  assert(sortedModels.length === 3, "Returns all models when query is empty");
  assert(sortedModels[0]?.modelId === "a-model", "Alpha Model (lowercase 'alpha model') comes first (modelId tie-break 'a-model' < 'alpha-2')");
  assert(sortedModels[1]?.modelId === "alpha-2", "alpha model comes second");
  assert(sortedModels[2]?.modelId === "b-model", "beta model comes third");

  // 3. Model Filtering: Case-Insensitive Matching on modelId or modelName
  console.log("\n3. Testing Case-Insensitive Model Filtering...");
  const searchSet: ConnectedModelInfo[] = [
    { providerId: "openai", modelId: "gpt-4o", modelName: "GPT-4o Omnimodal" },
    { providerId: "openai", modelId: "gpt-4o-mini", modelName: "GPT-4o Mini" },
    { providerId: "openai", modelId: "o1-preview", modelName: "Reasoning Model o1" },
  ];

  const matchGpt = filterModels(searchSet, "gpt");
  assert(matchGpt.length === 2, "Query 'gpt' matches 2 models");
  assert(
    matchGpt.some((m) => m.modelId === "gpt-4o"),
    "Match set contains gpt-4o"
  );
  assert(
    matchGpt.some((m) => m.modelId === "gpt-4o-mini"),
    "Match set contains gpt-4o-mini"
  );

  const matchReasoning = filterModels(searchSet, "REASONING");
  assert(matchReasoning.length === 1, "Query 'REASONING' matches 1 model by modelName");
  assert(matchReasoning[0]?.modelId === "o1-preview", "Matched model is o1-preview");

  const matchNoResult = filterModels(searchSet, "claude");
  assert(matchNoResult.length === 0, "Query 'claude' returns empty array");

  // 4. Design Suggestion Check: Literal/Safe Handling of Special Regex Chars & Long Strings
  console.log("\n4. Testing Literal/Safe Search Query Handling (Design Suggestion)...");
  const specialCharsSet: ConnectedModelInfo[] = [
    { providerId: "p", modelId: "model-[v1].0", modelName: "Model (v1.0) + [special]" },
    { providerId: "p", modelId: "regex-test", modelName: "Test .*+?^${}()|[]\\" },
  ];

  // Regex special chars query should be treated strictly as literal string substring match, without throwing
  let literalResult: ConnectedModelInfo[] = [];
  try {
    literalResult = filterModels(specialCharsSet, ".*+?^${}()|[]\\");
    assert(literalResult.length === 1, "Special regex character string treated as literal string match");
    assert(literalResult[0]?.modelId === "regex-test", "Found regex-test model safely");
  } catch (err) {
    assert(false, "filterModels threw on special regex characters query: " + String(err));
  }

  // Very long query string handling
  const longQuery = "a".repeat(5000);
  try {
    const longResult = filterModels(specialCharsSet, longQuery);
    assert(longResult.length === 0, "Very long query string handled safely without throwing");
  } catch (err) {
    assert(false, "filterModels threw on long query string: " + String(err));
  }

  // 5. Type Contract Verification (CatalogView status union)
  console.log("\n5. Testing CatalogView Contract Union Types...");
  const loadingView: CatalogView = { status: "loading" };
  const errorView: CatalogView = { status: "error", message: "Failed to load" };
  const readyView: CatalogView = {
    status: "ready",
    providers: summaries,
    modelsByProvider: new Map([["openai", sampleModels.filter((m) => m.providerId === "openai")]]),
  };

  assert(loadingView.status === "loading", "CatalogView loading state valid");
  assert(errorView.status === "error" && errorView.message === "Failed to load", "CatalogView error state valid");
  assert(readyView.status === "ready" && readyView.providers.length === 3, "CatalogView ready state valid");

  console.log("\n=== TUI CATALOG VIEW TEST SUMMARY ===");
  if (failures.length === 0) {
    console.log("All TUI catalog view assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " assertion(s) failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("TUI catalog view test crashed:", err);
  process.exit(1);
});
