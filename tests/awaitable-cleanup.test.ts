/**
 * Awaited TUI lifecycle cleanup.
 *
 * This regression drives production `tui()`. Persistence must remain alive
 * after initialization and begin shutting down only when the host invokes the
 * registered lifecycle callback. The host callback and
 * `waitForTuiShutdown()` must expose the exact same single-flight Promise.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client.js";

import { tui, waitForTuiShutdown } from "../src/tui.js";
import { createPersistenceContext } from "../src/infrastructure/runtime/persistence-context.js";
import {
  createSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from "./helpers/temp-database.js";

console.log("--- Finding 9: awaited TUI lifecycle cleanup ---");

const env = snapshotEnv();
const tmpDir = makeTempDir("sdd-await-cleanup-");

async function run(): Promise<void> {
  const dbPath = path.join(tmpDir, "data", "opencode-models.db");
  createSchemaDatabase(dbPath);
  process.env.SDD_PLUGIN_DB_PATH = dbPath;
  delete process.env.SDD_PLUGIN_DATA_DIR;

  const prismaPrototype = PrismaClient.prototype as unknown as {
    $disconnect(this: object): Promise<void>;
  };
  const originalDisconnect = prismaPrototype.$disconnect;
  const disconnects = new Map<object, number>();
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });

  prismaPrototype.$disconnect = function patchedDisconnect(this: object): Promise<void> {
    disconnects.set(this, (disconnects.get(this) ?? 0) + 1);
    return cleanupGate.then(() => originalDisconnect.call(this));
  };

  const lifecycleCallbacks: Array<() => void | Promise<void>> = [];
  const api = {
    client: {},
    keymap: { registerLayer: () => () => {} },
    ui: {
      dialog: {
        replace: () => {},
        clear: () => {},
      },
    },
    lifecycle: {
      onDispose: (callback: () => void | Promise<void>) => {
        lifecycleCallbacks.push(callback);
        return () => {};
      },
    },
  };

  try {
    await tui(api as never);

    assert.equal(
      [...disconnects.values()].reduce((total, count) => total + count, 0),
      0,
      "tui() initialization must not start persistence disposal",
    );
    assert.equal(
      waitForTuiShutdown(),
      null,
      "there is no pending shutdown Promise before host unload",
    );
    assert.equal(
      lifecycleCallbacks.length,
      2,
      "tui() registers the keymap disposer and persistence shutdown callback",
    );

    const hostShutdown = lifecycleCallbacks[1]!;
    const first = hostShutdown();
    assert.ok(first instanceof Promise, "host shutdown callback returns an awaitable Promise");
    assert.strictEqual(
      waitForTuiShutdown(),
      first,
      "waitForTuiShutdown exposes the exact Promise returned to the host",
    );

    const second = hostShutdown();
    assert.strictEqual(second, first, "repeated host unload reuses the same shutdown Promise");
    assert.equal(disconnects.size, 2, "production tui() owns writer and verifier clients");
    assert.deepEqual(
      [...disconnects.values()],
      [1, 1],
      "concurrent unload signals start each client disconnect exactly once",
    );

    releaseCleanup();
    await waitForTuiShutdown();

    const third = hostShutdown();
    assert.strictEqual(third, first, "post-settlement unload still returns the same Promise");
    assert.deepEqual(
      [...disconnects.values()],
      [1, 1],
      "settled cleanup remains exactly once per client",
    );
    console.log("  pass: production tui() defers and awaits exactly-once host-unload cleanup");

    // PR1 Task 1.1 addition: Repeated/concurrent dispose calls on a context share exactly one shutdown attempt even on failure
    let failDisconnectAttempts = 0;
    const failingPrismaStub = {
      $disconnect: async () => {
        failDisconnectAttempts++;
        throw new Error("Simulated disconnect error");
      },
    } as unknown as PrismaClient;

    const failingFactory = () => failingPrismaStub;
    const failingContext = await createPersistenceContext({ clientFactory: failingFactory });

    const p1 = failingContext.dispose();
    const p2 = failingContext.dispose();

    assert.strictEqual(p1, p2, "concurrent dispose calls share exact same promise");
    await assert.rejects(p1, /Simulated disconnect error|PersistenceContext disconnect failed/);
    await assert.rejects(p2, /Simulated disconnect error|PersistenceContext disconnect failed/);

    // 2 writer + verifier = 2 clients, attempted exactly once each (total 2 attempts)
    assert.equal(failDisconnectAttempts, 2, "repeated dispose attempts on failure do not trigger duplicate disconnect attempts");
    console.log("  pass: failing dispose is single-flight and does not duplicate attempts on retry");
  } finally {
    releaseCleanup();
    await waitForTuiShutdown()?.catch(() => undefined);
    prismaPrototype.$disconnect = originalDisconnect;
  }
}

run()
  .then(() => {
    console.log("All awaitable-cleanup assertions passed!");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });
