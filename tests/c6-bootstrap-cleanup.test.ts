import assert from 'node:assert/strict';
import path from 'node:path';

import { getPrismaClient, disposeBootstrapPersistence } from '../src/bootstrap/index.js';
import {
  createSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from './helpers/temp-database.js';

/**
 * The bootstrap plugin contract exposes no lifecycle/dispose callback, so the
 * composition root owns shutdown explicitly. This test pins that ownership:
 * repeated and concurrent shutdown must disconnect each client exactly once.
 */
console.log('--- C6: Bootstrap persistence ownership shutdown ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-c6-bootstrap-');

async function run(): Promise<void> {
  const dbPath = path.join(tmpDir, 'data', 'opencode-models.db');
  createSchemaDatabase(dbPath);
  process.env.SDD_PLUGIN_DB_PATH = dbPath;
  delete process.env.SDD_PLUGIN_DATA_DIR;

  const client = getPrismaClient();

  let disconnectCalls = 0;
  const realDisconnect = client.$disconnect.bind(client);
  (client as unknown as { $disconnect: () => Promise<void> }).$disconnect = async () => {
    disconnectCalls++;
    await realDisconnect();
  };

  // Repeated sequential shutdown, then concurrent shutdown.
  await disposeBootstrapPersistence();
  await disposeBootstrapPersistence();
  await Promise.all([disposeBootstrapPersistence(), disposeBootstrapPersistence()]);

  assert.equal(
    disconnectCalls,
    1,
    `bootstrap client must disconnect exactly once (got ${disconnectCalls})`,
  );
  console.log(`  pass: bootstrap disconnect counter = ${disconnectCalls} under 4 shutdown calls`);

  // A client created after shutdown is owned by the next shutdown cycle.
  const second = getPrismaClient();
  let secondDisconnects = 0;
  const secondReal = second.$disconnect.bind(second);
  (second as unknown as { $disconnect: () => Promise<void> }).$disconnect = async () => {
    secondDisconnects++;
    await secondReal();
  };

  await Promise.all([disposeBootstrapPersistence(), disposeBootstrapPersistence()]);
  assert.equal(secondDisconnects, 1, 'client created after shutdown disconnects exactly once');
  assert.equal(disconnectCalls, 1, 'already-released client is not disconnected twice');
  console.log('  pass: post-shutdown client owned by next cycle; earlier client not re-disconnected');
}

run()
  .then(() => {
    console.log('All C6 bootstrap ownership assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
