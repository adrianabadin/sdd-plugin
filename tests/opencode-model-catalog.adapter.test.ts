/**
 * Focused test for OpenCodeModelCatalogAdapter.
 *
 * Requirements (all must hold):
 *  1. `client.config.providers()` is the ONLY method used for automatic discovery.
 *  2. Remove `app.providers()`, `provider.list()`, and `config.get()` from the automatic path; do not use as fallbacks.
 *  3. Supported response shapes:
 *       - direct `{ default, providers }`
 *       - `{ data: { default, providers } }`
 *       - defensive malformed handling (primitive, null, empty object, throws).
 *  4. Walk provider `models` entries and preserve provider/model/quarantine/pricing metadata.
 *  5. SDK method binding is preserved: `config.providers` is invoked with `.call(config)` so `this` works.
 *  6. Duplicate/absent catalog sources are irrelevant and never called.
 *  7. MALFORMED endpoint returns empty safely.
 *
 * Run with `npx tsx tests/opencode-model-catalog.adapter.test.ts`.
 */

import { OpenCodeModelCatalogAdapter } from "../src/infrastructure/opencode/opencode-model-catalog.adapter.js";

const failures: string[] = [];

function assert(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error(`  FAIL: ${message}`);
  } else {
    console.log(`  pass: ${message}`);
  }
}

function header(label: string): void {
  console.log(`\n--- ${label} ---`);
}

/**
 * 10 providers including kimi-for-coding with 3 models and openai with its configured model set.
 */
