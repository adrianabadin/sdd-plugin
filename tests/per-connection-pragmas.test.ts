/**
 * Finding 3 — Per-runtime-connection PRAGMA enforcement.
 *
 * The durable-guarantee story is incomplete if the writer/verifier/bootstrap
 * Prisma connections cannot show effective foreign_keys=ON and synchronous=FULL
 * on demand. This test asks the production Prisma clients (no separate sqlite
 * connection) to verify each of those PRAGMAs and to prove FK enforcement.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { execFileSync } from 'node:child_process';

import { createPersistenceContext } from '../src/infrastructure/runtime/persistence-context.js';
import { getPrismaClient } from '../src/bootstrap/index.js';
import {
  createSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from './helpers/temp-database.js';

console.log('--- Finding 3: per-runtime-connection PRAGMAs + FK enforcement ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-per-conn-pragmas-');

async function run(): Promise<void> {
  const dbPath = path.join(tmpDir, 'data', 'opencode-models.db');
  createSchemaDatabase(dbPath);
  // Force Prisma to apply its own schema on top so the writer/verifier clients
  // can exercise Prisma-generated tables.
  execFileSync(
    process.execPath,
    [path.resolve('node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--accept-data-loss', '--url', `file:${dbPath}`],
    { stdio: 'ignore' },
  );

  process.env.SDD_PLUGIN_DB_PATH = dbPath;
  delete process.env.SDD_PLUGIN_DATA_DIR;

  // === Writer + verifier from the production composition seam.
  const ctx = await createPersistenceContext();
  assert.notEqual(ctx.writer, ctx.verifier);
  const writerPrisma = ctx.writer as unknown as PrismaClient;
  const verifierPrisma = ctx.verifier as unknown as PrismaClient;

  // === Drive a real PRAGMA readback through each Prisma client using
  //     $queryRawUnsafe on the actual libSQL-managed connection.
  async function readPragmasVia(client: PrismaClient) {
    const fk = await client.$queryRawUnsafe<Array<{ foreign_keys: number }>>('PRAGMA foreign_keys;');
    const sync = await client.$queryRawUnsafe<Array<{ synchronous: number }>>('PRAGMA synchronous;');
    return {
      foreignKeys: Number(fk[0]?.foreign_keys ?? -1),
      synchronous: Number(sync[0]?.synchronous ?? -1),
    };
  }

  const writerPragmas = await readPragmasVia(writerPrisma);
  assert.equal(writerPragmas.foreignKeys, 1, `writer foreign_keys=${writerPragmas.foreignKeys} (must be 1)`);
  assert.ok(writerPragmas.synchronous >= 1, `writer synchronous=${writerPragmas.synchronous} must be >= 1 (FULL=2)`);
  console.log(`  pass: writer runtime connection: foreign_keys=${writerPragmas.foreignKeys} synchronous=${writerPragmas.synchronous}`);

  const verifierPragmas = await readPragmasVia(verifierPrisma);
  assert.equal(verifierPragmas.foreignKeys, 1, `verifier foreign_keys=${verifierPragmas.foreignKeys} (must be 1)`);
  assert.ok(verifierPragmas.synchronous >= 1, `verifier synchronous=${verifierPragmas.synchronous} must be >= 1 (FULL=2)`);
  console.log(`  pass: verifier runtime connection: foreign_keys=${verifierPragmas.foreignKeys} synchronous=${verifierPragmas.synchronous}`);

  // === FK enforcement on the writer runtime connection.
  let orphanRejected = false;
  let orphanErrMessage = '';
  try {
    await writerPrisma.modelProvider.create({
      data: { modelId: 'ghost-model-does-not-exist', providerId: 'ghost-provider-does-not-exist' },
    });
  } catch (e: unknown) {
    orphanRejected = true;
    orphanErrMessage = e instanceof Error ? e.message : String(e);
  }
  assert.ok(orphanRejected, `runtime writer must reject orphan modelProvider.create() (caught: ${orphanErrMessage.slice(0, 100)})`);
  console.log('  pass: runtime writer connection rejects orphan insert (FK enforced)');

  // === Bootstrap connection must also report effective foreign_keys=ON.
  const bootstrapPrisma = getPrismaClient();
  const bootstrapPragmas = await readPragmasVia(bootstrapPrisma);
  assert.equal(bootstrapPragmas.foreignKeys, 1, `bootstrap foreign_keys=${bootstrapPragmas.foreignKeys} (must be 1)`);
  assert.ok(bootstrapPragmas.synchronous >= 1, `bootstrap synchronous=${bootstrapPragmas.synchronous} must be >= 1`);
  console.log(`  pass: bootstrap runtime connection: foreign_keys=${bootstrapPragmas.foreignKeys} synchronous=${bootstrapPragmas.synchronous}`);

  await ctx.dispose();
  await bootstrapPrisma.$disconnect();
}

run()
  .then(() => {
    console.log('All per-runtime-connection PRAGMA assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
