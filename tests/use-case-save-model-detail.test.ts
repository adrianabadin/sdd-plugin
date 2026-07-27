import assert from 'node:assert/strict';
import { SaveModelDetailUseCase, type SaveModelDetailInput } from '../src/application/save-model-detail/save-model-detail.use-case.js';
import type { ModelDetailWritePort, SaveModelDetailCommand } from '../src/ports/model-detail-write.port.js';
import type { ModelDetailQueryPort, PersistedModelDetail } from '../src/ports/model-detail-query.port.js';
import type { ModelConfigRegistry, EffectiveModelConfig } from '../src/infrastructure/runtime/model-config-registry.js';

console.log('--- SaveModelDetailUseCase Test ---');

const BENCHMARKS = {
  mmlu: 88,
  humaneval: 90,
  sweBench: 45,
  gpqa: 53.4,
  math: 76.8,
  bbh: 83.1,
  mtBench: 8.9,
  multineedle: 99.1,
};

const PRICING = {
  inputPerMillion: 2.5,
  outputPerMillion: 10,
  cachedPerMillion: 1.25,
  currency: 'USD',
};

class MockWriteAdapter implements ModelDetailWritePort {
  public savedCommand: SaveModelDetailCommand | null = null;
  public shouldFail = false;

  async saveModelDetail(cmd: SaveModelDetailCommand) {
    if (this.shouldFail) {
      throw new Error('Database write error');
    }
    this.savedCommand = cmd;
    return {
      updatedAt: new Date('2026-07-21T18:00:00Z'),
      envelopeHash: cmd.expectedEnvelopeHash || 'new-hash-1234',
    };
  }
}

class MockRegistry implements ModelConfigRegistry {
  public published: EffectiveModelConfig | null = null;
  public revision = 0;
  public shouldFail = false;

  publish(c: EffectiveModelConfig) {
    if (this.shouldFail) {
      throw new Error('Publish error');
    }
    this.published = c;
    this.revision++;
  }
  get() { return undefined; }
  subscribe() { return () => {}; }
}

/** Build a readback snapshot that mirrors the saved input by default. */
function makePersisted(overrides: Partial<PersistedModelDetail> = {}): PersistedModelDetail {
  return {
    providerId: 'openai',
    providerName: 'OpenAI',
    providerSubscription: 'pro',
    providerIsBlocked: false,
    providerQuarantineType: null,
    providerQuarantineUntil: null,
    providerMetadata: { version: 1, planName: 'Pro Tier', periodicCost: 20, includedUsage: 100, overageRate: 0.05 },
    modelId: 'gpt-4o',
    modelName: 'GPT-4o',
    benchmarks: { ...BENCHMARKS },
    modelQuarantineType: null,
    modelQuarantineUntil: null,
    modelMetadata: { version: 1, contextWindow: 128000, maxOutputTokens: 4096, capabilities: ['coding'] },
    updatedAt: new Date('2026-07-21T18:00:00Z'),
    metadataEnvelopeHash: 'new-hash-1234',
    modelProviderQuarantineType: null,
    modelProviderQuarantineUntil: null,
    pricing: {
      id: 'pricing-1',
      inputPerMillion: PRICING.inputPerMillion,
      outputPerMillion: PRICING.outputPerMillion,
      cachedPerMillion: PRICING.cachedPerMillion,
      currency: PRICING.currency,
      effectiveFrom: new Date('2026-07-21T18:00:00Z'),
      effectiveUntil: null,
    },
    ...overrides,
  } as PersistedModelDetail;
}

class MockVerifierQueryPort implements ModelDetailQueryPort {
  public callCount = 0;
  constructor(
    private behaviour: { mode: 'match' } | { mode: 'mismatch' } | { mode: 'null' } | { mode: 'throw' } = { mode: 'match' },
  ) {}

  async findModelDetail(): Promise<PersistedModelDetail | null> {
    this.callCount++;
    if (this.behaviour.mode === 'throw') {
      throw new Error('Verifier connection lost');
    }
    if (this.behaviour.mode === 'null') {
      return null;
    }
    if (this.behaviour.mode === 'mismatch') {
      return makePersisted({ benchmarks: { ...BENCHMARKS, gpqa: 1.1 } });
    }
    return makePersisted();
  }
}

const input: SaveModelDetailInput = {
  providerId: 'openai',
  modelId: 'gpt-4o',
  providerName: 'OpenAI',
  modelName: 'GPT-4o',
  isBlocked: false,
  subscription: 'pro',
  planName: 'Pro Tier',
  periodicCost: 20,
  includedUsage: 100,
  overageRate: 0.05,
  contextWindow: 128000,
  maxOutputTokens: 4096,
  capabilities: ['coding'],
  benchmarks: { ...BENCHMARKS },
  pricing: { ...PRICING },
  expectedEnvelopeHash: null,
};

