import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { createRequire } from 'node:module';

import { PrismaModelRepositoryAdapter } from '../src/infrastructure/prisma/prisma-model-repository.adapter.js';
import { SaveModelDetailUseCase, type SaveModelDetailInput } from '../src/application/save-model-detail/save-model-detail.use-case.js';
import { createPrismaSchemaDatabase, makeTempDir, removeTempDir, restoreEnv, snapshotEnv } from './helpers/temp-database.js';
const require = createRequire(import.meta.url);

console.log('--- Finding 6: all-8 benchmarks via fresh temp DB (no workspace fixture) ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-all-bench-');

async function run(): Promise<void> {
  const dbPath = path.join(tmpDir, 'data', 'opencode-models.db');
  process.env.SDD_PLUGIN_DB_PATH = dbPath;
  delete process.env.SDD_PLUGIN_DATA_DIR;

  createPrismaSchemaDatabase(dbPath);

  // Seed identity rows before Save runs.
  const seedDb = new (require('node:sqlite')).DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();
    seedDb.prepare(
      `INSERT OR REPLACE INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES (?, ?, 0, ?)`,
    ).run('openai', 'OpenAI', now);
    seedDb.prepare(
      `INSERT OR REPLACE INTO "Model" ("id","name","updatedAt") VALUES (?, ?, ?)`,
    ).run('gpt-4o', 'GPT-4o', now);
    seedDb.prepare(
      `INSERT OR REPLACE INTO "ModelProvider" ("id","modelId","providerId") VALUES (?, ?, ?)`,
    ).run('mp-openai-gpt4o', 'gpt-4o', 'openai');
  } finally {
    seedDb.close();
  }

  const writerAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
  const writerPrisma = new PrismaClient({ adapter: writerAdapter });
  const verifierAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
  const verifierPrisma = new PrismaClient({ adapter: verifierAdapter });

  const repositoryAdapter = new PrismaModelRepositoryAdapter(writerPrisma);
  const verifierRepositoryAdapter = new PrismaModelRepositoryAdapter(verifierPrisma);

  class MockRegistry {
    public published: any = null;
    publish(config: any) { this.published = config; }
  }
  const registry = new MockRegistry();
  const useCase = new SaveModelDetailUseCase(repositoryAdapter, registry as never, verifierRepositoryAdapter);

  const input: SaveModelDetailInput = {
    providerId: 'openai',
    modelId: 'gpt-4o',
    providerName: 'OpenAI',
    modelName: 'GPT-4o',
    isBlocked: false,
    subscription: 'pro',
    planName: null,
    periodicCost: null,
    includedUsage: null,
    overageRate: null,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: ['vision', 'tools'],
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

  const result = await useCase.execute(input);
  assert.equal(result.outcome, 'verified');
  assert.ok(registry.published !== null);

  await writerPrisma.$disconnect();
  await verifierPrisma.$disconnect();

  // Fresh client
  const freshAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
  const freshPrisma = new PrismaClient({ adapter: freshAdapter });
  const m = await freshPrisma.model.findUnique({ where: { id: 'gpt-4o' } });
  assert.notEqual(m, null);
  assert.equal(m?.mmlu, 88.5);
  assert.equal(m?.humaneval, 90.2);
  assert.equal(m?.sweBench, 48.6);
  assert.equal(m?.gpqa, 53.4);
  assert.equal(m?.math, 76.8);
  assert.equal(m?.bbh, 83.1);
  assert.equal(m?.mtBench, 8.9);
  assert.equal(m?.multineedle, 99.1);
  await freshPrisma.$disconnect();

  console.log('  pass: all 8 benchmark fields persisted via fresh-client readback on a freshly-built temp DB');
}

run()
  .then(() => {
    console.log('All Finding 6 assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });

void execFileSync;
void fs;
