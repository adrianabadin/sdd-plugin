/**
 * Atomic OCC test for SqliteMcpToolClient (Task 1 of
 * sdd-phase-agents-remediation-1).
 *
 * Demonstrates the check-then-upsert race the current
 * `SqliteMcpToolClient.handleStore` allows: two independent writers race
 * through the read/check, the read of the next version, and the upsert.
 * Because each statement is its own implicit transaction, both writers can
 * observe the "missing row" (or "matching version") precondition, both
 * compute `nextVersion`, and both INSERT / UPDATE — the second silently
 * overwrites the first with the same version number, and neither reports
 * a conflict.
 *
 * Because `node:sqlite` is synchronous, the race cannot be triggered from
 * a single process. We spawn two independent Node processes (each with its
 * own `SqliteMcpToolClient` pointing at the same disposable DB) so their
 * reads and writes interleave at the SQLite file layer. This is the
 * smallest, most deterministic reproduction of the race.
 *
 * OC-1: Two concurrent writers with expectedVersion=0 (creation). Exactly
 *        ONE may win; the other must report a conflict.
 * OC-2: Two concurrent writers with expectedVersion=1 on a row that already
 *        has version=1. Exactly ONE may increment to version=2; the other
 *        must report a conflict.
 *
 * RED expectation: both writers currently return {version: 1, conflict: undefined}
 *  (OC-1) or {version: 2, conflict: undefined} (OC-2) — the second upsert
 *  silently overwrites the first with the same version. Both tests fail.
 * GREEN expectation post-fix: exactly one wins, the other reports conflict.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { SqliteMcpToolClient } from "../src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.js";

const TSX_LOADER = pathToFileURL(path.resolve("node_modules", "tsx", "dist", "loader.mjs")).href;
const WORKER_PATH = path.resolve("tests/_helpers/sqlite-mcp-tool-client-occ-worker.ts");

interface WorkerResult {
  version?: number;
  conflict?: boolean;
  error?: string;
}

interface WorkerProcess {
  readonly done: Promise<void>;
  hasExited(): boolean;
  describe(): string;
  terminate(): void;
}

function spawnWorker(env: Readonly<Record<string, string>>): WorkerProcess {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, WORKER_PATH], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const worker = env.SDD_SQLITE_OCC_WORKER ?? "unknown";
  let stderr = "";
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      exitCode = code;
      signalCode = signal;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`worker ${worker} exited with code ${code}; stderr=${stderr}`));
      }
    });
  });
  // The rendezvous reports child failures with both workers' diagnostics.
  void done.catch(() => undefined);

  return {
    done,
    hasExited: () => exitCode !== null || signalCode !== null,
    describe: () =>
      `worker=${worker} pid=${child.pid ?? "unknown"} exitCode=${exitCode ?? "running"} signal=${signalCode ?? "none"} stderr=${stderr || "<empty>"}`,
    terminate: () => {
      if (!child.killed && !child.exitCode && !child.signalCode) {
        child.kill();
      }
    },
  };
}

async function readResult(path: string): Promise<WorkerResult> {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as WorkerResult;
}

async function waitForBarrier(barrierPath: string, workers: readonly WorkerProcess[]): Promise<void> {
  const readyPaths = ["a", "b"].map((worker) => `${barrierPath}.${worker}.ready`);
  // Cross-process rendezvous deadline: covers Node spawn cold-start (tsx
  // module resolution), SQLite handle open, WAL setup, and first statement
  // prepare on Windows. 30s is comfortably above observed worst-case but
  // still fails fast enough to keep CI useful.
  const deadline = Date.now() + 30_000;

  while (!readyPaths.every((readyPath) => existsSync(readyPath))) {
    const exitedWorkers = workers.filter((worker) => worker.hasExited());
    if (exitedWorkers.length > 0) {
      throw new Error(
        `OCC rendezvous failed before both workers reached the stale-read point; ready=${readyPaths.filter(existsSync).join(",") || "<none>"}; ${workers.map((worker) => worker.describe()).join(" | ")}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `OCC rendezvous timed out before both workers reached the stale-read point; no writer was released; ready=${readyPaths.filter(existsSync).join(",") || "<none>"}; ${workers.map((worker) => worker.describe()).join(" | ")}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function releaseWorkersAfterRendezvous(barrierPath: string, workers: readonly WorkerProcess[]): Promise<void> {
  try {
    await waitForBarrier(barrierPath, workers);
    // In the legacy adapter both workers are now paused after their stale
    // precondition read. Release sequentially to prove the second write does
    // not revalidate that stale result. The atomic implementation also reaches
    // this generic first-statement gate, but one statement already wins.
    writeFileSync(`${barrierPath}.a.release`, "release");
    await workers[0]?.done;
    writeFileSync(`${barrierPath}.b.release`, "release");
    await workers[1]?.done;
  } catch (error) {
    for (const worker of workers) {
      worker.terminate();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    throw error;
  }
}

/**
 * Seed a row directly into the DB so the OC-2 test starts from a known
 * state without going through the (currently racy) handleStore path.
 */
