import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

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
 * Built-artifact Save proof.
 *
 * The saved values are written by the PRODUCTION `SaveModelDetailUseCase`
 * reached through the built bundle's composition seam — never by raw test
 * writes. Seed rows below only satisfy Save's identity precondition and use
 * deliberately different values from the Save payload, so the final assertions
 * can only pass if the production Save actually ran.
 */
console.log('--- Built dist/tui.js Save -> verified persistence ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-built-save-');

/** Identity precondition values (NOT the values under assertion). */
const SEED = {
  providerId: 'anthropic',
  modelId: 'claude-3-5-sonnet',
  modelProviderId: 'mp-seed-1',
};

/** Values that must be produced by the production Save path. */
const SAVE_VALUES = {
  providerName: 'Anthropic (saved-by-use-case)',
  modelName: 'Claude 3.5 Sonnet (saved-by-use-case)',
  benchmarks: {
    mmlu: 88.7,
    humaneval: 92.0,
    sweBench: 49.0,
    gpqa: 59.4,
    math: 78.3,
    bbh: 85.1,
    mtBench: 9.1,
    multineedle: null as number | null,
  },
  pricing: {
    inputPerMillion: 3.25,
    outputPerMillion: 15.5,
    cachedPerMillion: null as number | null,
    currency: 'USD',
  },
};

