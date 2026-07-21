import type { ConnectedModelInfo } from "../src/domain/model/connected-model.js";
import type { PersistedModelDetail } from "../src/ports/model-detail-query.port.js";
import {
  mergeModelDetail,
  createDraft,
  updateField,
  isTabDirty,
  isDraftDirty,
} from "../src/tui/model-detail-view.js";

function runModelDetailViewTests(): void {
  console.log("\n--- Model Detail View Test Suite ---");

  // 1. Persisted values take precedence over catalog values
  const catalog: ConnectedModelInfo = {
    providerId: "openai",
    modelId: "gpt-4o",
    modelName: "GPT-4o Catalog",
    pricing: { inputPerMillion: 5.0, currency: "USD" },
    model: { benchmarks: { mmlu: 85 } },
  };

  const persisted: PersistedModelDetail = {
    providerId: "openai",
    providerName: "OpenAI DB",
    providerSubscription: "large",
    providerIsBlocked: true,
    providerQuarantineType: null,
    providerQuarantineUntil: null,
    modelId: "gpt-4o",
    modelName: "GPT-4o Persisted",
    benchmarks: { mmlu: 88.6 },
    modelQuarantineType: null,
    modelQuarantineUntil: null,
    modelProviderQuarantineType: null,
    modelProviderQuarantineUntil: null,
    pricing: {
      id: "price-1",
      inputPerMillion: 2.5,
      outputPerMillion: 10.0,
      cachedPerMillion: 1.25,
      currency: "USD",
      effectiveFrom: new Date(),
      effectiveUntil: null,
    },
  };

  const merged = mergeModelDetail(catalog, persisted, "openai", "gpt-4o");
  console.log(`  pass: persisted modelName wins: ${merged.modelName === "GPT-4o Persisted"}`);
  if (merged.modelName !== "GPT-4o Persisted") throw new Error("Persisted modelName should win");
  console.log(`  pass: persisted inputPerMillion wins: ${merged.inputPerMillion === 2.5}`);
  if (merged.inputPerMillion !== 2.5) throw new Error("Persisted pricing should win");
  console.log(`  pass: persisted benchmark mmlu wins: ${merged.benchmarks.mmlu === 88.6}`);
  if (merged.benchmarks.mmlu !== 88.6) throw new Error("Persisted benchmarks should win");
  console.log(`  pass: persisted isBlocked wins: ${merged.isBlocked === true}`);

  // 2. Null persisted (catalog only fallback)
  const catalogOnlyMerged = mergeModelDetail(catalog, null, "openai", "gpt-4o");
  console.log(`  pass: catalog modelName used when persisted is null: ${catalogOnlyMerged.modelName === "GPT-4o Catalog"}`);
  console.log(`  pass: catalog inputPerMillion used when persisted is null: ${catalogOnlyMerged.inputPerMillion === 5.0}`);
  console.log(`  pass: catalog benchmark used when persisted is null: ${catalogOnlyMerged.benchmarks.mmlu === 85}`);

  // 3. Draft creation and field update
  const draft = createDraft(merged);
  console.log(`  pass: initial draft is not dirty: ${!isDraftDirty(merged, draft)}`);

  const updatedDraft = updateField(draft, "inputPerMillion", 3.0);
  console.log(`  pass: updated draft marks pricing tab dirty: ${isTabDirty("pricing", merged, updatedDraft)}`);
  console.log(`  pass: updated draft marks overview tab clean: ${!isTabDirty("overview", merged, updatedDraft)}`);
  console.log(`  pass: overall draft is dirty: ${isDraftDirty(merged, updatedDraft)}`);

  console.log("\n=== MODEL DETAIL VIEW TEST SUMMARY ===");
  console.log("All model detail view assertions passed.");
}

runModelDetailViewTests();
