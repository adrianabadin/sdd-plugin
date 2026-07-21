import type { BenchmarkScores } from "../domain/benchmark/benchmark-scores.js";
import type { DetailDraft } from "./model-detail-view.js";

export interface FieldValidation {
  readonly status: "ok" | "warn" | "error";
  readonly message?: string;
}

export interface ValidationResult {
  readonly isValid: boolean;
  readonly fields: Record<string, FieldValidation>;
  readonly errorSummary?: string;
}

const BENCHMARK_KEYS: Array<keyof BenchmarkScores> = [
  "mmlu",
  "humaneval",
  "sweBench",
  "gpqa",
  "math",
  "bbh",
  "mtBench",
  "multineedle",
];

export function validateDraft(draft: DetailDraft): ValidationResult {
  const fields: Record<string, FieldValidation> = {};
  let hasError = false;

  // Overview validations
  if (draft.contextWindow !== null) {
    if (typeof draft.contextWindow !== "number" || !Number.isFinite(draft.contextWindow) || draft.contextWindow < 0) {
      fields["contextWindow"] = { status: "error", message: "must be a non-negative number" };
      hasError = true;
    } else {
      fields["contextWindow"] = { status: "ok" };
    }
  }

  if (draft.maxOutputTokens !== null) {
    if (typeof draft.maxOutputTokens !== "number" || !Number.isFinite(draft.maxOutputTokens) || draft.maxOutputTokens < 0) {
      fields["maxOutputTokens"] = { status: "error", message: "must be a non-negative number" };
      hasError = true;
    } else {
      fields["maxOutputTokens"] = { status: "ok" };
    }
  }

  // Benchmarks validations
  for (const key of BENCHMARK_KEYS) {
    const val = draft.benchmarks[key];
    if (val === null || val === undefined) {
      fields[key] = { status: "warn", message: "incomplete metadata" };
    } else if (typeof val !== "number" || !Number.isFinite(val)) {
      fields[key] = { status: "error", message: "must be a valid number" };
      hasError = true;
    } else if (val < 0) {
      fields[key] = { status: "error", message: "cannot be negative" };
      hasError = true;
    } else if (val > 100) {
      fields[key] = { status: "warn", message: "score > 100% (treated as percentage)" };
    } else {
      fields[key] = { status: "ok" };
    }
  }

  // Pricing validations
  const pricingNumericFields = ["inputPerMillion", "outputPerMillion", "cachedPerMillion"] as const;
  for (const fieldKey of pricingNumericFields) {
    const val = draft[fieldKey];
    if (val !== null) {
      if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
        fields[fieldKey] = { status: "error", message: "must be a non-negative number" };
        hasError = true;
      } else {
        fields[fieldKey] = { status: "ok" };
      }
    }
  }

  // Currency validation
  if (!draft.currency || typeof draft.currency !== "string" || draft.currency.length !== 3) {
    fields["currency"] = { status: "error", message: "must be 3-letter currency code" };
    hasError = true;
  } else if (draft.currency.toUpperCase() !== "USD") {
    fields["currency"] = { status: "warn", message: "conversion not applied" };
  } else {
    fields["currency"] = { status: "ok" };
  }

  // Subscription validations
  const subNumericFields = ["periodicCost", "includedUsage", "overageRate"] as const;
  for (const fieldKey of subNumericFields) {
    const val = draft[fieldKey];
    if (val !== null) {
      if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
        fields[fieldKey] = { status: "error", message: "must be a non-negative number" };
        hasError = true;
      } else {
        fields[fieldKey] = { status: "ok" };
      }
    }
  }

  const errorSummary = hasError ? "Form contains validation errors. Please check red fields." : undefined;

  return {
    isValid: !hasError,
    fields,
    ...(errorSummary ? { errorSummary } : {}),
  };
}
