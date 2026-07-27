/**
 * Finding 11 — Additive runtime migrations upgrade legacy databases.
 *
 * Existing stable databases predate the `quarantineReason` columns added by
 * PR2. The `dist/` package does not include `prisma/migrations/`, so a fresh
 * `prisma db push` cannot run against a destination the user already
 * provisioned. Without an additive migration step, every legacy DB would
 * be permanently rejected by `assertValidSqliteDatabase` once the new
 * columns are added to `REQUIRED_SCHEMA_COLUMNS`.
 *
 * The migration framework in `src/infrastructure/runtime/database-path.ts`
 * (`RUNTIME_ADDITIVE_MIGRATIONS` + `applyAdditiveMigrations`) MUST:
 *   1. Leave an already-upgraded database untouched (idempotent re-run).
 *   2. Add the `quarantineReason` column to every legacy DB that predates
 *      the column, in place, NULL-filled.
 *   3. Re-run the readiness validation after the migration and accept the
 *      upgraded database.
 *
 * The tests exercise both paths against a real temp SQLite file in the
 * system temp directory; the real project database is never touched.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  applyAdditiveMigrations,
  initializeDatabase,
  isValidSqliteDatabase,
} from "../src/infrastructure/runtime/database-path.js";
import { removeTempDir, snapshotEnv, restoreEnv } from "./helpers/temp-database.js";

console.log("--- Finding 11: additive runtime migrations upgrade legacy databases ---");

const env = snapshotEnv();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-additive-migration-"));

/**
 * Build a "legacy" SQLite database whose schema matches the pre-PR2
 * `prisma/migrations/20260721000000_init/migration.sql` (i.e. NO
 * `quarantineReason` column on any table). The bundled `SCHEMA_DDL` is
 * NOT used here because it now contains the new columns.
 */
function createLegacySchemaDatabase(destPath: string): string {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const db = new DatabaseSync(destPath);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`CREATE TABLE "Provider" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "subscription" TEXT,
      "isBlocked" BOOLEAN NOT NULL DEFAULT false,
      "metadata" TEXT,
      "metadataEnvelopeHash" TEXT,
      "quarantineType" TEXT,
      "quarantineUntil" DATETIME,
      "updatedAt" DATETIME NOT NULL
    );`);
    db.exec(`CREATE TABLE "Model" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "metadata" TEXT,
      "metadataEnvelopeHash" TEXT,
      "mmlu" REAL,
      "humaneval" REAL,
      "sweBench" REAL,
      "gpqa" REAL,
      "math" REAL,
      "bbh" REAL,
      "mtBench" REAL,
      "multineedle" REAL,
      "quarantineType" TEXT,
      "quarantineUntil" DATETIME,
      "updatedAt" DATETIME NOT NULL
    );`);
    db.exec(`CREATE TABLE "ModelProvider" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "modelId" TEXT NOT NULL,
      "providerId" TEXT NOT NULL,
      "quarantineType" TEXT,
      "quarantineUntil" DATETIME,
      CONSTRAINT "ModelProvider_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "ModelProvider_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`);
    db.exec(`CREATE TABLE "ModelProviderPricing" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "modelProviderId" TEXT NOT NULL,
      "inputPerMillion" REAL,
      "outputPerMillion" REAL,
      "cachedPerMillion" REAL,
      "currency" TEXT NOT NULL DEFAULT 'USD',
      "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "effectiveUntil" DATETIME,
      CONSTRAINT "ModelProviderPricing_modelProviderId_fkey" FOREIGN KEY ("modelProviderId") REFERENCES "ModelProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`);
    db.exec(`CREATE UNIQUE INDEX "ModelProvider_modelId_providerId_key" ON "ModelProvider"("modelId", "providerId");`);
    db.exec(`CREATE INDEX "ModelProviderPricing_modelProviderId_effectiveFrom_idx" ON "ModelProviderPricing"("modelProviderId", "effectiveFrom");`);
  } finally {
    db.close();
  }
  return destPath;
}

