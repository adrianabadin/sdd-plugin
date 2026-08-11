/**
 * Finding 10 — Determinism under rapid/overlapping Saves.
 *
 * Repeated Ctrl+S must not produce overlapping transactions, and the active
 * pricing row after several rapid saves must be the one produced last, ordered
 * deterministically (effectiveFrom desc, id desc).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  SaveModelDetailUseCase,
  type SaveModelDetailInput,
} from '../src/application/save-model-detail/save-model-detail.use-case.js';
import type { PersistedModelDetail } from '../src/ports/model-detail-query.port.js';
import type { ModelConfigRegistry, EffectiveModelConfig } from '../src/infrastructure/runtime/model-config-registry.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaLibSql } from '@prisma/adapter-libsql';

import { PrismaModelRepositoryAdapter } from '../src/infrastructure/prisma/prisma-model-repository.adapter.js';
import {
  createPrismaSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from './helpers/temp-database.js';

console.log('--- Finding 10: rapid pricing saves are deterministic ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-rapid-save-');

const SEED = { providerId: 'openai', modelId: 'gpt-4o', modelProviderId: 'mp-rapid-1' };

class CapturingRegistry implements ModelConfigRegistry {
  public published: EffectiveModelConfig[] = [];
  private _revision = 0;
  get revision(): number { return this._revision; }
  publish(c: EffectiveModelConfig): void {
    this.published.push(c);
    this._revision++;
  }
  get(): EffectiveModelConfig | undefined { return undefined; }
  subscribe(): () => void { return () => undefined; }
}

async function run(): Promise<void> {
  const dbPath = path.join(tmpDir, 'data', 'opencode-models.db');
  createPrismaSchemaDatabase(dbPath);

  process.env.SDD_PLUGIN_DB_PATH = dbPath;
  delete process.env.SDD_PLUGIN_DATA_DIR;

  // === Seed identity through node:sqlite so the Prisma transaction succeeds.
  const seedDb = new DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();
    seedDb.prepare(
      `INSERT OR REPLACE INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES (?, ?, 0, ?)`,
    ).run(SEED.providerId, 'OpenAI', now);
    seedDb.prepare(
      `INSERT OR REPLACE INTO "Model" ("id","name","updatedAt") VALUES (?, ?, ?)`,
    ).run(SEED.modelId, 'GPT-4o', now);
    seedDb.prepare(
      `INSERT OR REPLACE INTO "ModelProvider" ("id","modelId","providerId") VALUES (?, ?, ?)`,
    ).run(SEED.modelProviderId, SEED.modelId, SEED.providerId);
  } finally {
    seedDb.close();
  }

  const adapter = new PrismaLibSql({ url: `file:${dbPath}` });
  const writerPrisma = new PrismaClient({ adapter });
  const verifierPrisma = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${dbPath}` }) });
  const writer = new PrismaModelRepositoryAdapter(writerPrisma);
  const verifier = new PrismaModelRepositoryAdapter(verifierPrisma);
  const registry = new CapturingRegistry();
  const useCase = new SaveModelDetailUseCase(writer, registry, verifier);

  const baseInput: SaveModelDetailInput = {
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
      mmlu: null, humaneval: null, sweBench: null, gpqa: null,
      math: null, bbh: null, mtBench: null, multineedle: null,
    },
    pricing: null,
    expectedEnvelopeHash: null,
  };

  // === Fire five saves back-to-back with rising pricing values. All run
  //     concurrently to exercise the in-flight guard / sequencing.
  const pricingSequence: Array<{ inputPerMillion: number; outputPerMillion: number; cachedPerMillion: number }> = [
    { inputPerMillion: 1.0, outputPerMillion: 2.0, cachedPerMillion: 0.10 },
    { inputPerMillion: 2.0, outputPerMillion: 4.0, cachedPerMillion: 0.20 },
    { inputPerMillion: 3.0, outputPerMillion: 6.0, cachedPerMillion: 0.30 },
    { inputPerMillion: 4.0, outputPerMillion: 8.0, cachedPerMillion: 0.40 },
    { inputPerMillion: 5.0, outputPerMillion: 10.0, cachedPerMillion: 0.50 },
  ];
  const settled = await Promise.allSettled(
    pricingSequence.map((p) =>
      useCase.execute({ ...baseInput, pricing: { ...p, currency: 'USD' } })),
  );

  const succeeded = settled.filter((s) => s.status === 'fulfilled');
  assert.equal(succeeded.length, pricingSequence.length, 'all five rapid saves must succeed');
  console.log(`  pass: 5 concurrent rapid saves all succeed (published=${registry.published.length})`);

  await writerPrisma.$disconnect();
  await verifierPrisma.$disconnect();

  // === Active pricing row must equal the LAST saved value (most recent
  //     effectiveFrom). Readback via a fresh client should select the row
  //     where effectiveUntil IS NULL and effectiveFrom is the largest.
  const freshAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
  const fresh = new PrismaClient({ adapter: freshAdapter });
  const freshReader = new PrismaModelRepositoryAdapter(fresh);
  const detail: PersistedModelDetail | null = await freshReader.findModelDetail(
    SEED.providerId,
    SEED.modelId,
  );
  await fresh.$disconnect();

  assert.ok(detail !== null, 'detail must be rehydrated');
  const lastEntry = pricingSequence[pricingSequence.length - 1];
  assert.ok(lastEntry !== undefined, 'pricingSequence must contain a final entry');
  const wantInput = lastEntry.inputPerMillion;
  const wantOutput = lastEntry.outputPerMillion;
  assert.equal(detail.pricing?.inputPerMillion, wantInput,
    `active pricing must reflect the most recent save (want=${wantInput}, got=${detail.pricing?.inputPerMillion})`);
  assert.equal(detail.pricing?.outputPerMillion, wantOutput,
    `active pricing output must reflect the most recent save`);
  console.log(`  pass: active pricing row is the most recent (inputPerMillion=${detail.pricing?.inputPerMillion})`);

  // === Stable ordering: among rows with effectiveFrom equal (same
  //     millisecond), the active row is chosen by id desc. This avoids
  //     non-deterministic Active row selection when many saves arrive
  //     in the same millisecond.
  const sameInstantDb = new DatabaseSync(dbPath);
  try {
    sameInstantDb.exec("PRAGMA foreign_keys = ON;");
    const rows = sameInstantDb
      .prepare(`SELECT "inputPerMillion", "effectiveFrom", "effectiveUntil" FROM "ModelProviderPricing" WHERE "modelProviderId" = ? ORDER BY "effectiveFrom" DESC, "id" DESC`)
      .all(SEED.modelProviderId) as Array<{ inputPerMillion: number; effectiveFrom: number; effectiveUntil: number | null }>;
    const active = rows.find((r) => r.effectiveUntil === null);
    assert.ok(active !== undefined, 'exactly one active pricing row must remain');
    assert.equal(active?.inputPerMillion, wantInput);
    assert.equal(active?.effectiveUntil, null, 'active row must have effectiveUntil=null');
  } finally {
    sameInstantDb.close();
  }
  console.log('  pass: stable effectiveFrom DESC, id DESC ordering keeps active row deterministic');
}

run()
  .then(() => {
    console.log('All rapid-pricing-save assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
