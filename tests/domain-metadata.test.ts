import assert from 'node:assert/strict';
import {
  parseProviderMetadata,
  serializeProviderMetadata,
  parseModelMetadata,
  serializeModelMetadata,
  computeEnvelopeHash,
  METADATA_VERSION,
  ProviderMetadata,
  ModelMetadata
} from '../src/domain/model-detail/metadata.js';

console.log('--- Metadata Envelope Domain Test ---');

const raw = JSON.stringify({
  version: 1,
  planName: 'pro',
  periodicCost: 20,
  includedUsage: 100,
  overageRate: 0.05
});
const parsed = parseProviderMetadata(raw);
assert.deepEqual(parsed, {
  version: 1,
  planName: 'pro',
  periodicCost: 20,
  includedUsage: 100,
  overageRate: 0.05
});
const hash = computeEnvelopeHash(parsed);
assert.equal(typeof hash, 'string');
assert.ok(hash.length > 0);
console.log('  pass: parseProviderMetadata & computeEnvelopeHash');

const corrupt = parseProviderMetadata('invalid json {');
assert.deepEqual(corrupt, {
  version: METADATA_VERSION,
  planName: null,
  periodicCost: null,
  includedUsage: null,
  overageRate: null
});
console.log('  pass: corrupt json fallback');

const modelMeta: ModelMetadata = {
  version: 1,
  contextWindow: 128000,
  maxOutputTokens: 4096,
  capabilities: ['coding', 'reasoning']
};
const serialized = serializeModelMetadata(modelMeta);
const parsedBack = parseModelMetadata(serialized);
assert.deepEqual(parsedBack, modelMeta);
console.log('  pass: model metadata serialization & parse');

