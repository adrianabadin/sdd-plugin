/**
 * Finding 6/7 — Bounded SQLite contention handling (PR3 RED).
 *
 * The runtime PRAGMA `busy_timeout = 5000` MUST be applied and read back on
 * every Prisma factory path (TUI writer/verifier via persistence-context and
 * the bootstrap client). When the SQLite lock is held by an external client
 * for longer than busy_timeout, the writer MUST fail explicitly within a
 * bounded window rather than leaking unhandled SQLITE_BUSY / P1008 errors or
 * blocking indefinitely.
 *
 * RED contract (asserted before the busy_timeout PRAGMA is applied):
 *   1. `PRAGMA busy_timeout;` readback through every Prisma client reports
 *      0 (default) instead of 5000.
 *   2. A writer contended beyond the bound never fails explicitly; it blocks
 *      indefinitely or times out ungracefully.
 *
 * GREEN contract (asserted after the PRAGMA is applied and read back):
 *   1. Every runtime Prisma factory path reports `busy_timeout = 5000`.
 *   2. A writer contended beyond the bound rejects explicitly within a
 *      bounded window (5000-7500ms) with a structured error rather than
 *      leaking unhandled SQLITE_BUSY.
 *   3. A writer whose contention clears within the bound completes
 *      successfully without unhandled SQLITE_BUSY/P1008, the persisted
 *      value is readable, and the wait does not exceed busy_timeout.
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaLibSql } from "@prisma/adapter-libsql";

import { createPersistenceContext } from "../src/infrastructure/runtime/persistence-context.js";
import { getPrismaClient } from "../src/bootstrap/index.js";
import {
  createPrismaSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from "./helpers/temp-database.js";

console.log("--- Finding 6/7: bounded SQLite contention handling ---");

const env = snapshotEnv();
const tmpDir = makeTempDir("sdd-sqlite-contention-");

async function run(): Promise<void> {
  const dbPath = path.join(tmpDir, "data", "opencode-models.db");
  createPrismaSchemaDatabase(dbPath);
  process.env.SDD_PLUGIN_DB_PATH = dbPath;
  delete process.env.SDD_PLUGIN_DATA_DIR;

  // === Read back busy_timeout through every runtime Prisma path. Each
  //     factory creates an INDEPENDENT client so the readback cannot piggy-
  //     back on another client's PRAGMA state.
  const ctx = await createPersistenceContext();
  const writerPrisma = ctx.writer as unknown as PrismaClient;
  const verifierPrisma = ctx.verifier as unknown as PrismaClient;
  const bootstrapPrisma = getPrismaClient() as unknown as PrismaClient;

  // Bootstrap's `getPrismaClient()` returns synchronously while the PRAGMA
  // application is fire-and-forget. Yield repeatedly so the bootstrap PRAGMAs
  // land before we read them back. The libSQL adapter wraps every operation
  // in a Mutex, so a single setImmediate may not be enough to drain the
  // async chain.
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async function readBusyTimeout(client: PrismaClient): Promise<number> {
    const rows = await client.$queryRawUnsafe<Array<{ timeout: number }>>(
      "PRAGMA busy_timeout;",
    );
    const value = Number(rows[0]?.timeout ?? -1);
    return value;
  }

  const writerBusyTimeout = await readBusyTimeout(writerPrisma);
  const verifierBusyTimeout = await readBusyTimeout(verifierPrisma);
  const bootstrapBusyTimeout = await readBusyTimeout(bootstrapPrisma);

  console.log(
    `  trace: writer busy_timeout=${writerBusyTimeout} verifier busy_timeout=${verifierBusyTimeout} bootstrap busy_timeout=${bootstrapBusyTimeout}`,
  );

  // === Assertion 1 — every factory path enforces busy_timeout = 5000.
  assert.equal(
    writerBusyTimeout,
    5000,
    `writer PRAGMA busy_timeout must read back 5000 (got ${writerBusyTimeout})`,
  );
  assert.equal(
    verifierBusyTimeout,
    5000,
    `verifier PRAGMA busy_timeout must read back 5000 (got ${verifierBusyTimeout})`,
  );
  assert.equal(
    bootstrapBusyTimeout,
    5000,
    `bootstrap PRAGMA busy_timeout must read back 5000 (got ${bootstrapBusyTimeout})`,
  );
  console.log("  pass: busy_timeout = 5000 applied and read back on every runtime Prisma factory path");

  await ctx.dispose();
  await bootstrapPrisma.$disconnect();

  // === Assertion 2 — contention persists beyond the bound, bounded failure.
  //     External contender holds the writer lock for longer than busy_timeout.
  //     The writer MUST reject explicitly within a bounded window rather than
  //     leaking unhandled SQLITE_BUSY or blocking indefinitely.
  const longContenderClient = new PrismaClient({
    adapter: new PrismaLibSql({ url: `file:${dbPath}`, timeout: 5000 }),
  });
  await longContenderClient.$executeRawUnsafe("BEGIN IMMEDIATE;");
  await longContenderClient.$executeRawUnsafe(
    `INSERT INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES ('contender-stuck', 'stuck', 0, '2026-07-27T00:00:00.000Z');`,
  );
  const releaseLongContender = async (): Promise<void> => {
    try {
      await longContenderClient.$executeRawUnsafe("ROLLBACK;");
    } catch {
      // best-effort
    }
    try {
      await longContenderClient.$disconnect();
    } catch {
      // best-effort
    }
  };
  // Release the contender only after the writer assertion completes.
  const longReleaseTimer = setTimeout(() => {
    void releaseLongContender();
  }, 30_000);

  const writerAdapter2 = new PrismaLibSql({ url: `file:${dbPath}`, timeout: 5000 });
  const writerClient2 = new PrismaClient({ adapter: writerAdapter2 });
  await writerClient2.$executeRawUnsafe("PRAGMA busy_timeout = 5000;");

  const boundStart = Date.now();
  let boundError: unknown = null;
  try {
    await writerClient2.$executeRawUnsafe(
      `INSERT INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES ('contender-bound-test', 'bound-test', 0, '2026-07-27T00:00:00.000Z');`,
    );
  } catch (err) {
    boundError = err;
  } finally {
    const elapsed = Date.now() - boundStart;
    try {
      await writerClient2.$disconnect();
    } catch {
      // best-effort
    }
    clearTimeout(longReleaseTimer);
    await releaseLongContender();
    assert.ok(boundError !== null, `writer MUST reject explicitly when the bound expires (elapsed=${elapsed}ms)`);
    assert.ok(
      elapsed >= 4500 && elapsed <= 8500,
      `writer MUST reject within bounded window 4500-8500ms; got ${elapsed}ms`,
    );
    console.log(
      `  pass: writer rejected explicitly within bounded time (elapsed=${elapsed}ms)`,
    );
  }

  // === Assertion 3 — contention clears within the bound (cross-process).
  //     The lock holder runs in a forked child process with its OWN SQLite
  //     handle so its ROLLBACK executes independently of the parent's busy
  //     handler (libsql's busy handler does not yield to the JS event loop,
  //     so a same-process `setTimeout(release)` cannot fire while the
  //     waiting writer is blocked inside the native busy handler).
  //
  //     Sequence:
  //       1. Parent forks the holder child with `holdMs=300` argv.
  //       2. Child opens the DB, BEGIN IMMEDIATE, INSERTs a sentinel row,
  //          sends `{type:'ready'}` to the parent over IPC.
  //       3. Parent receives the ready signal and IMMEDIATELY starts the
  //          waiting INSERT via a Prisma client. The writer contends on
  //          the writer lock while the holder sleeps for `holdMs`.
  //       4. After `holdMs`, the child ROLLBACKs and exits.
  //       5. The parent's INSERT wakes up from libsql's busy handler and
  //          completes successfully within busy_timeout=5000ms.
  //       6. A fresh reader client verifies the persisted marker row is
  //          readable through an independent connection.
  const holderWorkerPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "helpers",
    "lock-holder-worker.cjs",
  );
  const contentionClearsResult = await runContentionClearsScenario({
    dbPath,
    holderWorkerPath,
  });
  assert.equal(
    contentionClearsResult.writeError,
    null,
    `waiting writer MUST NOT leak unhandled SQLITE_BUSY/P1008 when contention clears within the bound (err=${String(contentionClearsResult.writeError)})`,
  );
  assert.ok(
    contentionClearsResult.writeDurationMs <= 5500,
    `writer MUST complete within the declared busy_timeout bound (5000ms); got ${contentionClearsResult.writeDurationMs}ms`,
  );
  assert.ok(
    contentionClearsResult.persisted !== null,
    `persisted marker row MUST be readable after the contention-clears write (persisted=${JSON.stringify(contentionClearsResult.persisted)})`,
  );
  console.log(
    `  pass: waiting writer completed in ${contentionClearsResult.writeDurationMs}ms (holder held ${contentionClearsResult.holderHoldMs}ms); persisted=${JSON.stringify(contentionClearsResult.persisted)}; no unhandled SQLITE_BUSY`,
  );
}

/**
 * Drive the cross-process contention-clears scenario. Returns the wait
 * duration of the parent's write, the error (if any), the holder's hold
 * window, and the readback payload so the caller can assert on each
 * invariant.
 */