/** Confirm a column is present on a table via pragma_table_info. */
function hasColumn(dbPath: string, table: string, column: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT 1 AS hit FROM pragma_table_info('${table}') WHERE "name" = ?`)
      .get(column) as { hit?: number } | undefined;
    return Boolean(row && Number(row.hit ?? 0) === 1);
  } finally {
    db.close();
  }
}

async function run(): Promise<void> {
  const legacyDb = path.join(tmpDir, "legacy", "opencode-models.db");

  // === Case A: a legacy database (no quarantineReason column) is rejected
  // by readiness BEFORE the additive migration runs.
  createLegacySchemaDatabase(legacyDb);
  assert.equal(
    hasColumn(legacyDb, "Provider", "quarantineReason"),
    false,
    "legacy DB must NOT have the quarantineReason column initially",
  );
  assert.equal(
    isValidSqliteDatabase(legacyDb),
    false,
    "a legacy DB that predates quarantineReason is NOT schema-compatible until migrated",
  );
  console.log("  pass: legacy DB (no quarantineReason) is rejected by readiness check");

  // === Case B: applyAdditiveMigrations adds the missing columns in place.
  applyAdditiveMigrations(legacyDb);
  assert.equal(
    hasColumn(legacyDb, "Provider", "quarantineReason"),
    true,
    "Provider.quarantineReason added by the additive migration",
  );
  assert.equal(
    hasColumn(legacyDb, "Model", "quarantineReason"),
    true,
    "Model.quarantineReason added by the additive migration",
  );
  assert.equal(
    hasColumn(legacyDb, "ModelProvider", "quarantineReason"),
    true,
    "ModelProvider.quarantineReason added by the additive migration",
  );
  console.log("  pass: applyAdditiveMigrations added the quarantineReason columns in place");

  // === Case C: after the migration the legacy DB passes the readiness check.
  assert.equal(
    isValidSqliteDatabase(legacyDb),
    true,
    "migrated legacy DB must be schema-compatible",
  );
  console.log("  pass: migrated legacy DB passes the readiness check");

  // === Case D: the migration is idempotent — re-running on the upgraded DB
  // is a no-op and does not throw.
  applyAdditiveMigrations(legacyDb);
  applyAdditiveMigrations(legacyDb);
  assert.equal(
    isValidSqliteDatabase(legacyDb),
    true,
    "idempotent re-runs leave the upgraded DB valid",
  );
  console.log("  pass: additive migration is idempotent on an already-upgraded DB");

  // === Case E: initializeDatabase on a legacy DB (full happy path) upgrades
  // the DB transparently and returns the same destination path.
  const legacyDb2 = path.join(tmpDir, "legacy2", "opencode-models.db");
  createLegacySchemaDatabase(legacyDb2);
  process.env.SDD_PLUGIN_DB_PATH = legacyDb2;
  delete process.env.SDD_PLUGIN_DATA_DIR;
  delete process.env.SDD_PLUGIN_LEGACY_DB_PATH;
  const resultPath = initializeDatabase();
  assert.equal(resultPath, path.resolve(legacyDb2), "initializeDatabase returns the destination path");
  assert.equal(
    hasColumn(resultPath, "Provider", "quarantineReason") &&
      hasColumn(resultPath, "Model", "quarantineReason") &&
      hasColumn(resultPath, "ModelProvider", "quarantineReason"),
    true,
    "initializeDatabase upgraded the legacy destination before validation",
  );
  assert.equal(
    isValidSqliteDatabase(resultPath),
    true,
    "post-initializeDatabase readiness check passes on the upgraded destination",
  );
  console.log("  pass: initializeDatabase upgrades a legacy destination before validation");

  // === Case F: existing data survives the additive migration.
  const seedDb = new DatabaseSync(legacyDb2);
  try {
    const now = new Date().toISOString();
    seedDb.prepare(
      `INSERT INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES (?, ?, 0, ?)`,
    ).run("legacy-provider", "Legacy Provider", now);
  } finally {
    seedDb.close();
  }
  const readback = new DatabaseSync(legacyDb2, { readOnly: true });
  try {
    const row = readback
      .prepare(`SELECT "name" AS name, "quarantineReason" AS reason FROM "Provider" WHERE "id" = ?`)
      .get("legacy-provider") as { name?: string; reason?: string | null } | undefined;
    assert.ok(row, "legacy provider row survives the additive migration");
    assert.equal(row.name, "Legacy Provider", "legacy provider name preserved");
    assert.equal(row.reason ?? null, null, "legacy provider quarantineReason stays NULL after migration");
  } finally {
    readback.close();
  }
  console.log("  pass: existing legacy rows survive the additive migration with NULL quarantineReason");
}

run()
  .then(() => {
    console.log("All additive-runtime-migration assertions passed!");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
