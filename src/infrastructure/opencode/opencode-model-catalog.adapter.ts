import type { QuarantineType } from "../../domain/model/quarantine.js";
import type {
  ConnectedModelInfo,
  ModelSnapshot,
  PricingSnapshot,
  ProviderSnapshot,
} from "../../domain/model/connected-model.js";
import type {
  ModelCatalogPort,
  RefreshTraceContext,
} from "../../ports/model-catalog.port.js";
import type { ModelRefreshTraceLogger } from "../logging/model-refresh-trace.logger.js";

/**
 * Adapter: read the list of connected models from the OpenCode SDK
 * config.providers() endpoint and normalize it into the domain
 * `ConnectedModelInfo` shape.
 *
 * This is the ONLY module that knows about the SDK's raw object layout.
 * After this adapter, the rest of the system works against pure domain types.
 *
 * Discovery source:
 *   1. `client.config.providers()` — the source of truth endpoint for
 *      automatic model discovery. Invoked with `.call(config)` to preserve
 *      SDK binding.
 *
 * Trace instrumentation: every discovery stage emits a JSONL event
 * via the optional `ModelRefreshTraceLogger`.
 */
export class OpenCodeModelCatalogAdapter implements ModelCatalogPort {
  private readonly trace: ModelRefreshTraceLogger | undefined;

  constructor(
    private readonly client: OpenCodeClient,
    options: { trace?: ModelRefreshTraceLogger } = {},
  ) {
    this.trace = options.trace;
  }

  async getConnectedModels(
    context: RefreshTraceContext = {},
  ): Promise<ReadonlyArray<ConnectedModelInfo>> {
    const correlationId = context.correlationId ?? this.trace?.newCorrelationId() ?? "";
    const startedAt = Date.now();

    if (this.trace) {
      this.trace.trace({
        correlationId,
        stage: "discovery.start",
        status: "start",
        details: summarizeDiscoverySources(this.client),
      });
    }

    try {
      const providersRaw = await this.fetchConfigProvidersRaw(correlationId);
      const providers = extractProviderList(providersRaw);

      // Deduplicate/normalize providers and models from the endpoint payload.
      const providerMap = new Map<string, { providerObj: Record<string, unknown>; models: Map<string, Record<string, unknown>> }>();

      for (const prov of providers) {
        if (!isPlainObject(prov)) continue;
        const providerId = pickString(prov.id) ?? pickString(prov.name) ?? "unknown-provider";
        let entry = providerMap.get(providerId);
        if (!entry) {
          entry = { providerObj: prov, models: new Map() };
          providerMap.set(providerId, entry);
        } else {
          entry.providerObj = deepMergeCatalogPriority(entry.providerObj, prov);
        }

        const modelsObj = isPlainObject(prov.models) ? prov.models : {};
        for (const [modelId, modelObj] of Object.entries(modelsObj)) {
          if (!isPlainObject(modelObj)) continue;
          const existing = entry.models.get(modelId);
          if (existing) {
            entry.models.set(modelId, deepMergeCatalogPriority(existing, modelObj));
          } else {
            entry.models.set(modelId, modelObj);
          }
        }
      }

      const result: ConnectedModelInfo[] = [];
      for (const [providerId, entry] of providerMap) {
        const providerSnapshot = extractProviderSnapshot(entry.providerObj);
        for (const [rawModelId, modelObj] of entry.models) {
          const normalized = normalizeEntry(providerId, providerSnapshot, rawModelId, modelObj);
          if (normalized !== null) result.push(normalized);
        }
      }

      if (this.trace) {
        this.trace.trace({
          correlationId,
          stage: "discovery.normalize",
          status: "success",
          details: {
            sourceCount: providers.length,
            modelCount: result.length,
          },
        });
        this.trace.trace({
          correlationId,
          stage: "discovery.finish",
          status: "success",
          durationMs: Date.now() - startedAt,
          details: {
            providerCount: providers.length,
            modelCount: result.length,
            sources: summarizeDiscoverySources(this.client),
          },
        });
      }

      return result;
    } catch (error) {
      if (this.trace) {
        this.trace.error({
          correlationId,
          stage: "discovery.finish",
          durationMs: Date.now() - startedAt,
          error,
        });
      }
      throw error;
    }
  }

