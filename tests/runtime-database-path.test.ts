import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveDatabasePath, initializeDatabase } from '../src/infrastructure/runtime/database-path.js';
import {
  REQUIRED_TABLES,
  createSchemaDatabase,
  listTables,
  removeTempDir,
} from './helpers/temp-database.js';

console.log('--- Shared Database Path Resolver & Initializer Test ---');

// Test env overrides
const prevDbPath = process.env.SDD_PLUGIN_DB_PATH;
const prevDataDir = process.env.SDD_PLUGIN_DATA_DIR;

try {
  // 1. SDD_PLUGIN_DB_PATH takes highest precedence
  const tmpOverrideDb = path.join(os.tmpdir(), 'custom-override.db');
  process.env.SDD_PLUGIN_DB_PATH = tmpOverrideDb;
  delete process.env.SDD_PLUGIN_DATA_DIR;
  assert.equal(resolveDatabasePath(), path.resolve(tmpOverrideDb));
  console.log('  pass: SDD_PLUGIN_DB_PATH precedence verified');

  // 2. SDD_PLUGIN_DATA_DIR takes second precedence
  delete process.env.SDD_PLUGIN_DB_PATH;
  const tmpDataDir = path.join(os.tmpdir(), 'sdd-test-data-dir');
  process.env.SDD_PLUGIN_DATA_DIR = tmpDataDir;
  assert.equal(resolveDatabasePath(), path.resolve(tmpDataDir, 'opencode-models.db'));
  console.log('  pass: SDD_PLUGIN_DATA_DIR precedence verified');

  // 3. Platform default path resolution when no env vars set
  delete process.env.SDD_PLUGIN_DB_PATH;
  delete process.env.SDD_PLUGIN_DATA_DIR;
  const defaultPath = resolveDatabasePath();
  assert.ok(path.isAbsolute(defaultPath));
  assert.ok(defaultPath.endsWith('opencode-models.db'));

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    assert.equal(defaultPath, path.join(localAppData, 'sdd-plugin', 'opencode-models.db'));
  } else if (process.platform === 'darwin') {
    assert.equal(defaultPath, path.join(os.homedir(), 'Library', 'Application Support', 'sdd-plugin', 'opencode-models.db'));
  } else {
    const xdgConfig = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    assert.equal(defaultPath, path.join(xdgConfig, 'sdd-plugin', 'opencode-models.db'));
  }
  console.log('  pass: platform default path resolution verified');

  // 4. Bundle/CWD independence test
  const cwdBefore = process.cwd();
  try {
    process.chdir(os.tmpdir());
    assert.equal(resolveDatabasePath(), defaultPath);
    console.log('  pass: resolver is independent of process.cwd()');
  } finally {
    process.chdir(cwdBefore);
  }

  // 5. Migration non-overwrite and invalid DB rejection tests
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-db-test-'));
  const destDb = path.join(testDir, 'dest', 'opencode-models.db');
  const sourceDb = path.join(testDir, 'source', 'opencode-models.db');

  process.env.SDD_PLUGIN_DB_PATH = destDb;

  // Case 5a: No dest DB and no valid source DB -> initializeDatabase must throw structured error and not create 0-byte file
  assert.throws(() => {
    initializeDatabase({ projectDbPath: sourceDb });
  }, (err: any) => {
    return err && err.message && err.message.includes('No valid database');
  });
  assert.equal(fs.existsSync(destDb), false, 'Must not create dest DB if source is absent/invalid');
  console.log('  pass: invalid/missing database rejection verified');

  // Case 5b (adversarial): a file carrying a valid SQLite header AND the
  // required table names as raw text is NOT a usable database. Readiness is
  // fail-closed: it must be rejected and must not produce a destination.
  fs.mkdirSync(path.dirname(sourceDb), { recursive: true });
  const forgedHeader = Buffer.alloc(512);
  forgedHeader.write('SQLite format 3\0Provider Model ModelProvider ModelProviderPricing', 0);
  fs.writeFileSync(sourceDb, forgedHeader);

  assert.throws(() => {
    initializeDatabase({ projectDbPath: sourceDb });
  }, (err: any) => {
    return err && err.message && err.message.includes('No valid database');
  }, 'Header + table-name text must not be accepted as a ready database');
  assert.equal(
    fs.existsSync(destDb),
    false,
    'Adversarial header/table-name file must not produce a destination database',
  );
  console.log('  pass: adversarial header+table-name file rejected (fail-closed)');

  // Case 5c: One-time atomic migration from a REAL SQLite database
  fs.rmSync(sourceDb, { force: true });
  createSchemaDatabase(sourceDb);

  const initPath = initializeDatabase({ projectDbPath: sourceDb });
  assert.equal(initPath, destDb);
  assert.equal(fs.existsSync(destDb), true);
  const migratedTables = listTables(destDb);
  for (const table of REQUIRED_TABLES) {
    assert.ok(migratedTables.includes(table), `migrated database must contain ${table}`);
  }
  console.log('  pass: one-time atomic migration from a real SQLite source verified');

  // Case 5d: Destination already exists -> initializeDatabase must not overwrite
  // it, even when the source is later replaced by an invalid file.
  fs.rmSync(sourceDb, { force: true });
  const replacedSource = Buffer.alloc(512);
  replacedSource.write('SQLite format 3\0REPLACED-NOT-A-DB', 0);
  fs.writeFileSync(sourceDb, replacedSource);

  const initPath2 = initializeDatabase({ projectDbPath: sourceDb });
  assert.equal(initPath2, destDb);
  const preservedTables = listTables(destDb);
  for (const table of REQUIRED_TABLES) {
    assert.ok(preservedTables.includes(table), `existing destination must keep ${table}`);
  }
  console.log('  pass: existing destination non-overwrite verified');

  // Cleanup testDir
  removeTempDir(testDir);

} finally {
  if (prevDbPath !== undefined) process.env.SDD_PLUGIN_DB_PATH = prevDbPath;
  else delete process.env.SDD_PLUGIN_DB_PATH;
  if (prevDataDir !== undefined) process.env.SDD_PLUGIN_DATA_DIR = prevDataDir;
  else delete process.env.SDD_PLUGIN_DATA_DIR;
}

console.log('All Task 1 path/initializer assertions passed!');
