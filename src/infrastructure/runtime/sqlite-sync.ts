/**
 * Runtime-agnostic synchronous SQLite handle.
 *
 * The plugin runs on TWO runtimes: Node (tests, CLI, `npm run build` gates)
 * and Bun (OpenCode itself executes plugins on Bun). Node exposes
 * `node:sqlite`; Bun exposes `bun:sqlite` and does NOT provide `node:sqlite`.
 *
 * A STATIC `import ... from "node:sqlite"` therefore makes the whole module
 * graph unloadable under Bun — the host fails to load the plugin and the tool
 * surface silently never registers. Every SQLite consumer must resolve its
 * driver through this module, at call time, so the Bun branch is taken before
 * `node:sqlite` is ever requested.
 *
 * The returned constructor implements the subset of the `node:sqlite`
 * `DatabaseSync` surface this codebase uses: `exec`, `prepare(...)` with
 * `all`/`get`/`run`, and `close`.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/** Statement view shared by both runtimes. */
export interface SqliteSyncStatement {
  all(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
}

/** Handle view shared by both runtimes. */
export interface SqliteSyncHandle {
  prepare(sql: string): SqliteSyncStatement;
  exec(sql: string): void;
  close(): void;
}

export type SqliteSyncConstructor = new (
  filePath: string,
  options?: { readOnly?: boolean; readonly?: boolean },
) => SqliteSyncHandle;

/** True when the current process is Bun rather than Node. */
export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' || Boolean(process.versions.bun);
}

interface BunStatement {
  all(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
}

interface BunDatabaseHandle {
  query(sql: string): BunStatement;
  exec(sql: string): void;
  close(): void;
}

/**
 * Resolve a synchronous SQLite constructor for the current runtime.
 *
 * Throws the raw driver error; callers decide how to wrap it (for example in
 * `PersistenceReadinessError`) so error contracts stay owned by the caller.
 */
export function loadSqliteSyncConstructor(): SqliteSyncConstructor {
  if (isBunRuntime()) {
    const module = require('bun:sqlite') as { Database?: unknown };
    if (!module.Database) throw new Error('bun:sqlite did not expose Database');
    const BunDatabase = module.Database as new (
      filePath: string,
      options?: { readonly?: boolean },
    ) => BunDatabaseHandle;

    return class BunSqliteSyncAdapter implements SqliteSyncHandle {
      private readonly db: BunDatabaseHandle;

      constructor(filePath: string, options?: { readOnly?: boolean; readonly?: boolean }) {
        const readonly = options?.readOnly ?? options?.readonly;
        this.db = readonly === undefined ? new BunDatabase(filePath) : new BunDatabase(filePath, { readonly });
      }

      prepare(sql: string): SqliteSyncStatement {
        const statement = this.db.query(sql);
        return {
          all: (...args: unknown[]) => statement.all(...args),
          // `node:sqlite` yields `undefined` for an empty result while
          // `bun:sqlite` yields `null`. Normalise so callers that branch on
          // `undefined` behave identically on both runtimes.
          get: (...args: unknown[]) => statement.get(...args) ?? undefined,
          run: (...args: unknown[]) => statement.run(...args),
        };
      }

      exec(sql: string): void {
        this.db.exec(sql);
      }

      close(): void {
        this.db.close();
      }
    } as unknown as SqliteSyncConstructor;
  }

  const module = nodeRequire('node:sqlite') as { DatabaseSync?: SqliteSyncConstructor };
  if (!module.DatabaseSync) throw new Error('node:sqlite did not expose DatabaseSync');
  return module.DatabaseSync;
}
