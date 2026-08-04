/**
 * Race worker for sqlite-mcp-tool-client OCC tests.
 *
 * Spawned as a child process by `tests/sqlite-mcp-tool-client-occ.test.ts` to
 * reproduce a true concurrent write window: two independent Node processes
 * each open a `SqliteMcpToolClient` to the same disposable SQLite file and
 * call `pmc-agent-memory_store` with `expectedVersion`. Because `node:sqlite`
 * is synchronous, the race cannot be triggered from a single process; we
 * need two OS-level processes whose reads and writes interleave at the
 * SQLite file layer.
 *
 * Inputs come from environment variables (env vars are the only cross-Node
 * IPC we need — the worker writes its result to a file the parent reads):
 *   SDD_SQLITE_OCC_DB            absolute path to the disposable DB file
 *   SDD_SQLITE_OCC_KEY           the key to write
 *   SDD_SQLITE_OCC_CONTENT       the content value (two workers use different values)
 *   SDD_SQLITE_OCC_EXPECTED      expectedVersion (0, 1, ...)
 *   SDD_SQLITE_OCC_RESULT        absolute path of the JSON file to write the result to
 *
 * The worker exits with code 0 on a successful round-trip (including
 * conflicts) and 1 on an unexpected error.
 */
import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { SqliteMcpToolClient } from "../../src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.js";

const DB = process.env.SDD_SQLITE_OCC_DB;
const KEY = process.env.SDD_SQLITE_OCC_KEY;
const CONTENT = process.env.SDD_SQLITE_OCC_CONTENT;
const EXPECTED = process.env.SDD_SQLITE_OCC_EXPECTED;
const RESULT = process.env.SDD_SQLITE_OCC_RESULT;
const BARRIER = process.env.SDD_SQLITE_OCC_BARRIER;
const WORKER = process.env.SDD_SQLITE_OCC_WORKER;

if (!DB || !KEY || CONTENT === undefined || EXPECTED === undefined || !RESULT) {
  // eslint-disable-next-line no-console
  console.error("sqlite-mcp-tool-client-occ-worker: missing required env vars");
  process.exit(1);
}

const expectedVersion = Number.parseInt(EXPECTED, 10);
if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
  // eslint-disable-next-line no-console
  console.error(`sqlite-mcp-tool-client-occ-worker: bad expectedVersion '${EXPECTED}'`);
  process.exit(1);
}

if (BARRIER && WORKER) {
  let gated = false;
  const prepare = DatabaseSync.prototype.prepare;

  // Each worker process is isolated, so patching its local prototype avoids
  // reaching into the adapter's private database field. In the legacy adapter
  // the first get() is the stale version read; in the fixed adapter it is the
  // atomic conditional statement, which still gives both workers a rendezvous.
  DatabaseSync.prototype.prepare = function prepareWithBarrier(sql: string) {
    const statement = prepare.call(this, sql);
    if (gated) {
      return statement;
    }
    gated = true;

    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property !== "get") {
          return Reflect.get(target, property, receiver);
        }
        return (...parameters: Parameters<typeof target.get>) => {
          const row = target.get(...parameters);
          writeFileSync(`${BARRIER}.${WORKER}.ready`, JSON.stringify({ pid: process.pid, phase: "first-statement-complete" }));
          // 60s matches the parent's waitForBarrier deadline with margin; the
          // parent times out first and reports both workers' diagnostics if the
          // rendezvous fails, but this guard prevents the worker from blocking
          // indefinitely on a vanished parent.
          const deadline = Date.now() + 60_000;
          const sleeper = new Int32Array(new SharedArrayBuffer(4));
          while (!existsSync(`${BARRIER}.${WORKER}.release`)) {
            if (Date.now() >= deadline) {
              throw new Error(`sqlite-mcp-tool-client OCC worker ${WORKER} timed out waiting for a parent release`);
            }
            Atomics.wait(sleeper, 0, 0, 10);
          }
          return row;
        };
      },
    });
  };
}

const client = new SqliteMcpToolClient({ dbPath: DB });

try {
  const result = await client.callTool<{ version: number; conflict?: boolean }>(
    "pmc-agent-memory_store",
    {
      key: KEY,
      content: CONTENT,
      kind: "checkpoint",
      expectedVersion,
    },
  );
  writeFileSync(RESULT, JSON.stringify(result));
} catch (err) {
  // Record the error so the parent test can surface it. This is NOT a
  // expectedVersion conflict — those are returned, not thrown.
  writeFileSync(RESULT, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
} finally {
  client.close();
}
