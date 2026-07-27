import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initializeDatabase, isValidSqliteDatabase } from '../src/infrastructure/runtime/database-path.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

console.log('--- Task C1: Legacy Database Discovery & Real SQLite Test ---');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-c1-real-'));

try {
  const dummyDbPath = path.join(tmpDir, 'opencode-models.db');

  // Create a real SQLite database with all 4 required tables using node:sqlite & SCHEMA_DDL
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dummyDbPath);
  const { SCHEMA_DDL } = require('../src/infrastructure/runtime/schema-ddl.js');
  db.exec(SCHEMA_DDL);
  db.close();

  assert.equal(isValidSqliteDatabase(dummyDbPath), true, 'Real SQLite database with expected tables must be valid');
  console.log('  pass: Real SQLite database with expected tables verified');

  // One-time migration test
  const destDb = path.join(tmpDir, 'dest', 'opencode-models.db');
  process.env.SDD_PLUGIN_DB_PATH = destDb;

  const initPath = initializeDatabase({ projectDbPath: dummyDbPath });
  assert.equal(initPath, destDb);
  assert.equal(isValidSqliteDatabase(destDb), true);
  console.log('  pass: One-time migration from real SQLite DB verified');

} finally {
  delete process.env.SDD_PLUGIN_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

console.log('Task C1 real SQLite assertions complete.');
