/**
 * Read-side port for the deterministic model-routing catalog query.
 * Identity-only projection: never exposes benchmark/pricing/subscription
 * metadata (authoritative design c96148ae-04f9-468f-9ca7-e14456dc1513).
 */

export interface RouteCandidate {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelName: string;
}

export interface ModelRouteCatalogPort {
  existsCanonical(providerId: string, modelId: string): Promise<boolean>;
  searchNormalized(term: string, limit: number): Promise<ReadonlyArray<RouteCandidate>>;
}