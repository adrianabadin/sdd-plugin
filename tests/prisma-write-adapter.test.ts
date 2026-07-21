import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { execSync } from 'node:child_process';
import { PrismaModelRepositoryAdapter } from '../src/infrastructure/prisma/prisma-model-repository.adapter.js';
import { SaveModelDetailCommand } from '../src/ports/model-detail-write.port.js';
import { computeEnvelopeHash } from '../src/domain/model-detail/metadata.js';
import path from 'node:path';

console.log('--- Prisma Model Repository Task 5 Integration Test ---');

const dbPath = path.resolve('opencode-models.test.db');
process.env.DATABASE_URL = `file:${dbPath}`;
execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' });

const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter: prismaAdapter });

async function runTests() {
  const adapter = new PrismaModelRepositoryAdapter(prisma);

  // Setup seed provider, model, modelProvider
  await prisma.provider.upsert({
    where: { id: 'anthropic' },
    update: {},
    create: { id: 'anthropic', name: 'Anthropic' },
  });
  await prisma.model.upsert({
    where: { id: 'claude-3-5-sonnet' },
    update: {},
    create: { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
  });
  const mp = await prisma.modelProvider.upsert({
    where: { modelId_providerId: { modelId: 'claude-3-5-sonnet', providerId: 'anthropic' } },
    update: {},
    create: { modelId: 'claude-3-5-sonnet', providerId: 'anthropic' },
  });

  // Test 1: Save Model Detail Transaction & Envelope Hash
  const cmd: SaveModelDetailCommand = {
    providerId: 'anthropic',
    modelId: 'claude-3-5-sonnet',
    provider: {
      name: 'Anthropic Official',
      isBlocked: false,
      subscription: 'max',
      metadata: { version: 1, planName: 'Team', periodicCost: 30, includedUsage: 500, overageRate: 0.02 },
    },
    model: {
      name: 'Claude 3.5 Sonnet v2',
      benchmarks: { mmlu: 88.7, humaneval: 92.0, sweBench: 49.0 },
      metadata: { version: 1, contextWindow: 200000, maxOutputTokens: 8192, capabilities: ['coding', 'vision'] },
    },
    pricing: {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cachedPerMillion: 0.75,
      currency: 'USD',
    },
    expectedEnvelopeHash: null,
  };

  const saveRes = await adapter.saveModelDetail(cmd);
  assert.ok(saveRes.envelopeHash.length > 0);
  console.log('  pass: saveModelDetail transaction executed');

  // Test 2: findModelDetail includes metadata & pricing history
  const detail = await adapter.findModelDetail('anthropic', 'claude-3-5-sonnet');
  assert.ok(detail !== null);
  assert.equal(detail.providerName, 'Anthropic Official');
  assert.equal(detail.modelName, 'Claude 3.5 Sonnet v2');
  assert.equal(detail.providerMetadata?.planName, 'Team');
  assert.equal(detail.modelMetadata?.contextWindow, 200000);
  assert.equal(detail.pricing?.inputPerMillion, 3.0);
  assert.equal(detail.metadataEnvelopeHash, saveRes.envelopeHash);
  console.log('  pass: findModelDetail rehydrated metadata & pricing history');

  // Test 3: Stale hash conflict rejection
  const staleCmd: SaveModelDetailCommand = {
    ...cmd,
    expectedEnvelopeHash: 'stale-hash-1234',
  };
  try {
    await adapter.saveModelDetail(staleCmd);
    assert.fail('Should have rejected stale hash');
  } catch (e: any) {
    assert.ok(e.message.includes('Conflict'));
    console.log('  pass: stale envelope hash conflict rejected');
  }

  await prisma.$disconnect();
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