function makeConfigProvidersPayload() {
  return {
    default: { openai: "gpt-4o" },
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        subscription: "pro",
        isBlocked: false,
        provider: {
          quarantineType: "ttl",
          quarantineUntil: "2026-01-15T00:00:00.000Z",
        },
        models: {
          "claude-3-5-sonnet": {
            name: "Claude 3.5 Sonnet",
            mmlu: 0.88,
            humaneval: 0.92,
            model: {
              quarantineType: "permanent",
              quarantineUntil: "2026-02-20T00:00:00.000Z",
            },
            pricing: {
              inputPerMillion: 3,
              outputPerMillion: 15,
              cachedPerMillion: 0.3,
              currency: "USD",
              effectiveFrom: "2025-12-01T00:00:00.000Z",
              effectiveUntil: "2026-06-01T00:00:00.000Z",
            },
          },
          "claude-3-opus": { name: "Claude 3 Opus" },
        },
      },
      {
        id: "google",
        name: "Google",
        models: {
          "gemini-1.5-pro": { name: "Gemini 1.5 Pro" },
          "gemini-1.5-flash": { name: "Gemini 1.5 Flash" },
        },
      },
      {
        id: "meta",
        name: "Meta",
        models: {
          "llama-3-70b": { name: "Llama 3 70B" },
        },
      },
      {
        id: "mistral",
        name: "Mistral",
        models: {
          "mistral-large": { name: "Mistral Large" },
        },
      },
      {
        id: "cohere",
        name: "Cohere",
        models: {
          "command-r": { name: "Command R" },
        },
      },
      {
        id: "perplexity",
        name: "Perplexity",
        models: {
          "sonar": { name: "Sonar" },
        },
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        models: {
          "deepseek-coder": { name: "DeepSeek Coder" },
        },
      },
      {
        id: "grok",
        name: "Grok",
        models: {
          "grok-1.5": { name: "Grok 1.5" },
        },
      },
      {
        id: "kimi-for-coding",
        name: "Kimi For Coding",
        models: {
          "k3": {
            name: "Kimi K3",
            pricing: { inputPerMillion: 0.15, outputPerMillion: 2.5, cachedPerMillion: 0.05 },
          },
          "k3-fast": { name: "Kimi K3 Fast" },
          "k3-coder": { name: "Kimi K3 Coder" },
        },
      },
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4o": { name: "GPT-4o" },
          "gpt-4o-mini": { name: "GPT-4o Mini" },
          "o1-preview": { name: "o1 Preview" },
        },
      },
    ],
  };
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------
  header("Primary source: client.config.providers() with 10 providers");
  // -------------------------------------------------------------------

  {
    const payload = makeConfigProvidersPayload();
    let providersCalls = 0;

    const client = {
      config: {
        providers() {
          providersCalls++;
          return Promise.resolve({ data: payload });
        },
      },
    };

    const adapter = new OpenCodeModelCatalogAdapter(client);
    const models = await adapter.getConnectedModels();

    assert(providersCalls === 1, "config.providers() was called exactly once");
    assert(models.length === 16, `all 16 models returned (got ${models.length})`);

    const ids = models.map((m) => `${m.providerId}/${m.modelId}`).sort();
    assert(ids.includes("kimi-for-coding/k3"), "kimi-for-coding/k3 is present");
    assert(ids.includes("openai/gpt-4o"), "openai/gpt-4o is present");

    const sonnet = models.find((m) => m.modelId === "claude-3-5-sonnet");
    assert(sonnet?.modelName === "Claude 3.5 Sonnet", "modelName comes from nested model object");
    assert(
      sonnet?.pricing?.inputPerMillion === 3 && sonnet?.pricing?.outputPerMillion === 15,
      "pricing extraction still works via config.providers path"
    );
  }

  // -------------------------------------------------------------------
  header("Shape: direct { default, providers } (no data wrapper)");
  // -------------------------------------------------------------------

  {
    const client = {
      config: {
        providers: () => Promise.resolve(makeConfigProvidersPayload()),
      },
    };
    const adapter = new OpenCodeModelCatalogAdapter(client);
    const models = await adapter.getConnectedModels();
    assert(models.length === 16, `direct { default, providers } shape yields 16 models (got ${models.length})`);
  }

  // -------------------------------------------------------------------
  header("Duplicate/absent catalog sources are irrelevant and never called");
  // -------------------------------------------------------------------

  {
    const client = {
      app: {
        providers() {
          throw new Error("Obsolete app.providers was called!");
        },
      },
      provider: {
        list() {
          throw new Error("Obsolete provider.list was called!");
        },
      },
      config: {
        providers: () => Promise.resolve(makeConfigProvidersPayload()),
        get() {
          throw new Error("Obsolete config.get was called!");
        },
      },
    };

    let threw = false;
    let modelsCount = 0;
    try {
      const adapter = new OpenCodeModelCatalogAdapter(client as any);
      const models = await adapter.getConnectedModels();
      modelsCount = models.length;
    } catch (e) {
      threw = true;
      console.error(e);
    }
    assert(!threw, "adapter did not invoke obsolete methods app.providers/provider.list/config.get");
    assert(modelsCount === 16, `returned all 16 models when other methods exist (got ${modelsCount})`);
  }

  // -------------------------------------------------------------------
  header("SDK binding: config.providers invoked with .call(config)");
  // -------------------------------------------------------------------

  {
    const configOwner = {
      marker: "config-owner",
      providers(this: { marker?: string }) {
        if (this?.marker !== "config-owner") {
          throw new Error("config.providers lost its `this` binding");
        }
        return Promise.resolve(makeConfigProvidersPayload());
      },
    };
    const adapter = new OpenCodeModelCatalogAdapter({ config: configOwner });
    const models = await adapter.getConnectedModels();
    assert(models.length === 16, "config.providers invoked with correct `this` binding");
  }

  // -------------------------------------------------------------------
  header("Malformed config.providers returns empty safely");
  // -------------------------------------------------------------------

  {
    const malformedClients = [
      {},
      { config: {} },
      { config: { providers: () => Promise.resolve(null) } },
      { config: { providers: () => Promise.resolve("not-an-object") } },
      { config: { providers: () => Promise.resolve({ data: null }) } },
      { config: { providers: () => Promise.reject(new Error("network error")) } },
    ];

    for (let i = 0; i < malformedClients.length; i++) {
      const client = malformedClients[i]!;
      const adapter = new OpenCodeModelCatalogAdapter(client);
      let threw = false;
      let models: any[] = [];
      try {
        models = await adapter.getConnectedModels() as any[];
      } catch {
        threw = true;
      }
      assert(!threw, `malformed case ${i} does not throw`);
      assert(models.length === 0, `malformed case ${i} returns empty array safely`);
    }
  }

  // -------------------------------------------------------------------
  header("Primary-path metadata preservation (provider/model/pricing)");
  // -------------------------------------------------------------------

  {
    const providerQuarantineUntil = "2026-01-15T00:00:00.000Z";
    const modelQuarantineUntil = "2026-02-20T00:00:00.000Z";
    const effectiveFrom = "2025-12-01T00:00:00.000Z";
    const effectiveUntil = "2026-06-01T00:00:00.000Z";

    const client = {
      config: {
        providers: () =>
          Promise.resolve({
            data: {
              default: { anthropic: "claude-sonnet-4" },
              providers: [
                {
                  id: "anthropic",
                  name: "Anthropic",
                  subscription: "pro",
                  isBlocked: false,
                  provider: {
                    quarantineType: "ttl",
                    quarantineUntil: providerQuarantineUntil,
                  },
                  models: {
                    "claude-sonnet-4": {
                      name: "Claude Sonnet 4",
                      mmlu: 0.88,
                      humaneval: 0.92,
                      sweBench: 0.7,
                      model: {
                        quarantineType: "permanent",
                        quarantineUntil: modelQuarantineUntil,
                      },
                      pricing: {
                        inputPerMillion: 3,
                        outputPerMillion: 15,
                        cachedPerMillion: 0.3,
                        currency: "USD",
                        effectiveFrom,
                        effectiveUntil,
                      },
                    },
                  },
                },
              ],
            },
          }),
      },
    };

    const adapter = new OpenCodeModelCatalogAdapter(client);
    const models = await adapter.getConnectedModels();
    assert(models.length === 1, `metadata fixture yields 1 model (got ${models.length})`);

    const entry = models[0];
    assert(entry !== undefined, "metadata entry exists");
    if (entry !== undefined) {
      assert(entry.provider?.subscription === "pro", "provider subscription preserved");
      assert(entry.provider?.isBlocked === false, "provider isBlocked preserved");
      assert(entry.provider?.quarantineType === "ttl", "provider quarantineType preserved");
      assert(
        entry.provider?.quarantineUntil instanceof Date &&
          entry.provider.quarantineUntil.toISOString() === providerQuarantineUntil,
        "provider quarantineUntil preserved as Date"
      );

      assert(entry.model?.benchmarks?.mmlu === 0.88, "model benchmark mmlu preserved");
      assert(entry.model?.benchmarks?.humaneval === 0.92, "model benchmark humaneval preserved");
      assert(entry.model?.benchmarks?.sweBench === 0.7, "model benchmark sweBench preserved");
      assert(entry.model?.quarantineType === "permanent", "model quarantineType preserved");
      assert(
        entry.model?.quarantineUntil instanceof Date &&
          entry.model.quarantineUntil.toISOString() === modelQuarantineUntil,
        "model quarantineUntil preserved as Date"
      );

      assert(entry.pricing?.inputPerMillion === 3, "pricing inputPerMillion preserved");
      assert(entry.pricing?.outputPerMillion === 15, "pricing outputPerMillion preserved");
      assert(entry.pricing?.cachedPerMillion === 0.3, "pricing cachedPerMillion preserved");
      assert(entry.pricing?.currency === "USD", "pricing currency preserved");
      assert(
        entry.pricing?.effectiveFrom instanceof Date &&
          entry.pricing.effectiveFrom.toISOString() === effectiveFrom,
        "pricing effectiveFrom preserved as Date"
      );
      assert(
        entry.pricing?.effectiveUntil instanceof Date &&
          entry.pricing.effectiveUntil.toISOString() === effectiveUntil,
        "pricing effectiveUntil preserved as Date"
      );
    }
  }

  // -------------------------------------------------------------------
  header("Result");
  // -------------------------------------------------------------------

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
}

await main();
