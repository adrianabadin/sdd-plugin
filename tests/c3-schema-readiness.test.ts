import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initializeDatabase, isValidSqliteDatabase, isSchemaCompatible } from '../src/infrastructure/runtime/database-path.js';
import { createSchemaDatabase, makeTempDir, removeTempDir } from './helpers/temp-database.js';

console.log('--- Task C3: Schema Readiness & Table Validation RED Test ---');

const tmpDir = makeTempDir('sdd-c3-test-');

try {
  // Case 1: 100-byte SQLite header file with NO tables -> isValidSqliteDatabase must return false
  const headerOnlyDb = path.join(tmpDir, 'header-only.db');
  const header = Buffer.alloc(100);
  header.write('SQLite format 3\0', 0);
  fs.writeFileSync(headerOnlyDb, header);

  assert.equal(isValidSqliteDatabase(headerOnlyDb), false, 'Header-only DB without required tables must be rejected');
  console.log('  pass: 100-byte header-only SQLite file correctly rejected');

  // Case 2: SQLite file with some tables but missing Provider / Model / ModelProvider / ModelProviderPricing
  const destDb = path.join(tmpDir, 'dest-schemaless.db');
  fs.copyFileSync(headerOnlyDb, destDb);
  process.env.SDD_PLUGIN_DB_PATH = destDb;

  assert.throws(() => {
    initializeDatabase({ projectDbPath: headerOnlyDb });
  });

  console.log('  pass: initializeDatabase rejects schema-less source database');

  // Case 3: Missing columns per required table
  // Create valid base schema DB, then corrupt each table by dropping/re-creating without a required column
  const baseDb = path.join(tmpDir, 'valid-base.db');
  createSchemaDatabase(baseDb);
  assert.equal(isSchemaCompatible(baseDb), true, 'Base schema DB must be schema-compatible');

  // Column test fixtures: table, sql to corrupt, missing column name
  const columnFixtures = [
    { table: 'Provider', column: 'isBlocked', sql: 'CREATE TABLE "Provider_bad" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL); DROP TABLE "Provider"; ALTER TABLE "Provider_bad" RENAME TO "Provider";' },
    { table: 'Model', column: 'metadataEnvelopeHash', sql: 'CREATE TABLE "Model_bad" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL); DROP TABLE "Model"; ALTER TABLE "Model_bad" RENAME TO "Model";' },
    { table: 'ModelProvider', column: 'quarantineType', sql: 'CREATE TABLE "ModelProvider_bad" ("id" TEXT PRIMARY KEY, "modelId" TEXT NOT NULL, "providerId" TEXT NOT NULL); DROP TABLE "ModelProvider"; ALTER TABLE "ModelProvider_bad" RENAME TO "ModelProvider";' },
    { table: 'ModelProviderPricing', column: 'cachedPerMillion', sql: 'CREATE TABLE "ModelProviderPricing_bad" ("id" TEXT PRIMARY KEY, "modelProviderId" TEXT NOT NULL, "currency" TEXT NOT NULL); DROP TABLE "ModelProviderPricing"; ALTER TABLE "ModelProviderPricing_bad" RENAME TO "ModelProviderPricing";' },
  ];

  for (const fixture of columnFixtures) {
    const corruptDb = path.join(tmpDir, `missing-col-${fixture.table}.db`);
    fs.copyFileSync(baseDb, corruptDb);
    // Apply corruption via node:sqlite / DatabaseSync
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(corruptDb);
    db.exec(fixture.sql);
    db.close();

    assert.equal(isSchemaCompatible(corruptDb), false, `DB missing column ${fixture.table}.${fixture.column} must not be schema-compatible`);

    const destCorrupt = path.join(tmpDir, `dest-corrupt-${fixture.table}.db`);
    fs.copyFileSync(corruptDb, destCorrupt);
    process.env.SDD_PLUGIN_DB_PATH = destCorrupt;
    assert.throws(() => {
      initializeDatabase({ projectDbPath: corruptDb });
    }, (err: any) => {
      const msg = String(err) + (err.cause ? String(err.cause) : '');
      assert.match(msg, /column|remediation|No valid database|incompatible/i);
      return true;
    });
  }
  console.log('  pass: rejects missing column fixtures with actionable error');

  // Case 4: Missing structural PK / FK / Unique / Index constraints
  const constraintFixtures = [
    // Missing unique index on ModelProvider(modelId, providerId)
    { name: 'ModelProvider_modelId_providerId_key', sql: 'DROP INDEX IF EXISTS "ModelProvider_modelId_providerId_key";' },
    // Missing index on ModelProviderPricing(modelProviderId, effectiveFrom)
    { name: 'ModelProviderPricing_modelProviderId_effectiveFrom_idx', sql: 'DROP INDEX IF EXISTS "ModelProviderPricing_modelProviderId_effectiveFrom_idx";' },
    // Missing only the FK constraint on ModelProvider(modelId); retain every
    // required column, the providerId FK, and the required unique index so this
    // fixture cannot be rejected for an earlier readiness condition.
    { name: 'ModelProvider_modelId_fkey', sql: 'CREATE TABLE "ModelProvider_nofk" ("id" TEXT NOT NULL PRIMARY KEY, "modelId" TEXT NOT NULL, "providerId" TEXT NOT NULL, "quarantineType" TEXT, "quarantineUntil" DATETIME, CONSTRAINT "ModelProvider_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE); DROP TABLE "ModelProvider"; ALTER TABLE "ModelProvider_nofk" RENAME TO "ModelProvider"; CREATE UNIQUE INDEX "ModelProvider_modelId_providerId_key" ON "ModelProvider"("modelId", "providerId");' },
  ];

  for (const fixture of constraintFixtures) {
    const corruptDb = path.join(tmpDir, `missing-index-${fixture.name}.db`);
    fs.copyFileSync(baseDb, corruptDb);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(corruptDb);
    db.exec(fixture.sql);
    db.close();

    assert.equal(isSchemaCompatible(corruptDb), false, `DB missing constraint/index ${fixture.name} must not be schema-compatible`);
  }
  console.log('  pass: rejects missing structural index/unique constraints');

  // Case 5: Clean install — no destination & no legacy source -> provisions fresh valid schema from bundled DDL
  const cleanDest = path.join(tmpDir, 'clean-install', 'opencode-models.db');
  process.env.SDD_PLUGIN_DB_PATH = cleanDest;
  delete process.env.SDD_PLUGIN_LEGACY_DB_PATH;

  const resultPath = initializeDatabase();
  assert.equal(resultPath, cleanDest);
  assert.equal(fs.existsSync(cleanDest), true, 'Clean install must create destination file');
  assert.equal(isSchemaCompatible(cleanDest), true, 'Clean install destination must be valid schema-compatible database');
  console.log('  pass: clean install from empty environment provisions valid schema from bundled DDL');

} finally {
  delete process.env.SDD_PLUGIN_DB_PATH;
  removeTempDir(tmpDir);
}

console.log('Task C3 RED assertions complete.');
