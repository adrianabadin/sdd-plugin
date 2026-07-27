/**
 * Finding 5 — Structural schema compatibility.
 *
 * Reading/writing the durable path through Prisma relies on columns, indexes,
 * and required FK shape — not merely the four table names. An outdated table
 * shape that is missing a required column must NOT pass readiness.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initializeDatabase, isValidSqliteDatabase } from '../src/infrastructure/runtime/database-path.js';
import {
  createSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from './helpers/temp-database.js';

console.log('--- Finding 5: structural schema compatibility ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-schema-shape-');

async function run(): Promise<void> {
  // === Accepted: a current-schema database passes readiness.
  const currentDb = path.join(tmpDir, 'current', 'opencode-models.db');
  fs.mkdirSync(path.dirname(currentDb), { recursive: true });
  createSchemaDatabase(currentDb);
  assert.equal(isValidSqliteDatabase(currentDb), true, 'current schema with all required columns must be accepted');
  console.log('  pass: current schema accepted');

  // === Rejected: a database with the four tables but missing required columns.
  const outdatedDb = path.join(tmpDir, 'outdated', 'opencode-models.db');
  fs.mkdirSync(path.dirname(outdatedDb), { recursive: true });
  const db = new DatabaseSync(outdatedDb);
  try {
    db.exec('CREATE TABLE "Provider" ("id" TEXT PRIMARY KEY, "name" TEXT);'); // missing metadata etc.
    db.exec('CREATE TABLE "Model" ("id" TEXT PRIMARY KEY, "name" TEXT);');    // missing benchmarks
    db.exec('CREATE TABLE "ModelProvider" ("id" TEXT PRIMARY KEY);');          // missing FKs
    db.exec('CREATE TABLE "ModelProviderPricing" ("id" TEXT PRIMARY KEY);');   // missing FKs
  } finally {
    db.close();
  }
  assert.equal(isValidSqliteDatabase(outdatedDb), false, 'outdated/outdated-shape must NOT be accepted');
  console.log('  pass: outdated/outdated-shape rejected');

  // === initializeDatabase rejects it.
  const destDb = path.join(tmpDir, 'dest', 'opencode-models.db');
  process.env.SDD_PLUGIN_DB_PATH = destDb;
  assert.throws(() => {
    initializeDatabase({ projectDbPath: outdatedDb });
  });
  delete process.env.SDD_PLUGIN_DB_PATH;
  console.log('  pass: initializeDatabase rejects outdated shape');
}

run()
  .then(() => {
    console.log('All structural-schema assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