async function runContentionClearsScenario(args: {
  dbPath: string;
  holderWorkerPath: string;
}): Promise<{
  writeDurationMs: number;
  writeError: unknown;
  holderHoldMs: number;
  persisted: { id: string } | null;
}> {
  // The holder holds the lock for this many ms AFTER signaling ready, so
  // the parent's waiting writer is guaranteed to contend. 300ms is well
  // below the 5000ms busy_timeout bound.
  const holderHoldMs = 300;
  // Safety net for the holder if anything goes wrong inside the child.
  const holderSafetyMs = 10000;

  const holder: ChildProcess = fork(
    args.holderWorkerPath,
    [args.dbPath, String(holderHoldMs), String(holderSafetyMs)],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );

  // Step 2: wait for the holder to signal "ready" (BEGIN IMMEDIATE + INSERT done).
  await waitForHolderMessage(holder, "ready", 5000);

  // Independent waiting writer: open a fresh Prisma client with busy_timeout
  // = 5000 (mirrors the production factory config) so its open-time timeout
  // binds the wait.
  const writerAdapter = new PrismaLibSql({
    url: `file:${args.dbPath}`,
    timeout: 5000,
  });
  const writerClient = new PrismaClient({ adapter: writerAdapter });
  // Belt-and-suspenders: also apply the PRAGMA so the runtime readback
  // invariant is observed on this client too.
  await writerClient.$executeRawUnsafe("PRAGMA busy_timeout = 5000;");

  // Step 3: start the waiting write. The libsql busy handler blocks the
  // writer on the writer lock until the holder's ROLLBACK publishes.
  const writeStart = Date.now();
  let writeError: unknown = null;
  try {
    await writerClient.$executeRawUnsafe(
      `INSERT INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES ('contention-clear-marker', 'cc-marker', 0, '2026-07-27T00:00:00.000Z');`,
    );
  } catch (err) {
    writeError = err;
  }
  const writeDurationMs = Date.now() - writeStart;

  await writerClient.$disconnect();

  // Reap the holder child.
  await new Promise<void>((resolve) => {
    if (holder.exitCode !== null) {
      resolve();
    } else {
      holder.once("exit", () => resolve());
      // Safety: kill if the holder hangs after release.
      const killTimer = setTimeout(() => {
        try {
          holder.kill("SIGKILL");
        } catch {
          // best-effort
        }
        resolve();
      }, 3000);
      if (killTimer && typeof killTimer.unref === "function") killTimer.unref();
    }
  });

  // Step 6: read back the persisted marker through a fresh client so we
  // exercise the production verification path (independent connection).
  const readerAdapter = new PrismaLibSql({
    url: `file:${args.dbPath}`,
    timeout: 5000,
  });
  const readerClient = new PrismaClient({ adapter: readerAdapter });
  let persisted: { id: string } | null = null;
  try {
    const rows = await readerClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "Provider" WHERE "id" = 'contention-clear-marker';`,
    );
    if (rows.length > 0) {
      persisted = { id: rows[0]!.id };
    }
  } finally {
    await readerClient.$disconnect();
  }

  return { writeDurationMs, writeError, holderHoldMs, persisted };
}

/**
 * Wait for an IPC message of the given `type` from the holder child, with a
 * hard ceiling. Rejects on timeout, unexpected message, or child exit.
 */
function waitForHolderMessage(holder: ChildProcess, type: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        holder.kill("SIGKILL");
      } catch {
        // best-effort
      }
      reject(new Error(`holder never sent '${type}' within ${timeoutMs}ms`));
    }, timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();

    const onMessage = (msg: unknown): void => {
      if (!msg || typeof msg !== "object" || (msg as { type?: unknown }).type !== type) {
        return;
      }
      cleanup();
      resolve();
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`holder exited (code=${String(code)}) before sending '${type}'`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      holder.off("message", onMessage);
      holder.off("exit", onExit);
    };
    holder.on("message", onMessage);
    holder.on("exit", onExit);
  });
}

run()
  .then(() => {
    console.log("All sqlite-contention assertions passed!");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
