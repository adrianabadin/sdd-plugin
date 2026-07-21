import type { ConnectedModelInfo } from "../domain/model/connected-model.js";

export type CatalogView =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      providers: ProviderSummary[];
      modelsByProvider: Map<string, ConnectedModelInfo[]>;
    };

export interface ProviderSummary {
  readonly providerId: string;
  readonly modelCount: number;
}

/**
 * Derives provider summaries from connected models.
 * Groups by providerId, computes model counts, and sorts providerId ascending code-unit order.
 * Providers with zero models are omitted.
 */
export function buildProviderSummaries(models: ReadonlyArray<ConnectedModelInfo>): ProviderSummary[] {
  const countsMap = new Map<string, number>();

  for (const item of models) {
    const current = countsMap.get(item.providerId) ?? 0;
    countsMap.set(item.providerId, current + 1);
  }

  const summaries: ProviderSummary[] = [];
  for (const [providerId, modelCount] of countsMap.entries()) {
    if (modelCount > 0) {
      summaries.push({ providerId, modelCount });
    }
  }

  summaries.sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0));
  return summaries;
}

/**
 * Filters and sorts models for a specific provider view.
 * Search matching is case-insensitive substring matching on modelId or modelName.
 * Search queries with special regex characters or long strings are treated strictly as literal string matches.
 * Sorting order: modelName.toLowerCase() ascending, with modelId ascending code-unit tie-break.
 */
export function filterModels(
  models: ReadonlyArray<ConnectedModelInfo>,
  query: string
): ConnectedModelInfo[] {
  const normalizedQuery = query.trim().toLowerCase();

  const filtered = models.filter((item) => {
    if (!normalizedQuery) return true;
    const matchId = item.modelId.toLowerCase().includes(normalizedQuery);
    const matchName = item.modelName.toLowerCase().includes(normalizedQuery);
    return matchId || matchName;
  });

  return [...filtered].sort((a, b) => {
    const nameA = a.modelName.toLowerCase();
    const nameB = b.modelName.toLowerCase();
    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;

    // Tie-break by modelId ascending code-unit
    if (a.modelId < b.modelId) return -1;
    if (a.modelId > b.modelId) return 1;
    return 0;
  });
}