  /**
   * Fetch the raw provider list from `client.config.providers()`.
   * Preserves response shapes needed by this endpoint ({providers, default},
   * optionally {data:{providers,default}}, and defensive malformed handling).
   *
   * Called with `.call(config)` to preserve SDK binding.
   */
  private async fetchConfigProvidersRaw(correlationId: string): Promise<unknown> {
    const client = this.client ?? {};
    const config = (client as { config?: { providers?: () => Promise<unknown> } }).config;
    if (!config || typeof config.providers !== "function") {
      const requestStartedAt = Date.now();
      if (this.trace) {
        this.trace.trace({
          correlationId,
          stage: "config.providers.request",
          status: "request",
        });
        this.trace.error({
          correlationId,
          stage: "config.providers.failure",
          durationMs: Date.now() - requestStartedAt,
          error: new Error("config.providers unavailable"),
        });
      }
      return undefined;
    }

    const requestStartedAt = Date.now();
    if (this.trace) {
      this.trace.trace({
        correlationId,
        stage: "config.providers.request",
        status: "request",
      });
    }

    try {
      const value = await Promise.resolve(config.providers.call(config));
      if (this.trace) {
        const providers = extractProviderList(value);
        this.trace.trace({
          correlationId,
          stage: "config.providers.response",
          status: "response",
          durationMs: Date.now() - requestStartedAt,
          details: {
            shape: describeShape(value),
            providerCount: providers.length,
            modelCount: countModelsInProviders(providers),
          },
        });
      }
      return value;
    } catch (error) {
      if (this.trace) {
        this.trace.error({
          correlationId,
          stage: "config.providers.failure",
          durationMs: Date.now() - requestStartedAt,
          error,
        });
      }
      return undefined;
    }
  }
}

function extractProviderList(result: unknown): unknown[] {
  const data: unknown = (result as { data?: unknown } | null | undefined)?.data ?? result;
  if (!data || typeof data !== "object") {
    if (Array.isArray(data)) return data;
    return [];
  }
  const candidate = data as { all?: unknown; providers?: unknown };
  if (Array.isArray(candidate.all)) return candidate.all;
  if (Array.isArray(candidate.providers)) return candidate.providers;
  if (Array.isArray(data)) return data;
  return [];
}

/**
 * Count the total number of model entries across a list of provider
 * objects (each provider is expected to expose a `models` record).
 * Returns 0 for any malformed entry — never throws.
 */
function countModelsInProviders(providers: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const provider of providers) {
    if (!isPlainObject(provider)) continue;
    const models = provider.models;
    if (!isPlainObject(models)) continue;
    total += Object.keys(models).length;
  }
  return total;
}

/**
 * Classify the top-level shape of an SDK response.
 */
function describeShape(result: unknown): string {
  if (result === null || result === undefined) return "null";
  if (Array.isArray(result)) return "array";
  if (typeof result !== "object") return typeof result;
  const outer = result as { data?: unknown };
  if (outer.data !== undefined) {
    if (Array.isArray(outer.data)) return "data:array";
    if (isPlainObject(outer.data)) {
      const inner = outer.data as { providers?: unknown; all?: unknown };
      if (Array.isArray(inner.providers)) return "data:providers";
      if (Array.isArray(inner.all)) return "data:all";
      return "data:object";
    }
    return "data:unknown";
  }
  const direct = result as { providers?: unknown; all?: unknown };
  if (Array.isArray(direct.providers)) return "providers";
  if (Array.isArray(direct.all)) return "all";
  return "object";
}

/**
 * Report which discovery sources the supplied client exposes.
 */
function summarizeDiscoverySources(client: OpenCodeClient): {
  configProviders: boolean;
} {
  const c = client ?? {};
  const config = (c as { config?: { providers?: unknown } }).config;
  return {
    configProviders: !!config && typeof config.providers === "function",
  };
}

/**
 * Catalog-wins, config-fills deep merge.
 */
function deepMergeCatalogPriority(
  catalog: Record<string, unknown>,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...catalog };
  for (const [key, configValue] of Object.entries(config)) {
    const catalogValue = catalog[key];

    if (catalogValue === undefined || catalogValue === null) {
      merged[key] = configValue;
    } else if (isPlainObject(catalogValue) && isPlainObject(configValue)) {
      merged[key] = deepMergeCatalogPriority(
        catalogValue as Record<string, unknown>,
        configValue as Record<string, unknown>,
      );
    }
  }
  return merged;
}

