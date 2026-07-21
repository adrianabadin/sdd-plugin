import type { BenchmarkScores } from "../domain/benchmark/benchmark-scores.js";
import type { ConnectedModelInfo } from "../domain/model/connected-model.js";
import type { PersistedModelDetail } from "../ports/model-detail-query.port.js";
import type { DetailTab } from "./navigation.js";

export interface LoadedDetail {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerName: string;
  readonly modelName: string;

  // Overview tab
  readonly isBlocked: boolean;
  readonly contextWindow: number | null; // pending schema (Task 5)
  readonly maxOutputTokens: number | null; // pending schema (Task 5)
  readonly capabilities: {
    readonly vision: boolean;
    readonly tools: boolean;
    readonly reasoning: boolean;
  }; // pending schema (Task 5)

  // Benchmarks tab
  readonly benchmarks: BenchmarkScores;

  // Pricing tab
  readonly inputPerMillion: number | null;
  readonly outputPerMillion: number | null;
  readonly cachedPerMillion: number | null;
  readonly currency: string;

  // Subscription tab
  readonly subscriptionEnabled: boolean;
  readonly subscriptionTier: string | null;
  readonly planName: string | null; // pending schema (Task 5)
  readonly periodicCost: number | null; // pending schema (Task 5)
  readonly includedUsage: number | null; // pending schema (Task 5)
  readonly overageRate: number | null; // pending schema (Task 5)
}

export type DetailDraft = LoadedDetail;

export function mergeModelDetail(
  catalog: ConnectedModelInfo | null,
  persisted: PersistedModelDetail | null,
  providerId: string,
  modelId: string
): LoadedDetail {
  const providerName = persisted?.providerName ?? catalog?.providerId ?? providerId;
  const modelName = persisted?.modelName ?? catalog?.modelName ?? modelId;

  const isBlocked = persisted?.providerIsBlocked ?? catalog?.provider?.isBlocked ?? false;

  const benchmarks: BenchmarkScores = {
    mmlu: persisted?.benchmarks?.mmlu ?? catalog?.model?.benchmarks?.mmlu ?? null,
    humaneval: persisted?.benchmarks?.humaneval ?? catalog?.model?.benchmarks?.humaneval ?? null,
    sweBench: persisted?.benchmarks?.sweBench ?? catalog?.model?.benchmarks?.sweBench ?? null,
    gpqa: persisted?.benchmarks?.gpqa ?? catalog?.model?.benchmarks?.gpqa ?? null,
    math: persisted?.benchmarks?.math ?? catalog?.model?.benchmarks?.math ?? null,
    bbh: persisted?.benchmarks?.bbh ?? catalog?.model?.benchmarks?.bbh ?? null,
    mtBench: persisted?.benchmarks?.mtBench ?? catalog?.model?.benchmarks?.mtBench ?? null,
    multineedle: persisted?.benchmarks?.multineedle ?? catalog?.model?.benchmarks?.multineedle ?? null,
  };

  const inputPerMillion = persisted?.pricing?.inputPerMillion ?? catalog?.pricing?.inputPerMillion ?? null;
  const outputPerMillion = persisted?.pricing?.outputPerMillion ?? catalog?.pricing?.outputPerMillion ?? null;
  const cachedPerMillion = persisted?.pricing?.cachedPerMillion ?? catalog?.pricing?.cachedPerMillion ?? null;
  const currency = persisted?.pricing?.currency ?? catalog?.pricing?.currency ?? "USD";

  const subscriptionTier = persisted?.providerSubscription ?? catalog?.provider?.subscription ?? null;

  return {
    providerId,
    modelId,
    providerName,
    modelName,
    isBlocked,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: { vision: false, tools: false, reasoning: false },
    benchmarks,
    inputPerMillion,
    outputPerMillion,
    cachedPerMillion,
    currency,
    subscriptionEnabled: Boolean(subscriptionTier),
    subscriptionTier,
    planName: null,
    periodicCost: null,
    includedUsage: null,
    overageRate: null,
  };
}

export function createDraft(loaded: LoadedDetail): DetailDraft {
  return JSON.parse(JSON.stringify(loaded));
}

export function updateField<K extends keyof DetailDraft>(
  draft: DetailDraft,
  field: K,
  value: DetailDraft[K]
): DetailDraft {
  return {
    ...draft,
    [field]: value,
  };
}

export function isTabDirty(tab: DetailTab, baseline: LoadedDetail, draft: DetailDraft): boolean {
  switch (tab) {
    case "overview": {
      return (
        baseline.isBlocked !== draft.isBlocked ||
        baseline.contextWindow !== draft.contextWindow ||
        baseline.maxOutputTokens !== draft.maxOutputTokens ||
        baseline.capabilities.vision !== draft.capabilities.vision ||
        baseline.capabilities.tools !== draft.capabilities.tools ||
        baseline.capabilities.reasoning !== draft.capabilities.reasoning
      );
    }
    case "benchmarks": {
      const keys: Array<keyof BenchmarkScores> = [
        "mmlu",
        "humaneval",
        "sweBench",
        "gpqa",
        "math",
        "bbh",
        "mtBench",
        "multineedle",
      ];
      return keys.some((k) => (baseline.benchmarks[k] ?? null) !== (draft.benchmarks[k] ?? null));
    }
    case "pricing": {
      return (
        baseline.inputPerMillion !== draft.inputPerMillion ||
        baseline.outputPerMillion !== draft.outputPerMillion ||
        baseline.cachedPerMillion !== draft.cachedPerMillion ||
        baseline.currency !== draft.currency
      );
    }
    case "subscription": {
      return (
        baseline.subscriptionEnabled !== draft.subscriptionEnabled ||
        baseline.subscriptionTier !== draft.subscriptionTier ||
        baseline.planName !== draft.planName ||
        baseline.periodicCost !== draft.periodicCost ||
        baseline.includedUsage !== draft.includedUsage ||
        baseline.overageRate !== draft.overageRate
      );
    }
  }
}

export function isDraftDirty(baseline: LoadedDetail, draft: DetailDraft): boolean {
  return (
    isTabDirty("overview", baseline, draft) ||
    isTabDirty("benchmarks", baseline, draft) ||
    isTabDirty("pricing", baseline, draft) ||
    isTabDirty("subscription", baseline, draft)
  );
}
