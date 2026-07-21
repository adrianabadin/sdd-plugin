import assert from 'node:assert/strict';
import {
  getOrCreateModelConfigRegistry,
  ModelConfigRegistry,
  EffectiveModelConfig,
} from '../src/infrastructure/runtime/model-config-registry.js';

console.log('--- Model Config Registry Test ---');

const registry = getOrCreateModelConfigRegistry();
assert.equal(typeof registry.revision, 'number');

const config: EffectiveModelConfig = {
  providerId: 'openai',
  modelId: 'gpt-4o',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  capabilities: ['coding', 'reasoning'],
  inputPerMillion: 2.5,
  outputPerMillion: 10,
  cachedPerMillion: 1.25,
  currency: 'USD',
  isBlocked: false,
  subscription: 'pro',
  metadataEnvelopeHash: 'test-hash-1234',
};

let notified = false;
const unsubscribe = registry.subscribe((item) => {
  if (item.providerId === 'openai' && item.modelId === 'gpt-4o') {
    notified = true;
  }
});

const prevRev = registry.revision;
registry.publish(config);

assert.ok(registry.revision > prevRev);
assert.deepEqual(registry.get('openai', 'gpt-4o'), config);
assert.ok(notified);

unsubscribe();
console.log('  pass: publish, get, subscribe, and revision tracking');
