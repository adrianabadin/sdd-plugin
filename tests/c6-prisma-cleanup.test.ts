import assert from 'node:assert/strict';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { createPersistenceContext } from '../src/infrastructure/runtime/persistence-context.js';
import {
  createSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from './helpers/temp-database.js';

console.log('--- C6: Prisma writer/verifier disposal counters ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-c6-cleanup-');

/** Counts $disconnect() calls per constructed client. */
function makeCountingFactory() {
  const disconnectCounts: number[] = [];
  const factory = (): PrismaClient => {
    const index = disconnectCounts.length;
    disconnectCounts.push(0);
    const stub = {
      $disconnect: async () => {
        disconnectCounts[index] = (disconnectCounts[index] ?? 0) + 1;
      },
    };
    return stub as unknown as PrismaClient;
  };
  return { factory, disconnectCounts };
}

async function run(): Promise<void> {
  const dbPath = path.join(tmpDir, 'data', 'opencode-models.db');
  createSchemaDatabase(dbPath);
  process.env.SDD_PLUGIN_DB_PATH = dbPath;
  delete process.env.SDD_PLUGIN_DATA_DIR;

  const { factory, disconnectCounts } = makeCountingFactory();
  const context = await createPersistenceContext({ clientFactory: factory });

  assert.equal(disconnectCounts.length, 2, 'context must build a writer and an independent verifier client');
  assert.notEqual(context.writer, context.verifier, 'verifier must be a separate client instance');
  assert.equal(context.isDisposed(), false, 'context starts undisposed');
  console.log('  pass: writer and independent verifier clients constructed');

  // Repeated sequential disposal
  await context.dispose();
  await context.dispose();
  await context.dispose();

  // Concurrent disposal on top of the sequential calls
  await Promise.all([context.dispose(), context.dispose(), context.dispose()]);

  const writerDisconnects = disconnectCounts[0];
  const verifierDisconnects = disconnectCounts[1];

  assert.equal(writerDisconnects, 1, `writer $disconnect must be called exactly once (got ${writerDisconnects})`);
  assert.equal(verifierDisconnects, 1, `verifier $disconnect must be called exactly once (got ${verifierDisconnects})`);
  assert.equal(context.isDisposed(), true, 'context reports disposed after disposal');
  console.log(`  pass: disconnect counters writer=${writerDisconnects} verifier=${verifierDisconnects} under 6 disposal calls`);

  // A fresh context is independent and disposes its own clients exactly once.
  const second = makeCountingFactory();
  const context2 = await createPersistenceContext({ clientFactory: second.factory });
  await Promise.all([context2.dispose(), context2.dispose()]);
  assert.equal(second.disconnectCounts[0], 1, 'second context writer disconnects exactly once');
  assert.equal(second.disconnectCounts[1], 1, 'second context verifier disconnects exactly once');
  console.log('  pass: independent context disposes its own clients exactly once');

  // PR1 Task 1.1 additions:
  // 1. Partial PRAGMA failure closes ALL created clients (writer & verifier)
  const partialPragmaCounts: number[] = [];
  const failingPragmaFactory = (): PrismaClient => {
    const index = partialPragmaCounts.length;
    partialPragmaCounts.push(0);
    const stub = {
      $executeRawUnsafe: async (sql: string) => {
        // Fail on verifier's PRAGMA setup (index === 1)
        if (index === 1) {
          throw new Error('PRAGMA failure simulation on verifier');
        }
      },
      $disconnect: async () => {
        partialPragmaCounts[index] = (partialPragmaCounts[index] ?? 0) + 1;
      },
    };
    return stub as unknown as PrismaClient;
  };

  await assert.rejects(
    async () => {
      await createPersistenceContext({ clientFactory: failingPragmaFactory });
    },
    (err: unknown) => {
      assert.match(String(err), /Persistence runtime PRAGMAs could not be applied/);
      return true;
    },
    'PRAGMA failure must reject createPersistenceContext',
  );

  assert.equal(
    partialPragmaCounts[0],
    1,
    'writer must be disconnected when PRAGMA setup fails on verifier',
  );
  assert.equal(
    partialPragmaCounts[1],
    1,
    'verifier must be disconnected when PRAGMA setup fails on verifier',
  );
  console.log('  pass: PRAGMA setup failure closes all created clients');

  // 2. Disconnect rejection is surfaced during dispose()
  const rejectingDisconnectFactory = (): PrismaClient => {
    const stub = {
      $disconnect: async () => {
        throw new Error('Disconnect failed error');
      },
    };
    return stub as unknown as PrismaClient;
  };

  const contextFailingDisconnect = await createPersistenceContext({ clientFactory: rejectingDisconnectFactory });
  await assert.rejects(
    async () => {
      await contextFailingDisconnect.dispose();
    },
    (err: unknown) => {
      assert.match(String(err), /Disconnect failed error|PersistenceContext disconnect failed/);
      return true;
    },
    'disconnect rejection must be surfaced',
  );
  console.log('  pass: disconnect rejection is surfaced during dispose()');
}

run()
  .then(() => {
    console.log('All C6 cleanup assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
