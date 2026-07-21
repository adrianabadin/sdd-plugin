import type { QuarantineType } from "./quarantine.js";

/**
 * Canonical representation of the link between a Model and a Provider
 * (the concrete instance of a model exposed by a provider, e.g.
 * "claude-3-5-sonnet via Anthropic" vs "claude-3-5-sonnet via Bedrock").
 *
 * Each link can carry its own quarantine independent of model/provider-level
 * quarantine (e.g. Anthropic as a whole is fine, but their Claude 3.5
 * tier has a temporary block).
 */
export interface ModelProviderData {
  readonly modelId: string;
  readonly providerId: string;
  readonly quarantineType?: QuarantineType | null | undefined;
  readonly quarantineUntil?: Date | null | undefined;
}

/**
 * Identifier returned by the repository after upserting a ModelProvider.
 * The Prisma layer uses a UUID by default; downstream code needs this
 * to attach pricing records to the same link.
 */
export interface UpsertedModelProvider {
  readonly id: string;
}
