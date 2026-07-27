import assert from 'node:assert/strict';
import { SaveModelDetailUseCase, type SaveModelDetailInput } from '../src/application/save-model-detail/save-model-detail.use-case.js';
import type { ModelDetailQueryPort, PersistedModelDetail } from '../src/ports/model-detail-query.port.js';
import type { ModelDetailWritePort, SaveModelDetailCommand } from '../src/ports/model-detail-write.port.js';

console.log('--- Task 4: Read-After-Write Independent Verification Test ---');

class MockWritePort implements ModelDetailWritePort {
  public savedCommand: SaveModelDetailCommand | null = null;
  async saveModelDetail(cmd: SaveModelDetailCommand): Promise<{ updatedAt: Date; envelopeHash: string }> {
    this.savedCommand = cmd;
    return { updatedAt: new Date(), envelopeHash: 'hash-123' };
  }
}

class MockRegistry {
  public published: any = null;
  publish(config: any) {
    this.published = config;
  }
}

const writePort = new MockWritePort();
const registry = new MockRegistry();

// Mock query verifier port
class MockQueryPort implements ModelDetailQueryPort {
  constructor(private mockData: PersistedModelDetail | null) {}
  async findModelDetail(providerId: string, modelId: string): Promise<PersistedModelDetail | null> {
    return this.mockData;
  }
}

const input: SaveModelDetailInput = {
  providerId: 'openai',
  modelId: 'gpt-4o',
  providerName: 'OpenAI',
  modelName: 'GPT-4o',
  isBlocked: false,
  subscription: null,
  planName: null,
  periodicCost: null,
  includedUsage: null,
  overageRate: null,
  contextWindow: 128000,
  maxOutputTokens: 4096,
  capabilities: ['vision'],
  benchmarks: {
    mmlu: 88.5,
    humaneval: 90.2,
    sweBench: 48.6,
    gpqa: 53.4,
    math: 76.8,
    bbh: 83.1,
    mtBench: 8.9,
    multineedle: 99.1,
  },
  pricing: {
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
    cachedPerMillion: 1.25,
    currency: 'USD',
  },
  expectedEnvelopeHash: null,
};

// Case 4a: Mismatch in benchmark field -> Save must fail and registry must NOT be published
const queryMismatch = new MockQueryPort({
  providerId: 'openai',
  providerName: 'OpenAI',
  providerSubscription: null,
  providerIsBlocked: false,
  providerQuarantineType: null,
  providerQuarantineUntil: null,
  providerMetadata: { version: 1, planName: null, periodicCost: null, includedUsage: null, overageRate: null },
  modelId: 'gpt-4o',
  modelName: 'GPT-4o',
  benchmarks: {
    mmlu: 88.5,
    humaneval: 90.2,
    sweBench: 48.6,
    gpqa: 50.0, // MISMATCH! Expected 53.4
    math: 76.8,
    bbh: 83.1,
    mtBench: 8.9,
    multineedle: 99.1,
  },
  modelQuarantineType: null,
  modelQuarantineUntil: null,
  modelMetadata: { version: 1, contextWindow: 128000, maxOutputTokens: 4096, capabilities: ['vision'] },
  updatedAt: new Date(),
  metadataEnvelopeHash: 'hash-123',
  modelProviderQuarantineType: null,
  modelProviderQuarantineUntil: null,
  pricing: {
    id: 'p-1',
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
    cachedPerMillion: 1.25,
    currency: 'USD',
    effectiveFrom: new Date(),
    effectiveUntil: null,
  },
});

const useCaseMismatch = new SaveModelDetailUseCase(writePort, registry as any, queryMismatch);

