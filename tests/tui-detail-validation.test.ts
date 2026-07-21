import type { LoadedDetail } from "../src/tui/model-detail-view.js";
import { validateDraft } from "../src/tui/detail-validation.js";

const sampleDetail: LoadedDetail = {
  providerId: "openai",
  modelId: "gpt-4o",
  providerName: "OpenAI",
  modelName: "GPT-4o",
  isBlocked: false,
  contextWindow: 128000,
  maxOutputTokens: 4096,
  capabilities: { vision: true, tools: true, reasoning: false },
  benchmarks: {
    mmlu: 88.6,
    humaneval: 90.2,
  },
  inputPerMillion: 2.5,
  outputPerMillion: 10.0,
  cachedPerMillion: 1.25,
  currency: "USD",
  subscriptionEnabled: false,
  subscriptionTier: null,
  planName: null,
  periodicCost: null,
  includedUsage: null,
  overageRate: null,
};

function runValidationTests(): void {
  console.log("\n--- Detail Validation Test Suite ---");

  // 1. Valid Draft
  const validResult = validateDraft(sampleDetail);
  console.log(`  pass: valid draft passes validation: ${validResult.isValid}`);
  if (!validResult.isValid) throw new Error("Expected valid draft to pass");

  // 2. Numeric error (e.g. invalid string / NaN for pricing)
  const invalidPricingDraft = {
    ...sampleDetail,
    inputPerMillion: NaN,
  };
  const invalidPricingResult = validateDraft(invalidPricingDraft);
  console.log(`  pass: invalid inputPerMillion fails validation: ${!invalidPricingResult.isValid}`);
  if (invalidPricingResult.isValid) throw new Error("Expected invalid pricing to fail validation");
  if (invalidPricingResult.fields.inputPerMillion?.status !== "error") {
    throw new Error("Expected field status to be error for inputPerMillion");
  }

  // 3. Currency warning for non-USD
  const eurDraft = {
    ...sampleDetail,
    currency: "EUR",
  };
  const eurResult = validateDraft(eurDraft);
  console.log(`  pass: non-USD currency returns warning: ${eurResult.isValid}`);
  if (!eurResult.isValid) throw new Error("Warning should not fail validation");
  if (eurResult.fields.currency?.status !== "warn") {
    throw new Error("Expected currency status to be warn for EUR");
  }

  // 4. Invalid currency format (error)
  const badCurrencyDraft = {
    ...sampleDetail,
    currency: "US", // length 2
  };
  const badCurrencyResult = validateDraft(badCurrencyDraft);
  console.log(`  pass: invalid currency format fails validation: ${!badCurrencyResult.isValid}`);
  if (badCurrencyResult.isValid) throw new Error("Expected 2-letter currency to fail validation");

  // 5. Benchmark warnings for score > 100
  const highBenchDraft = {
    ...sampleDetail,
    benchmarks: {
      ...sampleDetail.benchmarks,
      mmlu: 105,
    },
  };
  const highBenchResult = validateDraft(highBenchDraft);
  console.log(`  pass: benchmark > 100 generates warning: ${highBenchResult.isValid}`);
  if (highBenchResult.fields.mmlu?.status !== "warn") {
    throw new Error("Expected mmlu > 100 to yield warn status");
  }

  // 6. Incomplete benchmark warning
  const missingBenchDraft = {
    ...sampleDetail,
    benchmarks: {},
  };
  const missingBenchResult = validateDraft(missingBenchDraft);
  console.log(`  pass: missing benchmark generates incomplete warning: ${missingBenchResult.fields.sweBench?.status === "warn"}`);

  console.log("\n=== DETAIL VALIDATION TEST SUMMARY ===");
  console.log("All detail validation assertions passed.");
}

runValidationTests();
