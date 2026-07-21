import crypto from 'node:crypto';

export const METADATA_VERSION = 1;

export interface ProviderMetadata {
  version: number;
  planName: string | null;
  periodicCost: number | null;
  includedUsage: number | null;
  overageRate: number | null;
}

export interface ModelMetadata {
  version: number;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: string[];
}

export function parseProviderMetadata(raw: string | null | undefined): ProviderMetadata {
  const defaultMeta: ProviderMetadata = {
    version: METADATA_VERSION,
    planName: null,
    periodicCost: null,
    includedUsage: null,
    overageRate: null,
  };

  if (!raw) return defaultMeta;

  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return defaultMeta;

    return {
      version: typeof obj.version === 'number' ? obj.version : METADATA_VERSION,
      planName: typeof obj.planName === 'string' ? obj.planName : null,
      periodicCost: typeof obj.periodicCost === 'number' ? obj.periodicCost : null,
      includedUsage: typeof obj.includedUsage === 'number' ? obj.includedUsage : null,
      overageRate: typeof obj.overageRate === 'number' ? obj.overageRate : null,
    };
  } catch {
    return defaultMeta;
  }
}

export function serializeProviderMetadata(meta: ProviderMetadata): string {
  return JSON.stringify({
    version: meta.version || METADATA_VERSION,
    planName: meta.planName ?? null,
    periodicCost: meta.periodicCost ?? null,
    includedUsage: meta.includedUsage ?? null,
    overageRate: meta.overageRate ?? null,
  });
}

export function parseModelMetadata(raw: string | null | undefined): ModelMetadata {
  const defaultMeta: ModelMetadata = {
    version: METADATA_VERSION,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: [],
  };

  if (!raw) return defaultMeta;

  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return defaultMeta;

    return {
      version: typeof obj.version === 'number' ? obj.version : METADATA_VERSION,
      contextWindow: typeof obj.contextWindow === 'number' ? obj.contextWindow : null,
      maxOutputTokens: typeof obj.maxOutputTokens === 'number' ? obj.maxOutputTokens : null,
      capabilities: Array.isArray(obj.capabilities)
        ? obj.capabilities.filter((c: unknown): c is string => typeof c === 'string')
        : [],
    };
  } catch {
    return defaultMeta;
  }
}

export function serializeModelMetadata(meta: ModelMetadata): string {
  return JSON.stringify({
    version: meta.version || METADATA_VERSION,
    contextWindow: meta.contextWindow ?? null,
    maxOutputTokens: meta.maxOutputTokens ?? null,
    capabilities: Array.isArray(meta.capabilities) ? meta.capabilities : [],
  });
}

export function computeEnvelopeHash(
  providerMeta: ProviderMetadata,
  modelMeta?: ModelMetadata,
): string {
  const payload = JSON.stringify({
    p: providerMeta,
    m: modelMeta ?? null,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
}
