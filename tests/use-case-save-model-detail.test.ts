import assert from 'node:assert/strict';
import { SaveModelDetailUseCase, SaveModelDetailInput } from '../src/application/save-model-detail/save-model-detail.use-case.js';
import { ModelDetailWritePort, SaveModelDetailCommand } from '../src/ports/model-detail-write.port.js';
import { ModelConfigRegistry, EffectiveModelConfig } from '../src/infrastructure/runtime/model-config-registry.js';
import { computeEnvelopeHash } from '../src/domain/model-detail/metadata.js';

console.log('--- SaveModelDetailUseCase Test ---');

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

async function runTests() {
  // Test 1: Valid save -> DB commit -> Registry publish
  const adapter = new MockWriteAdapter();
  const registry = new MockRegistry();
  const useCase = new SaveModelDetailUseCase(adapter, registry);

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
    benchmarks: { mmlu: 88, humaneval: 90, sweBench: 45 },
    pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cachedPerMillion: 1.25, currency: 'USD' },
    expectedEnvelopeHash: null,
  };

  const result = await useCase.execute(input);
  assert.ok(result.success);
  assert.ok(adapter.savedCommand !== null);
  assert.ok(registry.published !== null);
  assert.equal(registry.published?.providerId, 'openai');
  console.log('  pass: valid save publishes to registry');

  // Test 2: DB Failure -> error thrown, no registry publish
  adapter.shouldFail = true;
  registry.published = null;
  try {
    await useCase.execute(input);
    assert.fail('Should have thrown on DB failure');
  } catch (e: any) {
    assert.equal(e.message, 'Database write error');
    assert.equal(registry.published, null);
    console.log('  pass: DB failure prevents registry publish');
  }

  // Test 3: Registry Publish Failure -> DB commit kept, returns warning status
  adapter.shouldFail = false;
  registry.shouldFail = true;
  const resultWarn = await useCase.execute(input);
  assert.ok(resultWarn.success);
  assert.ok(resultWarn.warning !== undefined);
  console.log('  pass: publish failure keeps DB commit and returns warning');
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
