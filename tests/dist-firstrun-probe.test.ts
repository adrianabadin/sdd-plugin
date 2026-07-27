import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  REQUIRED_TABLES,
  createSchemaDatabase,
  listTables,
  makeTempDir,
  readPragmas,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from './helpers/temp-database.js';

/**
 * First-run behaviour of the BUILT bundle.
 *
 * Everything (legacy source and destination) lives in os.tmpdir(). The real
 * workspace database is only fingerprinted, never read into the run, and is
 * asserted byte-identical afterwards.
 */
console.log('--- Built dist first-run migration (fully temporary) ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-dist-firstrun-');
const realProjectDb = path.join(process.cwd(), 'opencode-models.db');

/** Fingerprint without taking an exclusive lock (the real DB may be in use). */
function fingerprint(file: string): string {
  if (!fs.existsSync(file)) return 'ABSENT';
  const stat = fs.statSync(file);
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytes <= 0) break;
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
  return `${hash.digest('hex')}:${stat.size}:${stat.mtimeMs}`;
}

async function run(): Promise<void> {
  const beforeRealDb = fingerprint(realProjectDb);

  const dataDir = path.join(tmpDir, 'user-data');
  const legacyDb = path.join(tmpDir, 'legacy', 'opencode-models.db');
  const destDb = path.join(dataDir, 'opencode-models.db');

  // Real legacy SQLite database with schema AND data, entirely in temp.
  createSchemaDatabase(legacyDb);
  const seedDb = new DatabaseSync(legacyDb);
  try {
    seedDb.exec(
      `INSERT INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES ('legacy-provider','Legacy Provider',0,'2026-01-01T00:00:00.000Z')`,
    );
    seedDb.exec(
      `INSERT INTO "Model" ("id","name","mmlu","updatedAt") VALUES ('legacy-model','Legacy Model',42.5,'2026-01-01T00:00:00.000Z')`,
    );
  } finally {
    seedDb.close();
  }

  process.env.SDD_PLUGIN_DATA_DIR = dataDir;
  process.env.SDD_PLUGIN_LEGACY_DB_PATH = legacyDb;
  delete process.env.SDD_PLUGIN_DB_PATH;

  assert.equal(fs.existsSync(destDb), false, 'destination must not exist before first run');

  const distTui = path.join(process.cwd(), 'dist', 'tui.js');
  assert.ok(fs.existsSync(distTui), 'dist/tui.js must exist (run npm run build first)');
  const builtModule = await import(`${pathToFileURL(distTui).href}?firstrun=${Date.now()}`);

  // Drive first-run through the built plugin entrypoint.
  const registeredCommands: Record<string, () => void> = {};
  const mockApi = {
    client: {},
    keymap: {
      registerLayer: (layer: { commands?: Array<{ name: string; run: () => void }> }) => {
        for (const cmd of layer.commands ?? []) registeredCommands[cmd.name] = cmd.run;
        return () => {};
      },
    },
    ui: { dialog: { replace: () => {}, clear: () => {} } },
    lifecycle: { onDispose: () => {} },
  };

  await builtModule.default.tui(mockApi as never);
  assert.ok(
    registeredCommands['model-control-center.open'],
    'built bundle must register the open command',
  );

  assert.ok(fs.existsSync(destDb), 'first run must create the destination database');
  console.log('  pass: built bundle first-run created the temp destination database');

  // Schema migrated
  const tables = listTables(destDb);
  for (const table of REQUIRED_TABLES) {
    assert.ok(tables.includes(table), `migrated database must contain ${table}`);
  }
  console.log('  pass: all required tables present after migration');

  // Data migrated (integrity, not just schema)
  const check = new DatabaseSync(destDb, { readOnly: true });
  try {
    const provider = check
      .prepare(`SELECT "name" FROM "Provider" WHERE "id" = 'legacy-provider'`)
      .get() as { name?: string } | undefined;
    const model = check
      .prepare(`SELECT "name","mmlu" FROM "Model" WHERE "id" = 'legacy-model'`)
      .get() as { name?: string; mmlu?: number } | undefined;
    assert.equal(provider?.name, 'Legacy Provider', 'legacy provider row must migrate');
    assert.equal(model?.name, 'Legacy Model', 'legacy model row must migrate');
    assert.equal(model?.mmlu, 42.5, 'legacy benchmark value must migrate intact');
  } finally {
    check.close();
  }
  console.log('  pass: legacy rows and values migrated intact');

  // Durability configured on the migrated destination
  const pragmas = readPragmas(destDb);
  assert.equal(pragmas.journalMode, 'wal', `journal_mode must be wal (got ${pragmas.journalMode})`);
  console.log(`  pass: destination journal_mode=${pragmas.journalMode}`);

  // The real workspace database was never involved.
  const afterRealDb = fingerprint(realProjectDb);
  assert.equal(afterRealDb, beforeRealDb, 'the real project database must be untouched');
  console.log('  pass: real project database byte-identical before/after (hash:size:mtime)');
}

run()
  .then(() => {
    console.log('All dist first-run assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
