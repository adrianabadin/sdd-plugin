/**
 * Canonical identity value object. Identity is strictly
 * `providerId/modelId`; benchmark/pricing/subscription metadata NEVER
 * influences identity (design c96148ae-04f9-468f-9ca7-e14456dc1513).
 */

export interface CanonicalModelId {
  readonly providerId: string;
  readonly modelId: string;
  toString(): string;
}

export function makeCanonicalModelId(providerId: string, modelId: string): CanonicalModelId {
  if (typeof providerId !== "string" || providerId.length === 0 || providerId.includes("/")) {
    throw new Error(`CanonicalModelId.providerId must be non-empty and free of "/" (got ${JSON.stringify(providerId)})`);
  }
  if (typeof modelId !== "string" || modelId.length === 0 || modelId.includes("/")) {
    throw new Error(`CanonicalModelId.modelId must be non-empty and free of "/" (got ${JSON.stringify(modelId)})`);
  }
  return {
    providerId,
    modelId,
    toString() {
      return `${providerId}/${modelId}`;
    },
  };
}

export function parseCanonicalModelId(input: string): CanonicalModelId {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`CanonicalModelId.parse requires a non-empty string`);
  }
  const slash = input.indexOf("/");
  if (slash < 0) throw new Error(`CanonicalModelId.parse missing "/" in ${JSON.stringify(input)}`);
  if (input.indexOf("/", slash + 1) >= 0) {
    throw new Error(`CanonicalModelId.parse has more than one "/" in ${JSON.stringify(input)}`);
  }
  return makeCanonicalModelId(input.slice(0, slash), input.slice(slash + 1));
}