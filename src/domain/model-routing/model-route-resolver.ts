/**
 * Ordered identity resolution for deterministic model routing.
 *
 * Tiers (highest priority first):
 *   1. exact canonical "provider/model"           -> whitelist.existsCanonical
 *   2. explicit alias lookup                      -> in-memory alias map
 *   3. unique normalized fuzzy match              -> whitelist.searchNormalized
 *
 * Failure modes (fail-loud, no silent substitution):
 *   - 0 candidates -> RouteUnknownError
 *   - >1 candidates from Tier 3 -> RouteAmbiguousError with sorted candidates
 *
 * Identity NEVER consults benchmark/pricing/subscription metadata
 * (authoritative design c96148ae-04f9-468f-9ca7-e14456dc1513).
 *
 * Rev 2: the resolver is now backed by the static `RouteWhitelist`
 * (loaded from `routes.json`); no port, no I/O, no async await.
 * The `async` signature is preserved for call-site compatibility.
 */

import type { CanonicalModelId } from "./canonical-model-id.js";
import { makeCanonicalModelId, parseCanonicalModelId } from "./canonical-model-id.js";
import { RouteWhitelist, type WhitelistedRoute } from "./route-whitelist.js";

export class RouteUnknownError extends Error {
  readonly reference: string;
  constructor(reference: string) {
    super(`Model route "${reference}" could not be resolved (0 candidates across exact/alias/normalized tiers).`);
    this.name = "RouteUnknownError";
    this.reference = reference;
  }
}

export class RouteAmbiguousError extends Error {
  readonly reference: string;
  readonly candidates: ReadonlyArray<{ providerId: string; modelId: string }>;
  constructor(reference: string, candidates: ReadonlyArray<{ providerId: string; modelId: string }>) {
    super(
      `Model route "${reference}" is ambiguous across ${candidates.length} candidates: ` +
        candidates.map((c) => `${c.providerId}/${c.modelId}`).join(", "),
    );
    this.name = "RouteAmbiguousError";
    this.reference = reference;
    this.candidates = candidates;
  }
}

export type ModelRouteAliasTable = ReadonlyMap<string, string>;

export class ModelRouteResolver {
  /** Upper bound from the design contract. */
  static readonly MAX_SEARCH_LIMIT = 8;

  constructor(
    private readonly whitelist: RouteWhitelist,
    private readonly aliases: ModelRouteAliasTable = new Map<string, string>(),
  ) {}

  async resolve(reference: string): Promise<CanonicalModelId> {
    if (typeof reference !== "string" || reference.length === 0) {
      throw new RouteUnknownError(String(reference));
    }

    // Tier 1: exact canonical "provider/model" (exactly one "/", both halves non-empty).
    const slashIdx = reference.indexOf("/");
    if (slashIdx > 0 && reference.indexOf("/", slashIdx + 1) === -1) {
      const providerId = reference.slice(0, slashIdx);
      const modelId = reference.slice(slashIdx + 1);
      if (providerId.length > 0 && modelId.length > 0) {
        if (this.whitelist.existsCanonical(providerId, modelId)) {
          return makeCanonicalModelId(providerId, modelId);
        }
      }
    }

    // Tier 2: explicit alias (case-insensitive: curated alias keys are stored
    // in their canonical lowercase form so user input in any case still maps
    // to the same identity; Tier 3 fuzzy already lowercases internally).
    const aliasCanonical = this.aliases.get(reference.toLowerCase());
    if (typeof aliasCanonical === "string" && aliasCanonical.length > 0) {
      return parseCanonicalModelId(aliasCanonical);
    }

    // Tier 3: unique normalized.
    const candidates: ReadonlyArray<WhitelistedRoute> = this.whitelist.searchNormalized(
      reference,
      ModelRouteResolver.MAX_SEARCH_LIMIT,
    );
    if (candidates.length === 1) {
      const only = candidates[0]!;
      return makeCanonicalModelId(only.providerId, only.modelId);
    }
    if (candidates.length === 0) {
      throw new RouteUnknownError(reference);
    }
    const sorted = candidates.map((c) => ({ providerId: c.providerId, modelId: c.modelId }));
    throw new RouteAmbiguousError(reference, sorted);
  }
}