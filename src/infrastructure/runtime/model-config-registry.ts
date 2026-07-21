export interface EffectiveModelConfig {
  providerId: string;
  modelId: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: string[];
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cachedPerMillion: number | null;
  currency: string;
  isBlocked: boolean;
  subscription: string | null;
  metadataEnvelopeHash: string | null;
}

export interface ModelConfigRegistry {
  readonly revision: number;
  publish(config: EffectiveModelConfig): void;
  get(providerId: string, modelId: string): EffectiveModelConfig | undefined;
  subscribe(fn: (config: EffectiveModelConfig) => void): () => void;
}

const REGISTRY_SYMBOL = Symbol.for("sdd-plugin.model-config-registry.v1");

class InMemoryModelConfigRegistry implements ModelConfigRegistry {
  private _revision = 0;
  private entries = new Map<string, EffectiveModelConfig>();
  private listeners = new Set<(config: EffectiveModelConfig) => void>();

  get revision(): number {
    return this._revision;
  }

  publish(config: EffectiveModelConfig): void {
    const key = `${config.providerId}/${config.modelId}`;
    this.entries.set(key, config);
    this._revision++;
    for (const listener of this.listeners) {
      try {
        listener(config);
      } catch (err) {
        // Listener failure isolation
        console.error("[ModelConfigRegistry] Listener error:", err);
      }
    }
  }

  get(providerId: string, modelId: string): EffectiveModelConfig | undefined {
    return this.entries.get(`${providerId}/${modelId}`);
  }

  subscribe(fn: (config: EffectiveModelConfig) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export function getOrCreateModelConfigRegistry(): ModelConfigRegistry {
  const globalObj = globalThis as Record<string | symbol, unknown>;
  if (!globalObj[REGISTRY_SYMBOL]) {
    globalObj[REGISTRY_SYMBOL] = new InMemoryModelConfigRegistry();
  }
  return globalObj[REGISTRY_SYMBOL] as ModelConfigRegistry;
}