async function run(): Promise<void> {
  const dataDir = path.join(tmpDir, 'user-data');
  const legacyDb = path.join(tmpDir, 'legacy', 'opencode-models.db');
  const destDb = path.join(dataDir, 'opencode-models.db');

  // A real legacy database, entirely inside the temp tree.
  createPrismaSchemaDatabase(legacyDb);
  seedIdentity(legacyDb, SEED);

  // Point the built bundle exclusively at temp locations.
  process.env.SDD_PLUGIN_DATA_DIR = dataDir;
  process.env.SDD_PLUGIN_LEGACY_DB_PATH = legacyDb;
  delete process.env.SDD_PLUGIN_DB_PATH;

  const distTui = path.join(process.cwd(), 'dist', 'tui.js');
  assert.ok(fs.existsSync(distTui), 'dist/tui.js must exist (run npm run build first)');

  const builtModule = await import(`${pathToFileURL(distTui).href}?built-save=${Date.now()}`);
  assert.equal(
    typeof builtModule.createPersistenceContext,
    'function',
    'built bundle must expose the production persistence composition seam',
  );
  console.log('  trace: built dist/tui.js loaded; production composition seam resolved');

  // Production wiring: initializeDatabase + writer client + INDEPENDENT
  // verifier client + repository adapters + SaveModelDetailUseCase.
  const context = await builtModule.createPersistenceContext();
  assert.equal(context.databasePath, destDb, 'built bundle must initialize the temp user-data database');
  assert.ok(fs.existsSync(destDb), 'first run must migrate the legacy database into the temp destination');
  console.log(`  trace: first-run migration -> ${path.basename(destDb)} (from temp legacy source)`);

  // Control: the fields under assertion are empty before Save runs.
  const preAdapter = new PrismaLibSql({ url: `file:${destDb}` });
  const prePrisma = new PrismaClient({ adapter: preAdapter });
  const before = await prePrisma.model.findUnique({ where: { id: SEED.modelId } });
  await prePrisma.$disconnect();
  assert.ok(before !== null, 'seeded model identity must exist before Save');
  assert.equal(before?.mmlu, null, 'control: mmlu must be empty before the production Save');
  assert.equal(before?.gpqa, null, 'control: gpqa must be empty before the production Save');
  assert.notEqual(before?.name, SAVE_VALUES.modelName, 'control: seed name differs from Save payload');
  console.log('  trace: pre-Save control confirmed (benchmarks null, seed name differs)');

  // === The production Save. No raw writes for asserted values. ===
  const saveResult = await context.saveDetailUseCase.execute({
    providerId: SEED.providerId,
    modelId: SEED.modelId,
    providerName: SAVE_VALUES.providerName,
    modelName: SAVE_VALUES.modelName,
    isBlocked: false,
    subscription: 'max',
    planName: 'Team',
    periodicCost: 30,
    includedUsage: 500,
    overageRate: 0.02,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    capabilities: ['coding', 'vision'],
    benchmarks: { ...SAVE_VALUES.benchmarks },
    pricing: { ...SAVE_VALUES.pricing },
    expectedEnvelopeHash: null,
  });

  assert.equal(saveResult.outcome, 'verified', 'production Save must report verified');
  assert.ok(
    typeof saveResult.envelopeHash === 'string' && saveResult.envelopeHash.length > 0,
    'production Save must return an envelope hash',
  );
  console.log(
    `  trace: SaveModelDetailUseCase.execute -> transaction committed -> independent verifier readback OK (envelopeHash=${String(saveResult.envelopeHash).slice(0, 12)}...)`,
  );

  // Release writer + verifier before the fresh-client readback.
  await context.dispose();
  assert.equal(context.isDisposed(), true, 'context must report disposed');
  console.log('  trace: writer + verifier disconnected');

  // === Fresh client, brand-new connection ===
  const freshAdapter = new PrismaLibSql({ url: `file:${destDb}` });
  const fresh = new PrismaClient({ adapter: freshAdapter });

  const model = await fresh.model.findUnique({ where: { id: SEED.modelId } });
  assert.ok(model !== null, 'model row must exist after Save');
  assert.equal(model?.name, SAVE_VALUES.modelName, 'model name must come from the production Save');

  const expected = SAVE_VALUES.benchmarks;
  assert.equal(model?.mmlu, expected.mmlu, 'mmlu persisted by production Save');
  assert.equal(model?.humaneval, expected.humaneval, 'humaneval persisted by production Save');
  assert.equal(model?.sweBench, expected.sweBench, 'sweBench persisted by production Save');
  assert.equal(model?.gpqa, expected.gpqa, 'gpqa persisted by production Save');
  assert.equal(model?.math, expected.math, 'math persisted by production Save');
  assert.equal(model?.bbh, expected.bbh, 'bbh persisted by production Save');
  assert.equal(model?.mtBench, expected.mtBench, 'mtBench persisted by production Save');
  assert.equal(model?.multineedle, null, 'multineedle null semantics preserved by production Save');
  console.log('  pass: all 8 benchmark fields (incl. explicit null) verified via fresh client');

  const provider = await fresh.provider.findUnique({ where: { id: SEED.providerId } });
  assert.equal(provider?.name, SAVE_VALUES.providerName, 'provider name must come from the production Save');
  assert.equal(provider?.subscription, 'max', 'provider subscription persisted by production Save');

  const link = await fresh.modelProvider.findUnique({
    where: { modelId_providerId: { modelId: SEED.modelId, providerId: SEED.providerId } },
    include: { pricing: { orderBy: { effectiveFrom: 'desc' }, take: 1 } },
  });
  const pricing = link?.pricing?.[0];
  assert.ok(pricing, 'a pricing row must be persisted by the production Save');
  assert.equal(pricing?.inputPerMillion, SAVE_VALUES.pricing.inputPerMillion, 'pricing input persisted');
  assert.equal(pricing?.outputPerMillion, SAVE_VALUES.pricing.outputPerMillion, 'pricing output persisted');
  assert.equal(pricing?.cachedPerMillion, null, 'pricing cached null semantics preserved');
  assert.equal(pricing?.currency, SAVE_VALUES.pricing.currency, 'pricing currency persisted');
  console.log('  pass: Pricing fields + null semantics verified via fresh client');

  await fresh.$disconnect();

  // Durability configuration is effective on the initialized database.
  const pragmas = readPragmas(destDb);
  assert.equal(pragmas.journalMode, 'wal', `journal_mode must be wal (got ${pragmas.journalMode})`);
  console.log(`  pass: durable journal_mode=${pragmas.journalMode} on the initialized database`);
}

run()
  .then(() => {
    console.log('All built-TUI Save assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
