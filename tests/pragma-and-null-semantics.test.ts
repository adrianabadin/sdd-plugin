import assert from 'node:assert/strict';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

import {
  configurePragmas,
  initializeDatabase,
} from '../src/infrastructure/runtime/database-path.js';
import { createPersistenceContext } from '../src/infrastructure/runtime/persistence-context.js';
import {
  createPrismaSchemaDatabase,
  makeTempDir,
  readPragmas,
  removeTempDir,
  restoreEnv,
  seedIdentity,
  snapshotEnv,
} from './helpers/temp-database.js';

/**
 * Durability + integrity contract.
 *
 * This test never sets PRAGMAs itself: it calls the production initializer and
 * then observes the effective values, so it fails if production stops
 * configuring them.
 */
console.log('--- PRAGMA contract via production initializeDatabase + null semantics ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-pragma-');

const SEED = {
  providerId: 'openai',
  modelId: 'gpt-4o',
  modelProviderId: 'mp-pragma-1',
};

async function run(): Promise<void> {
  const legacyDb = path.join(tmpDir, 'legacy', 'opencode-models.db');
  const destDb = path.join(tmpDir, 'data', 'opencode-models.db');

  createPrismaSchemaDatabase(legacyDb);
  seedIdentity(legacyDb, SEED);

  process.env.SDD_PLUGIN_DB_PATH = destDb;
  delete process.env.SDD_PLUGIN_DATA_DIR;
  delete process.env.SDD_PLUGIN_LEGACY_DB_PATH;

  // === Production initialization performs the PRAGMA configuration ===
  const initialized = initializeDatabase({ projectDbPath: legacyDb });
  assert.equal(initialized, destDb);

  // journal_mode is persisted in the database file: a durable guarantee that
  // survives the initializing connection closing.
  const persisted = readPragmas(destDb);
  assert.equal(
    persisted.journalMode,
    'wal',
    `journal_mode must be persisted as wal (got ${persisted.journalMode})`,
  );
  console.log(`  pass: persisted journal_mode=${persisted.journalMode} after production initialization`);

  // synchronous and foreign_keys are per-connection settings. Production
  // verifies its effective values and throws when they are not honoured.
  const effective = configurePragmas(destDb);
  assert.equal(effective.journalMode, 'wal', 'effective journal_mode must be wal');
  assert.equal(effective.synchronous, 2, `effective synchronous must be 2/FULL (got ${effective.synchronous})`);
  assert.equal(effective.foreignKeys, 1, `effective foreign_keys must be 1 (got ${effective.foreignKeys})`);
  console.log(
    `  pass: production-verified effective PRAGMAs journal_mode=${effective.journalMode} synchronous=${effective.synchronous} foreign_keys=${effective.foreignKeys}`,
  );

  // === Referential integrity through the actual runtime driver ===
  const fkAdapter = new PrismaLibSql({ url: `file:${destDb}` });
  const fkPrisma = new PrismaClient({ adapter: fkAdapter });
  let orphanRejected = false;
  try {
    await fkPrisma.modelProvider.create({
      data: { modelId: 'ghost-model-does-not-exist', providerId: 'ghost-provider-does-not-exist' },
    });
  } catch {
    orphanRejected = true;
  }
  const orphanRows = await fkPrisma.modelProvider.findMany({
    where: { modelId: 'ghost-model-does-not-exist' },
  });
  await fkPrisma.$disconnect();

  assert.equal(orphanRejected, true, 'runtime driver must reject an orphan foreign key insert');
  assert.equal(orphanRows.length, 0, 'no orphan row may be persisted');
  console.log('  pass: orphan insert rejected by the runtime driver (foreign keys enforced)');

  // === All-8 null semantics written by the production Save use case ===
  const context = await createPersistenceContext();
  const saveResult = await context.saveDetailUseCase.execute({
    providerId: SEED.providerId,
    modelId: SEED.modelId,
    providerName: 'OpenAI',
    modelName: 'GPT-4o',
    isBlocked: false,
    subscription: null,
    planName: null,
    periodicCost: null,
    includedUsage: null,
    overageRate: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: [],
    benchmarks: {
      mmlu: 75,
      humaneval: null,
      sweBench: null,
      gpqa: null,
      math: null,
      bbh: null,
      mtBench: null,
      multineedle: null,
    },
    pricing: {
      inputPerMillion: 1.5,
      outputPerMillion: null,
      cachedPerMillion: null,
      currency: 'USD',
    },
    expectedEnvelopeHash: null,
  });
  assert.equal(saveResult.outcome, 'verified', 'production Save must report verified');

  await context.dispose();

  // Fresh client after the writer/verifier are disconnected.
  const freshAdapter = new PrismaLibSql({ url: `file:${destDb}` });
  const fresh = new PrismaClient({ adapter: freshAdapter });

  const model = await fresh.model.findUnique({ where: { id: SEED.modelId } });
  assert.equal(model?.mmlu, 75, 'mmlu persisted');
  assert.equal(model?.humaneval, null, 'humaneval null preserved');
  assert.equal(model?.sweBench, null, 'sweBench null preserved');
  assert.equal(model?.gpqa, null, 'gpqa null preserved');
  assert.equal(model?.math, null, 'math null preserved');
  assert.equal(model?.bbh, null, 'bbh null preserved');
  assert.equal(model?.mtBench, null, 'mtBench null preserved');
  assert.equal(model?.multineedle, null, 'multineedle null preserved');
  console.log('  pass: all 8 benchmark null semantics preserved via fresh client');

  const link = await fresh.modelProvider.findUnique({
    where: { modelId_providerId: { modelId: SEED.modelId, providerId: SEED.providerId } },
    include: { pricing: { orderBy: { effectiveFrom: 'desc' }, take: 1 } },
  });
  const pricing = link?.pricing?.[0];
  assert.ok(pricing, 'pricing row must exist');
  assert.equal(pricing?.inputPerMillion, 1.5, 'pricing input persisted');
  assert.equal(pricing?.outputPerMillion, null, 'pricing output null preserved');
  assert.equal(pricing?.cachedPerMillion, null, 'pricing cached null preserved');
  assert.equal(pricing?.currency, 'USD', 'pricing currency persisted');
  console.log('  pass: Pricing null semantics preserved via fresh client');

  await fresh.$disconnect();
}

run()
  .then(() => {
    console.log('All PRAGMA + null-semantics assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
