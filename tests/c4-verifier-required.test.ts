import assert from 'node:assert/strict';
import { SaveModelDetailUseCase, type SaveModelDetailInput } from '../src/application/save-model-detail/save-model-detail.use-case.js';
import type { ModelDetailQueryPort } from '../src/ports/model-detail-query.port.js';
import type { ModelDetailWritePort, SaveModelDetailCommand } from '../src/ports/model-detail-write.port.js';

console.log('--- Task C4: Required Verifier RED Test ---');

class MockWritePort implements ModelDetailWritePort {
  async saveModelDetail(cmd: SaveModelDetailCommand): Promise<{ updatedAt: Date; envelopeHash: string }> {
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

const validBenchmarks = {
  mmlu: 88.5,
  humaneval: 90.2,
  sweBench: 48.6,
  gpqa: 53.4,
  math: 76.8,
  bbh: 83.1,
  mtBench: 8.9,
  multineedle: 99.1,
};

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
  benchmarks: validBenchmarks,
  pricing: {
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
    cachedPerMillion: 1.25,
    currency: 'USD',
  },
  expectedEnvelopeHash: null,
};

// Case C4a: Throwing verifier query must fail Save and NOT publish to registry
class ThrowingQueryPort implements ModelDetailQueryPort {
  async findModelDetail(): Promise<any> {
    throw new Error('Database connection lost during verifier readback');
  }
}

const throwingVerifier = new ThrowingQueryPort();
const useCaseThrowing = new SaveModelDetailUseCase(writePort, registry as any, throwingVerifier);

async function testThrowingVerifier() {
  registry.published = null;
  await assert.rejects(async () => {
    await useCaseThrowing.execute(input);
  }, (err: any) => err && err.message.includes('Database connection lost'));
  assert.equal(registry.published, null, 'Registry must NOT be published when verifier query throws');
  console.log('  pass: Thrown verifier query fails Save and prevents registry publication');
}

// Case C4b: Missing required-key benchmark in input must throw runtime validation error
const missingBenchmarkInput: any = {
  ...input,
  benchmarks: {
    mmlu: 88.5,
    humaneval: 90.2,
    sweBench: 48.6,
    // gpqa, math, bbh, mtBench, multineedle missing!
  },
};

const queryPortMatch = {
  async findModelDetail() {
    return {
      providerId: 'openai',
      providerName: 'OpenAI',
      providerSubscription: null,
      providerIsBlocked: false,
      providerQuarantineType: null,
      providerQuarantineUntil: null,
      providerMetadata: { version: 1, planName: null, periodicCost: null, includedUsage: null, overageRate: null },
      modelId: 'gpt-4o',
      modelName: 'GPT-4o',
      benchmarks: validBenchmarks,
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
    };
  },
};

const useCaseStrictKeys = new SaveModelDetailUseCase(writePort, registry as any, queryPortMatch as any);

async function testStrictKeys() {
  registry.published = null;
  await assert.rejects(async () => {
    await useCaseStrictKeys.execute(missingBenchmarkInput);
  }, (err: any) => err && err.message.includes('Validation failed'));
  assert.equal(registry.published, null, 'Registry must NOT be published when input has missing benchmark keys');
  console.log('  pass: Missing benchmark key in input rejects execution');
}

async function run() {
  await testThrowingVerifier();
  await testStrictKeys();
  console.log('Task C4 RED assertions complete.');
}

run();