async function runTests() {
  // Test 1: Valid save -> DB commit -> verified readback -> Registry publish
  const adapter = new MockWriteAdapter();
  const registry = new MockRegistry();
  const verifier = new MockVerifierQueryPort({ mode: 'match' });
  const useCase = new SaveModelDetailUseCase(adapter, registry, verifier);

  const result = await useCase.execute(input);
  assert.equal(result.outcome, 'verified');
  assert.ok(adapter.savedCommand !== null);
  assert.equal(verifier.callCount, 1, 'verifier must be queried exactly once per save');
  assert.ok(registry.published !== null);
  assert.equal(registry.published?.providerId, 'openai');
  console.log('  pass: valid save verifies readback then publishes to registry');

  // Test 1b: all eight benchmark fields reach the write command
  const savedBenchmarks = adapter.savedCommand!.model.benchmarks;
  for (const [key, value] of Object.entries(BENCHMARKS)) {
    assert.equal(
      (savedBenchmarks as Record<string, number | null>)[key],
      value,
      `benchmark ${key} must reach the write command`,
    );
  }
  console.log('  pass: all eight benchmark fields reach the write command');

  // Test 2: DB Failure -> error thrown, no registry publish
  adapter.shouldFail = true;
  registry.published = null;
  await assert.rejects(
    () => useCase.execute(input),
    (e: Error) => e.message === 'Database write error',
  );
  assert.equal(registry.published, null);
  console.log('  pass: DB failure prevents registry publish');

  // Test 3: Registry publish failure -> DB commit kept, returns warning status
  adapter.shouldFail = false;
  registry.shouldFail = true;
  const resultWarn = await useCase.execute(input);
  assert.equal(resultWarn.outcome, 'verified', 'publish failure still reports verified');
  assert.ok(resultWarn.warning !== undefined, 'publish failure surfaces warning');
  console.log('  pass: publish failure keeps DB commit and returns warning');

  // Test 4: Verification mismatch -> committed-unverified, no publish, no throw
  const mismatchRegistry = new MockRegistry();
  const mismatchVerifier = new MockVerifierQueryPort({ mode: 'mismatch' });
  const mismatchUseCase = new SaveModelDetailUseCase(new MockWriteAdapter(), mismatchRegistry, mismatchVerifier);
  const mismatchResult = await mismatchUseCase.execute(input);
  assert.equal(mismatchResult.outcome, 'committed-unverified', 'mismatch must report committed-unverified');
  assert.ok(Array.isArray(mismatchResult.mismatches) && (mismatchResult.mismatches as string[]).length > 0, 'mismatches list populated');
  assert.equal(mismatchRegistry.published, null, 'mismatch must not publish to registry');
  console.log('  pass: verification mismatch returns committed-unverified and blocks publication');

  // Test 5: Verifier query throws -> save fails, registry not published
  const throwRegistry = new MockRegistry();
  const throwUseCase = new SaveModelDetailUseCase(
    new MockWriteAdapter(),
    throwRegistry,
    new MockVerifierQueryPort({ mode: 'throw' }),
  );
  await assert.rejects(
    () => throwUseCase.execute(input),
    (e: Error) => e.message.includes('Verifier connection lost'),
  );
  assert.equal(throwRegistry.published, null, 'verifier failure must not publish to registry');
  console.log('  pass: verifier query failure fails save and blocks publication');

  // Test 6: Readback returns null -> committed-unverified, no publish, no throw
  const nullRegistry = new MockRegistry();
  const nullUseCase = new SaveModelDetailUseCase(
    new MockWriteAdapter(),
    nullRegistry,
    new MockVerifierQueryPort({ mode: 'null' }),
  );
  const nullResult = await nullUseCase.execute(input);
  assert.equal(nullResult.outcome, 'committed-unverified', 'null readback must report committed-unverified');
  assert.ok(typeof nullResult.guidance === 'string' && (nullResult.guidance as string).length > 0, 'null readback guidance populated');
  assert.equal(nullRegistry.published, null, 'null readback must not publish to registry');
  console.log('  pass: null readback returns committed-unverified and blocks publication');

  // Test 7: Missing benchmark key is rejected before any write happens
  const strictAdapter = new MockWriteAdapter();
  const strictUseCase = new SaveModelDetailUseCase(
    strictAdapter,
    new MockRegistry(),
    new MockVerifierQueryPort({ mode: 'match' }),
  );
  const partial = { ...input, benchmarks: { mmlu: 88, humaneval: 90, sweBench: 45 } } as unknown as SaveModelDetailInput;
  await assert.rejects(
    () => strictUseCase.execute(partial),
    (e: Error) => e.message.includes("missing required benchmark field 'gpqa'"),
  );
  assert.equal(strictAdapter.savedCommand, null, 'incomplete input must not reach the write port');
  console.log('  pass: incomplete benchmark input rejected before write');
}

runTests()
  .then(() => console.log('All SaveModelDetailUseCase assertions passed!'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