async function testMismatch() {
  registry.published = null;
  const mismatchResult = await useCaseMismatch.execute(input);
  assert.equal(mismatchResult.outcome, 'committed-unverified', 'Mismatch must report committed-unverified');
  assert.ok(
    Array.isArray(mismatchResult.mismatches) && (mismatchResult.mismatches as string[]).length > 0,
    'Mismatches list must be populated on mismatch',
  );
  assert.equal(registry.published, null, 'Registry must not be published on verification mismatch');
  console.log('  pass: Mismatch in read-after-write verification returns committed-unverified and prevents registry publication');
}

// Case 4b: Exact match -> Save succeeds and registry is published
const queryMatch = new MockQueryPort({
  providerId: 'openai',
  providerName: 'OpenAI',
  providerSubscription: null,
  providerIsBlocked: false,
  providerQuarantineType: null,
  providerQuarantineUntil: null,
  providerMetadata: { version: 1, planName: null, periodicCost: null, includedUsage: null, overageRate: null },
  modelId: 'gpt-4o',
  modelName: 'GPT-4o',
  benchmarks: {
    mmlu: 88.5,
    humaneval: 90.2,
    sweBench: 48.6,
    gpqa: 53.4,
    math: 76.8,
    bbh: 83.1,
    mtBench: 8.9,
    multineedle: 99.1,
  },
  modelQuarantineType: null,
  modelQuarantineUntil: null,
  modelMetadata: { version: 1, contextWindow: 128000, maxOutputTokens: 4096, capabilities: ['vision'] },
  updatedAt: new Date(),
  metadataEnvelopeHash: 'hash-123',
  modelProviderQuarantineType: null,
  modelProviderQuarantineUntil: null,
  pricing: {
    id: 'p-1',
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
    cachedPerMillion: 1.25,
    currency: 'USD',
    effectiveFrom: new Date(),
    effectiveUntil: null,
  },
});

const useCaseMatch = new SaveModelDetailUseCase(writePort, registry as any, queryMatch);

async function testMatch() {
  registry.published = null;
  const res = await useCaseMatch.execute(input);
  assert.equal(res.outcome, 'verified');
  assert.notEqual(registry.published, null, 'Registry must be published on successful verification');
  console.log('  pass: Verified match allows Save success and publishes to registry');
}

// === Additional mismatch cases: provider metadata, model metadata, envelope hash, null-pricing stale row.
const inputWithMeta: SaveModelDetailInput = {
  ...input,
  planName: 'Team',
  periodicCost: 30,
  includedUsage: 500,
  overageRate: 0.02,
  contextWindow: 200000,
  maxOutputTokens: 8192,
  capabilities: ['coding', 'vision'],
};

function cloneWithMeta(overrides: Partial<PersistedModelDetail> = {}): PersistedModelDetail {
  return {
    providerId: 'openai',
    providerName: 'OpenAI',
    providerSubscription: null,
    providerIsBlocked: false,
    providerQuarantineType: null,
    providerQuarantineUntil: null,
    providerMetadata: { version: 1, planName: 'Team', periodicCost: 30, includedUsage: 500, overageRate: 0.02 },
    modelId: 'gpt-4o',
    modelName: 'GPT-4o',
    benchmarks: inputWithMeta.benchmarks,
    modelQuarantineType: null,
    modelQuarantineUntil: null,
    modelMetadata: { version: 1, contextWindow: 200000, maxOutputTokens: 8192, capabilities: ['coding', 'vision'] },
    updatedAt: new Date(),
    metadataEnvelopeHash: 'hash-123',
    modelProviderQuarantineType: null,
    modelProviderQuarantineUntil: null,
    pricing: {
      id: 'p-1',
      inputPerMillion: 2.5,
      outputPerMillion: 10.0,
      cachedPerMillion: 1.25,
      currency: 'USD',
      effectiveFrom: new Date(),
      effectiveUntil: null,
    },
    ...overrides,
  };
}

const useCaseMetaMismatch = new SaveModelDetailUseCase(
  writePort,
  registry as any,
  new MockQueryPort(cloneWithMeta({
    modelMetadata: { version: 1, contextWindow: 200000, maxOutputTokens: 8192, capabilities: ['coding'] },
  })),
);