function seedRow(dbPath: string, key: string, version: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (id, content, category, tags, created_at, updated_at, access_count, last_accessed_at, version, origin, source_tool, status, memory_state)
       VALUES (?, ?, 'other', '[]', ?, ?, 0, ?, ?, 'sdd-plugin', 'sdd-artifact-store', 'active', 'active')`,
    ).run(key, "seed-content", now, now, now, version);
  } finally {
    db.close();
  }
}

async function runTests(): Promise<void> {
  console.log("--- sqlite-mcp-tool-client OCC atomicity (Task 1) ---");

  const tempDir = mkdtempSync(path.join(tmpdir(), "sdd-sqlite-occ-"));
  const dbPath = path.join(tempDir, "race-test.db");

  // Initialize the adapter schema before workers start. Worker constructors
  // must only open a ready database; concurrent CREATE TABLE is unrelated to
  // the OCC behavior under test and can fail with SQLITE_BUSY.
  const schemaClient = new SqliteMcpToolClient({ dbPath });
  schemaClient.close();

  // WAL allows a reader that has passed the OCC check to coexist with the
  // winner's write until the test releases both workers into the write path.
  {
    const setupDb = new DatabaseSync(dbPath);
    try {
      setupDb.exec("PRAGMA journal_mode = WAL;");
      setupDb.exec("PRAGMA busy_timeout = 5000;");
    } finally {
      setupDb.close();
    }
  }

  try {
    // OC-1: Two concurrent writers with expectedVersion=0 (creation race).
    // Only ONE may win; the other must report a conflict.
    {
      const resultA = path.join(tempDir, "oc1-result-a.json");
      const resultB = path.join(tempDir, "oc1-result-b.json");
      const barrier = path.join(tempDir, "oc1-barrier");
      writeFileSync(resultA, ""); // ensure the path exists for the read
      writeFileSync(resultB, "");

      const key = "race/create";
      const workers = [
        spawnWorker({
          SDD_SQLITE_OCC_DB: dbPath,
          SDD_SQLITE_OCC_KEY: key,
          SDD_SQLITE_OCC_CONTENT: "writer-A",
          SDD_SQLITE_OCC_EXPECTED: "0",
          SDD_SQLITE_OCC_RESULT: resultA,
          SDD_SQLITE_OCC_BARRIER: barrier,
          SDD_SQLITE_OCC_WORKER: "a",
        }),
        spawnWorker({
          SDD_SQLITE_OCC_DB: dbPath,
          SDD_SQLITE_OCC_KEY: key,
          SDD_SQLITE_OCC_CONTENT: "writer-B",
          SDD_SQLITE_OCC_EXPECTED: "0",
          SDD_SQLITE_OCC_RESULT: resultB,
          SDD_SQLITE_OCC_BARRIER: barrier,
          SDD_SQLITE_OCC_WORKER: "b",
        }),
      ];

      await releaseWorkersAfterRendezvous(barrier, workers);

      const a = await readResult(resultA);
      const b = await readResult(resultB);
      // eslint-disable-next-line no-console
      console.log(`    [DEBUG OC-1] a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
      assert.ok(!a.error && !b.error, `OC-1 workers must not error (a=${JSON.stringify(a)} b=${JSON.stringify(b)})`);

      const results = [a, b];
      const winners = results.filter((r) => r.conflict !== true);
      const losers = results.filter((r) => r.conflict === true);

      // RED: with the current check-then-act code, both writers observe the
      // missing row and both succeed (`conflict: undefined`), so 0 losers.
      // GREEN: after the atomic fix, exactly one gives up with conflict=true.
      assert.equal(winners.length, 1, `OC-1: exactly one writer must win (got ${winners.length})`);
      assert.equal(losers.length, 1, `OC-1: exactly one writer must report conflict (got ${losers.length})`);
      assert.equal(winners[0]?.version, 1, "OC-1: the winner's version is 1");

      // The DB must record exactly one row at version=1 with the winner's content.
      const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = verifyDb
          .prepare("SELECT content, version FROM memories WHERE id = ?")
          .all(key) as Array<{ content: string; version: number }>;
        assert.equal(rows.length, 1, "OC-1: exactly one row must exist in the DB");
        assert.equal(rows[0]?.version, 1, "OC-1: the persisted row's version is 1");
        // The winner's content must be the one that persisted (not the loser's).
        const winnerContent = winners[0] === a ? "writer-A" : "writer-B";
        assert.equal(rows[0]?.content, winnerContent, "OC-1: the winner's content is the one that persisted");
      } finally {
        verifyDb.close();
      }
    }
    console.log("  pass: OC-1 two concurrent expectedVersion=0 writers — only one wins");

    // OC-2: Stale-existing-version race. Pre-create row at version=1. Two
    // concurrent writers both expect version=1. Exactly ONE may increment to
    // version=2; the other must report a conflict.
    {
      const key = "race/existing";
      seedRow(dbPath, key, 1);

      const resultA = path.join(tempDir, "oc2-result-a.json");
      const resultB = path.join(tempDir, "oc2-result-b.json");
      const barrier = path.join(tempDir, "oc2-barrier");
      writeFileSync(resultA, "");
      writeFileSync(resultB, "");

      const workers = [
        spawnWorker({
          SDD_SQLITE_OCC_DB: dbPath,
          SDD_SQLITE_OCC_KEY: key,
          SDD_SQLITE_OCC_CONTENT: "writer-A",
          SDD_SQLITE_OCC_EXPECTED: "1",
          SDD_SQLITE_OCC_RESULT: resultA,
          SDD_SQLITE_OCC_BARRIER: barrier,
          SDD_SQLITE_OCC_WORKER: "a",
        }),
        spawnWorker({
          SDD_SQLITE_OCC_DB: dbPath,
          SDD_SQLITE_OCC_KEY: key,
          SDD_SQLITE_OCC_CONTENT: "writer-B",
          SDD_SQLITE_OCC_EXPECTED: "1",
          SDD_SQLITE_OCC_RESULT: resultB,
          SDD_SQLITE_OCC_BARRIER: barrier,
          SDD_SQLITE_OCC_WORKER: "b",
        }),
      ];

      await releaseWorkersAfterRendezvous(barrier, workers);

      const a = await readResult(resultA);
      const b = await readResult(resultB);
      assert.ok(!a.error && !b.error, `OC-2 workers must not error (a=${JSON.stringify(a)} b=${JSON.stringify(b)})`);

      const results = [a, b];
      const winners = results.filter((r) => r.conflict !== true);
      const losers = results.filter((r) => r.conflict === true);

      // RED: both writers see version=1, both pass the check, both compute
      // nextVersion=2, both INSERT...ON CONFLICT — the second overwrites the
      // first with version=2 and the same content. Both report
      // {version: 2, conflict: undefined} → 0 losers.
      assert.equal(winners.length, 1, `OC-2: exactly one writer must win (got ${winners.length})`);
      assert.equal(losers.length, 1, `OC-2: exactly one writer must report conflict (got ${losers.length})`);
      assert.equal(winners[0]?.version, 2, "OC-2: the winner's version is 2 (1+1)");

      // The DB must record exactly one row at version=2 with the winner's content.
      const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = verifyDb
          .prepare("SELECT content, version FROM memories WHERE id = ?")
          .all(key) as Array<{ content: string; version: number }>;
        assert.equal(rows.length, 1, "OC-2: exactly one row must exist in the DB");
        assert.equal(rows[0]?.version, 2, "OC-2: the persisted row's version is 2");
        const winnerContent = winners[0] === a ? "writer-A" : "writer-B";
        assert.equal(rows[0]?.content, winnerContent, "OC-2: the winner's content is the one that persisted");
      } finally {
        verifyDb.close();
      }
    }
    console.log("  pass: OC-2 two concurrent expectedVersion=1 writers on existing row — only one wins");

    console.log("All sqlite-mcp-tool-client OCC atomicity tests passed.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
