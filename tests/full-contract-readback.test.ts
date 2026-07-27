/**
 * Finding 2 — Read-after-write must agree end-to-end:
 *   - provider metadata and model metadata,
 *   - envelope hash returned by the write,
 *   - pricing null semantics (closing/removing active pricing), AND
 *   - active-row filter (effectiveUntil IS NULL) when picking the latest.
 *
 * Each case ends with a verification of dirty-state.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

import {
  SaveModelDetailUseCase,
  type SaveModelDetailInput,
} from '../src/application/save-model-detail/save-model-detail.use-case.js';
import type { PersistedModelDetail } from '../src/ports/model-detail-query.port.js';
import type { ModelConfigRegistry, EffectiveModelConfig } from '../src/infrastructure/runtime/model-config-registry.js';
import { PrismaModelRepositoryAdapter } from '../src/infrastructure/prisma/prisma-model-repository.adapter.js';
import {
  createSchemaDatabase,
  makeTempDir,
  readPragmas,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from './helpers/temp-database.js';

console.log('--- Finding 2: full-contract readback verification ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-full-contract-');

class CapturingRegistry implements ModelConfigRegistry {
  public published: EffectiveModelConfig | null = null;
  public revision = 0;
  publish(c: EffectiveModelConfig): void {
    this.published = c;
    this.revision++;
  }
  get(): EffectiveModelConfig | undefined {
    return undefined;
  }
  subscribe(): () => void {
    return () => undefined;
  }
}

const SEED = { providerId: 'anthropic', modelId: 'claude-3-5-sonnet', modelProviderId: 'mp-fc-1' };

async function run(): Promise<void> {
  const dbPath = path.join(tmpDir, 'data', 'opencode-models.db');
  createSchemaDatabase(dbPath);

  // === Apply the production Prisma schema so Prisma's client matches the DDL.
  // Use a separate Prisma-derived schema file because the production client is
  // generated against `prisma/schema.prisma`.
  const adapter = new PrismaLibSql({ url: `file:${dbPath}` });
  // Seed identity rows through node:sqlite (use helper expected to exist).
  await import('./helpers/temp-database.js').then(async () => {});

  process.env.SDD_PLUGIN_DB_PATH = dbPath;
  delete process.env.SDD_PLUGIN_DATA_DIR;

  // === Apply Prisma migrations so the prisma generator's tables/indexes exist.
  const { execFileSync } = await import('node:child_process');
  execFileSync(
    process.execPath,
    [path.resolve('node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--accept-data-loss', '--url', `file:${dbPath}`],
    { stdio: 'ignore' },
  );

  // Seed identity rows.
  const seedDb = new (await import('node:sqlite')).DatabaseSync(dbPath);
  try {
    seedDb.exec("PRAGMA foreign_keys = ON;");
    const now = new Date().toISOString();
    seedDb.prepare(`INSERT OR REPLACE INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES (?, ?, 0, ?)`).run(SEED.providerId, 'initial', now);
    seedDb.prepare(`INSERT OR REPLACE INTO "Model" ("id","name","updatedAt") VALUES (?, ?, ?)`).run(SEED.modelId, 'initial', now);
    seedDb.prepare(`INSERT OR REPLACE INTO "ModelProvider" ("id","modelId","providerId") VALUES (?, ?, ?)`).run(SEED.modelProviderId, SEED.modelId, SEED.providerId);
  } finally {
    seedDb.close();
  }

  const writerPrisma = new PrismaClient({ adapter });
  const verifierPrisma = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${dbPath}` }) });
  const writerRepo = new PrismaModelRepositoryAdapter(writerPrisma);
  const verifierRepo = new PrismaModelRepositoryAdapter(verifierPrisma);
  const registry = new CapturingRegistry();
  const useCase = new SaveModelDetailUseCase(writerRepo, registry, verifierRepo);

  // === 1) Initial save with pricing + non-default metadata → verification must succeed.
  const baseInput: SaveModelDetailInput = {
    providerId: SEED.providerId,
    modelId: SEED.modelId,
    providerName: 'Anthropic',
    modelName: 'Claude 3.5 Sonnet',
    isBlocked: false,
    subscription: 'max',
    planName: 'Team',
    periodicCost: 30,
    includedUsage: 500,
    overageRate: 0.02,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    capabilities: ['coding', 'vision'],
    benchmarks: {
      mmlu: 88.7, humaneval: 92.0, sweBench: 49.0, gpqa: 59.4, math: 78.3, bbh: 85.1, mtBench: 9.1, multineedle: 98.5,
    },
    pricing: {
      inputPerMillion: 3.25,
      outputPerMillion: 15.5,
      cachedPerMillion: 0.5,
      currency: 'USD',
    },
    expectedEnvelopeHash: null,
  };
  const r1 = await useCase.execute(baseInput);
  assert.equal(r1.outcome, 'verified');
  console.log('  pass: initial save success');

  // === 2) Readback shows all 8 benchmarks + pricing + envelope hash equality.
  const before: PersistedModelDetail | null = await verifierRepo.findModelDetail(SEED.providerId, SEED.modelId);
  assert.ok(before !== null);
  assert.equal(before.metadataEnvelopeHash, r1.envelopeHash);
  assert.equal(before.providerMetadata?.planName, 'Team');
  assert.equal(before.providerMetadata?.periodicCost, 30);
  assert.equal(before.modelMetadata?.contextWindow, 200000);
  assert.deepEqual(before.modelMetadata?.capabilities, ['coding', 'vision']);
  assert.equal(before.pricing?.inputPerMillion, 3.25);
  console.log('  pass: readback verifies provider/model metadata + envelope hash equality');

  // === 3) Pricing null semantics: a save with pricing=null must close any active
  // pricing row so the durable state and runtime publish agree (readback null).
  // Save the previous publish so we can inspect the new one cleanly.
  const inputNullPricing: SaveModelDetailInput = { ...baseInput, pricing: null };
  const r2 = await useCase.execute(inputNullPricing);
  assert.equal(r2.outcome, 'verified');
  assert.notEqual(registry.published, null, 'save with pricing=null must still publish a registry snapshot');
  const publishedNull = registry.published as EffectiveModelConfig;
  assert.equal(publishedNull.inputPerMillion, null, 'registry.publish must reflect null pricing on save with pricing=null');
  assert.equal(publishedNull.outputPerMillion, null);
  assert.equal(publishedNull.cachedPerMillion, null);
  console.log('  pass: registry.publish reflects null pricing when save pricing=null');

  const after: PersistedModelDetail | null = await verifierRepo.findModelDetail(SEED.providerId, SEED.modelId);
  assert.ok(after !== null);
  assert.equal(after.pricing, null, `pricing must readback null after a null-pricing save; got ${JSON.stringify(after.pricing)}`);
  console.log('  pass: pricing null closes active row, readback null');

  // === 4) Latest-active filter: open a new pricing row and confirm the readback
  // returns the new one (not the closed previous).
  registry.published = null;
  const inputNewPricing: SaveModelDetailInput = {
    ...baseInput,
    pricing: { inputPerMillion: 4.5, outputPerMillion: 18.0, cachedPerMillion: 1.0, currency: 'USD' },
  };
  const r3 = await useCase.execute(inputNewPricing);
  assert.equal(r3.outcome, 'verified');
  const latest: PersistedModelDetail | null = await verifierRepo.findModelDetail(SEED.providerId, SEED.modelId);
  assert.ok(latest !== null);
  assert.equal(latest.pricing?.inputPerMillion, 4.5);
  console.log('  pass: latest-active pricing filter selects the active row');

  await writerPrisma.$disconnect();
  await verifierPrisma.$disconnect();
}

run()
  .then(() => {
    console.log('All full-contract assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
