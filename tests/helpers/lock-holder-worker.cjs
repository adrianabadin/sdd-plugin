/**
 * Cross-process lock-holder worker for the contention-clears scenario.
 *
 * Forked by `tests/sqlite-contention.test.ts` via `child_process.fork`. The
 * worker opens its own SQLite handle (independent process + connection
 * ownership), takes `BEGIN IMMEDIATE`, performs a real INSERT to actually
 * hold the writer lock, signals the parent via IPC, then sleeps a fixed
 * `holdMs` window before `ROLLBACK`-ing and exiting.
 *
 * The fixed hold window (argv[3], default 300ms) is what guarantees the
 * parent's waiting writer actually contends: the parent's Prisma INSERT
 * starts within a few ms of receiving the `ready` signal, while the
 * holder still holds the lock for `holdMs` more milliseconds. The
 * writer's busy handler then blocks until the holder's ROLLBACK
 * publishes.
 *
 * Why a separate process: libsql's busy handler does not yield to the JS
 * event loop, so a same-process `setTimeout(release)` cannot fire while
 * the waiting writer is blocked inside the native busy handler. The
 * holder's hold window runs in a different Node process and OS thread, so
 * it executes regardless of the parent's busy-wait state.
 */
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2];
const holdMs = Number(process.argv[3] ?? 300);
const safetyTimeoutMs = Number(process.argv[4] ?? 10000);

if (!dbPath) {
  process.send({ type: "error", error: "missing dbPath argv" });
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
let released = false;
const safetyTimer = setTimeout(() => {
  if (released) return;
  try { db.exec("ROLLBACK;"); } catch { /* best-effort */ }
  try { db.close(); } catch { /* best-effort */ }
  process.exit(0);
}, safetyTimeoutMs);
if (safetyTimer && typeof safetyTimer.unref === "function") safetyTimer.unref();

try {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("BEGIN IMMEDIATE;");
  // Insert a sentinel row so the writer lock is genuinely held (BEGIN
  // IMMEDIATE alone acquires only the RESERVED marker in WAL mode; a
  // real write upgrades to the lock that blocks other writers).
  db.prepare(
    `INSERT INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES ('lock-holder-marker', 'lock-holder', 0, '2026-07-27T00:00:00.000Z');`,
  ).run();

  // Tell the parent we are holding the lock. The parent starts the waiting
  // INSERT immediately after receiving this signal.
  try {
    process.send({ type: "ready" });
  } catch {
    // parent went away — safety release above will catch it
  }

  // Hold the lock for `holdMs` so the parent's writer is guaranteed to
  // contend. The sleep is in this child process and does not depend on
  // the parent's busy handler yielding.
  setTimeout(() => {
    if (released) return;
    released = true;
    clearTimeout(safetyTimer);
    try {
      db.exec("ROLLBACK;");
    } catch (err) {
      try {
        process.send({ type: "error", error: err instanceof Error ? err.message : String(err) });
      } catch { /* parent gone */ }
      try { db.close(); } catch { /* best-effort */ }
      process.exit(1);
      return;
    }
    try {
      db.close();
    } catch {
      // best-effort
    }
    process.exit(0);
  }, holdMs);
  if (typeof setTimeout.unref === "function") {
    // Node's setTimeout does not expose unref directly; safetyTimer above is
    // already unref'd, so the holder's hold window is allowed to keep the
    // event loop alive intentionally.
  }
} catch (err) {
  try {
    process.send({ type: "error", error: err instanceof Error ? err.message : String(err) });
  } catch { /* parent gone */ }
  try { db.close(); } catch { /* best-effort */ }
  process.exit(1);
}