function normalizeEntry(
  providerId: string,
  providerSnapshot: ProviderSnapshot | undefined,
  rawModelId: string,
  modelObj: Record<string, unknown>
): ConnectedModelInfo | null {
  const modelName = pickString(modelObj.name) ?? rawModelId;
  const modelId = rawModelId.includes('/') ? rawModelId.split('/').pop()! : rawModelId;

  return {
    providerId,
    modelId,
    modelName,
    provider: providerSnapshot,
    model: extractModelSnapshot(modelObj),
    modelProviderQuarantineType: pickQuarantine(modelObj.quarantineType),
    modelProviderQuarantineUntil: pickDate(modelObj.quarantineUntil),
    pricing: extractPricingSnapshot(modelObj),
  };
}

function extractProviderSnapshot(obj: Record<string, unknown>): ProviderSnapshot | undefined {
  const nested = isPlainObject(obj.provider) ? obj.provider : undefined;

  const subscription = pickString(obj.subscription);
  const isBlocked = pickBoolean(obj.isBlocked);
  const quarantineType = nested ? pickQuarantine(nested.quarantineType) : undefined;
  const quarantineUntil = nested ? pickDate(nested.quarantineUntil) : undefined;

  const hasAny =
    subscription !== undefined ||
    isBlocked !== undefined ||
    quarantineType !== undefined ||
    quarantineUntil !== undefined;
  if (!hasAny) return undefined;

  return {
    subscription,
    isBlocked,
    quarantineType,
    quarantineUntil,
  };
}

function extractModelSnapshot(obj: Record<string, unknown>): ModelSnapshot | undefined {
  const nested = isPlainObject(obj.model) ? obj.model : undefined;

  const benchmarks = extractBenchmarks(obj);
  const quarantineType = nested ? pickQuarantine(nested.quarantineType) : undefined;
  const quarantineUntil = nested ? pickDate(nested.quarantineUntil) : undefined;

  const hasAny =
    benchmarks !== undefined ||
    quarantineType !== undefined ||
    quarantineUntil !== undefined;
  if (!hasAny) return undefined;

  return {
    benchmarks,
    quarantineType,
    quarantineUntil,
  };
}

function extractBenchmarks(obj: Record<string, unknown>): ModelSnapshot["benchmarks"] | undefined {
  const out: NonNullable<ModelSnapshot["benchmarks"]> = {};
  let touched = false;
  for (const field of [
    "mmlu",
    "humaneval",
    "sweBench",
    "gpqa",
    "math",
    "bbh",
    "mtBench",
    "multineedle",
  ] as const) {
    const v = pickNumber(obj[field]);
    if (v !== undefined) {
      (out as Record<string, unknown>)[field] = v;
      touched = true;
    }
  }
  return touched ? out : undefined;
}

function extractPricingSnapshot(obj: Record<string, unknown>): PricingSnapshot | undefined {
  const topLevelPricing = isPlainObject(obj.pricing) ? obj.pricing : undefined;
  const nestedPricing =
    !topLevelPricing && isPlainObject(obj.metadata) && isPlainObject(obj.metadata.pricing)
      ? (obj.metadata.pricing as Record<string, unknown>)
      : undefined;

  const hasAny =
    obj.pricing !== undefined ||
    nestedPricing !== undefined ||
    obj.inputPerMillion !== undefined ||
    obj.outputPerMillion !== undefined ||
    obj.cachedPerMillion !== undefined;
  if (!hasAny) return undefined;

  const source = topLevelPricing ?? nestedPricing ?? obj;

  const inputPerMillion = pickNumber(source.inputPerMillion) ?? pickNumber(source.input);
  const outputPerMillion = pickNumber(source.outputPerMillion) ?? pickNumber(source.output);
  const cachedPerMillion = pickNumber(source.cachedPerMillion) ?? pickNumber(source.cached);
  const currency = pickString(source.currency);
  const effectiveFrom = pickDate(source.effectiveFrom) ?? pickDate(source.effective_from);
  const effectiveUntil = pickDate(source.effectiveUntil) ?? pickDate(source.effective_until);

  return {
    inputPerMillion,
    outputPerMillion,
    cachedPerMillion,
    currency,
    effectiveFrom,
    effectiveUntil,
  };
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pickNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function pickBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "boolean" ? value : Boolean(value);
}

function pickDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value;
  const date = new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pickQuarantine(value: unknown): QuarantineType | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === "ttl" || value === "permanent") return value;
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * OpenCode client interface contract.
 */
export interface OpenCodeClient {
  app?: {
    log?: unknown;
  };
  config?: {
    providers?: () => Promise<unknown>;
  };
}