async function testModelMetadataMismatch(): Promise<void> {
  registry.published = null;
  const metaResult = await useCaseMetaMismatch.execute(inputWithMeta);
  assert.equal(metaResult.outcome, 'committed-unverified', 'model metadata mismatch must report committed-unverified');
  assert.ok(
    Array.isArray(metaResult.mismatches) && (metaResult.mismatches as string[]).some((m) => /modelMetadata/.test(m)),
    'modelMetadata mismatch must appear in mismatches list',
  );
  assert.equal(registry.published, null);
  console.log('  pass: model metadata mismatch blocks publish');
}

const useCaseProviderMetaMismatch = new SaveModelDetailUseCase(
  writePort,
  registry as any,
  new MockQueryPort(cloneWithMeta({
    providerMetadata: { version: 1, planName: 'Pro', periodicCost: 30, includedUsage: 500, overageRate: 0.02 },
  })),
);

async function testProviderMetadataMismatch(): Promise<void> {
  registry.published = null;
  const providerMetaResult = await useCaseProviderMetaMismatch.execute(inputWithMeta);
  assert.equal(providerMetaResult.outcome, 'committed-unverified', 'provider metadata mismatch must report committed-unverified');
  assert.ok(
    Array.isArray(providerMetaResult.mismatches) && (providerMetaResult.mismatches as string[]).some((m) => /providerMetadata/.test(m)),
    'providerMetadata mismatch must appear in mismatches list',
  );
  assert.equal(registry.published, null);
  console.log('  pass: provider metadata mismatch blocks publish');
}

const useCaseEnvelopeMismatch = new SaveModelDetailUseCase(
  writePort,
  registry as any,
  new MockQueryPort(cloneWithMeta({
    metadataEnvelopeHash: 'different-envelope',
  })),
);

async function testEnvelopeHashMismatch(): Promise<void> {
  registry.published = null;
  const envelopeResult = await useCaseEnvelopeMismatch.execute(inputWithMeta);
  assert.equal(envelopeResult.outcome, 'committed-unverified', 'envelope-hash mismatch must report committed-unverified');
  assert.ok(
    Array.isArray(envelopeResult.mismatches) && (envelopeResult.mismatches as string[]).some((m) => /envelopeHash/.test(m)),
    'envelopeHash mismatch must appear in mismatches list',
  );
  assert.equal(registry.published, null);
  console.log('  pass: envelope-hash mismatch blocks publish');
}

const useCaseStalePricing = new SaveModelDetailUseCase(
  writePort,
  registry as any,
  new MockQueryPort(cloneWithMeta({
    // Input says pricing=null but readback reports a stale active row.
    pricing: {
      id: 'p-1',
      inputPerMillion: 2.5,
      outputPerMillion: 10.0,
      cachedPerMillion: 1.25,
      currency: 'USD',
      effectiveFrom: new Date(),
      effectiveUntil: null,
    },
  })),
);

async function testNullPricingStaleRow(): Promise<void> {
  registry.published = null;
  const inputNullPricing: SaveModelDetailInput = { ...inputWithMeta, pricing: null };
  const staleResult = await useCaseStalePricing.execute(inputNullPricing);
  assert.equal(staleResult.outcome, 'committed-unverified', 'stale active pricing row must report committed-unverified');
  assert.ok(
    Array.isArray(staleResult.mismatches) && (staleResult.mismatches as string[]).some((m) => /pricing: expected null/.test(m)),
    'pricing null mismatch must appear in mismatches list',
  );
  assert.equal(registry.published, null);
  console.log('  pass: stale active pricing row blocks save when input pricing=null');
}

async function run() {
  await testMismatch();
  await testMatch();
  await testModelMetadataMismatch();
  await testProviderMetadataMismatch();
  await testEnvelopeHashMismatch();
  await testNullPricingStaleRow();
  console.log('All Task 4 verification assertions passed!');
}

run();
