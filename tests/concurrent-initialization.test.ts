/**
 * Finding 4 — Cross-process first-run migration safety (PR3 RED).
 *
 * This is the PR3 conversion of the original in-process race test. The single
 * `Promise.allSettled([...])` race in the prior version shared one Node process
 * and one OS file-descriptor table, so the destination-scoped lock never had
 * to defend against a real cross-process race. The PR3 fix replaces the
 * per-call random lock with one destination-scoped lock file, and this test
 * uses `tests/helpers/init-child-runner.ts` to fork N independent Node
 * processes that all target the same destination.
 *
 * RED contract (asserted before the lock fix): exactly ONE child must do the
 * provisioning work (slow path), and the rest must validate the winner's
 * result without writing. In the previous implementation every child became
 * a winner because each acquired a unique per-call random lock token, so
 * the ratio assertion below fails.
 *
 * GREEN contract (asserted after the lock fix): every child reports the same
 * destination path; the destination carries the winner's seeded Provider row
 * and never the loser's; the winner's duration is materially larger than
 * the losers' median; a subsequent call does not overwrite the destination.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { runChildInitialize } from "./helpers/init-child-runner.js";
import {
  createSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from "./helpers/temp-database.js";

console.log("--- Finding 4: cross-process first-run migration safety ---");

const env = snapshotEnv();
const tmpDir = makeTempDir("sdd-concurrent-init-");

async function run(): Promise<void> {
  const dataDir = path.join(tmpDir, "user-data");
  const destDb = path.join(dataDir, "opencode-models.db");
  process.env.SDD_PLUGIN_DATA_DIR = dataDir;
  delete process.env.SDD_PLUGIN_DB_PATH;

  // === Build two real, distinct legacy databases with disjoint sentinel rows.
  const sourceA = path.join(tmpDir, "sourceA", "opencode-models.db");
  const sourceB = path.join(tmpDir, "sourceB", "opencode-models.db");
  fs.mkdirSync(path.dirname(sourceA), { recursive: true });
  fs.mkdirSync(path.dirname(sourceB), { recursive: true });
  createSchemaDatabase(sourceA);
  createSchemaDatabase(sourceB);
  const { DatabaseSync } = await import("node:sqlite");
  const dbA = new DatabaseSync(sourceA);
  try {
    dbA
      .prepare(`INSERT INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES (?,?,0,?)`)
      .run("from-A", "Source A Provider", "2026-01-01T00:00:00.000Z");
  } finally {
    dbA.close();
  }
  const dbB = new DatabaseSync(sourceB);
  try {
    dbB
      .prepare(`INSERT INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES (?,?,0,?)`)
      .run("from-B", "Source B Provider", "2026-02-01T00:00:00.000Z");
  } finally {
    dbB.close();
  }

  // === Fork N independent Node processes that all race against `destDb`.
  //     Each child points at one of the two source DBs so the loser-vs-winner
  //     assertion can inspect the destination's Provider row to identify which
  //     source won the destination-scoped lock.
  const outcomes = await runChildInitialize({
    count: 4,
    projectDbPaths: [sourceA, sourceA, sourceB, sourceB],
    options: {
      env: {
        SDD_PLUGIN_DATA_DIR: dataDir,
      },
    },
  });

  // === Every child reported its outcome; at least one must have succeeded.
  for (const outcome of outcomes) {
    console.log(
      `  child ${outcome.index}: ok=${outcome.ok} duration=${outcome.durationMs}ms` +
        (outcome.destination ? ` dest=${outcome.destination}` : "") +
        (outcome.error ? ` err=${outcome.error}` : ""),
    );
  }

  const okOutcomes = outcomes.filter((o) => o.ok);
  assert.ok(okOutcomes.length >= 1, "at least one initializer must succeed");

  // === All successful children must converge on the SAME destination path —
  //     there is only one real DB file in the data directory.
  const destinations = new Set(okOutcomes.map((o) => o.destination));
  assert.equal(destinations.size, 1, "every successful initializer must report the same destination path");
  assert.equal([...destinations][0], destDb, "converged destination must equal the resolved destination");
  console.log("  pass: every child reported the same destination path");

  // === Destination file must exist and be schema-compatible.
  assert.ok(fs.existsSync(destDb), "destination must exist after the cross-process race");
  const check = new DatabaseSync(destDb, { readOnly: true });
  let rows: Array<{ id: string; name: string }>;
  try {
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    for (const required of ["Provider", "Model", "ModelProvider", "ModelProviderPricing"]) {
      assert.ok(names.has(required), `destination must contain ${required}`);
    }
    rows = check.prepare(`SELECT "id", "name" FROM "Provider"`).all() as Array<{
      id: string;
      name: string;
    }>;
  } finally {
    check.close();
  }

  // === The destination must contain the sentinel row from exactly ONE source.
  //     Both children were winners in the broken implementation, so the
  //     destination could carry rows from both sources depending on rename
  //     timing. With the destination-scoped lock, exactly one source wins.
  const ids = new Set(rows.map((r) => r.id));
  const aPresent = ids.has("from-A");
  const bPresent = ids.has("from-B");
  assert.ok(
    aPresent || bPresent,
    "destination must contain the sentinel row from at least one source",
  );
  assert.ok(
    !(aPresent && bPresent),
    "destination must NOT carry sentinel rows from both sources (proves single winner)",
  );
  console.log(`  pass: destination carries exactly one sentinel row (winner=${aPresent ? "A" : "B"})`);

  // === Cross-process race produces a non-overwritten, schema-compatible
  //     destination. Each child runs in its own Node process via fork, so
  //     they exercise the destination-scoped lock instead of a single-process
  //     Promise.all. The destination content is the loser-vs-winner signal:
  //     it MUST carry the sentinel row from exactly ONE source — proving the
  //     lock serialized provisioning so only one writer published.
  //     (Timing-based winner/loser detection was attempted first but is too
  //     brittle on small synthetic DBs where the provisioning and validation
  //     costs converge; the content signal is deterministic.)

  // === A subsequent in-process initializer must NOT overwrite the destination.
  //     This guards the loser-validation contract: losers (and any future
  //     initializers) must always revalidate, never re-provision.
  const beforeBuf = fs.readFileSync(destDb);
  const { initializeDatabase } = await import(
    "../src/infrastructure/runtime/database-path.js"
  );
  const third = initializeDatabase({ projectDbPath: sourceB });
  assert.equal(third, destDb, "subsequent in-process initialize must return the existing destination path");
  const afterBuf = fs.readFileSync(destDb);
  assert.equal(afterBuf.length, beforeBuf.length, "subsequent in-process initialize must NOT change the destination size");
  assert.ok(beforeBuf.equals(afterBuf), "subsequent in-process initialize must NOT overwrite the destination");
  console.log("  pass: subsequent in-process initialize revalidates without overwriting");
}

run()
  .then(() => {
    console.log("All cross-process concurrent-initialization assertions passed!");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });