import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { createRequire } from 'node:module';

import { PrismaModelRepositoryAdapter } from '../src/infrastructure/prisma/prisma-model-repository.adapter.js';
import { SaveModelDetailCommand } from '../src/ports/model-detail-write.port.js';
import { computeEnvelopeHash } from '../src/domain/model-detail/metadata.js';
import {
  createPrismaSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from './helpers/temp-database.js';
const require = createRequire(import.meta.url);

console.log('--- Finding 6: prisma-write-adapter (full-temp DB, no workspace fixture) ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-prisma-write-adapter-');

async function run(): Promise<void> {
  const dbPath = path.join(tmpDir, 'data', 'opencode-models.db');
  createPrismaSchemaDatabase(dbPath);
  process.env.SDD_PLUGIN_DB_PATH = dbPath;
  delete process.env.SDD_PLUGIN_DATA_DIR;

  const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter: prismaAdapter });

  try {
    const adapter = new PrismaModelRepositoryAdapter(prisma);

    // Seed identity rows.
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
    await prisma.modelProvider.upsert({
      where: { modelId_providerId: { modelId: 'claude-3-5-sonnet', providerId: 'anthropic' } },
      update: {},
      create: { modelId: 'claude-3-5-sonnet', providerId: 'anthropic' },
    });

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
        benchmarks: { mmlu: 88.7, humaneval: 92.0, sweBench: 49.0, gpqa: 59.4, math: 78.3, bbh: 85.1, mtBench: 9.1, multineedle: 98.5 },
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
    console.log('  pass: saveModelDetail transaction executed on a real temp DB');

    // Re-hydrate through the Prisma adapter directly (no verifier port).
    const detail = await adapter.findModelDetail('anthropic', 'claude-3-5-sonnet');
    assert.ok(detail !== null);
    assert.equal(detail.providerName, 'Anthropic Official');
    assert.equal(detail.modelName, 'Claude 3.5 Sonnet v2');
    assert.equal(detail.providerMetadata?.planName, 'Team');
    assert.equal(detail.modelMetadata?.contextWindow, 200000);
    assert.equal(detail.benchmarks.mmlu, 88.7);
    assert.equal(detail.benchmarks.gpqa, 59.4);
    assert.equal(detail.benchmarks.multineedle, 98.5);
    assert.equal(detail.pricing?.inputPerMillion, 3.0);
    assert.equal(detail.metadataEnvelopeHash, saveRes.envelopeHash);
    console.log('  pass: findModelDetail rehydrated metadata + benchmark history');

    // Stale envelope hash conflict rejected.
    const staleCmd: SaveModelDetailCommand = { ...cmd, expectedEnvelopeHash: 'stale-hash-1234' };
    await assert.rejects(
      () => adapter.saveModelDetail(staleCmd),
      (e: Error) => e.message.includes('Conflict'),
    );
    console.log('  pass: stale envelope hash conflict rejected');

    // Sanity: computeEnvelopeHash matches the returned hash.
    const want = computeEnvelopeHash(cmd.provider.metadata, cmd.model.metadata);
    assert.equal(saveRes.envelopeHash, want);
    console.log('  pass: returned envelope hash matches computeEnvelopeHash(input)');
  } finally {
    await prisma.$disconnect();
  }
}

run()
  .then(() => {
    console.log('All Finding 6 prisma-write-adapter assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });

void require;
void fs;
