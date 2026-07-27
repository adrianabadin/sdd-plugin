import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import {
  SCHEMA_DDL,
  REQUIRED_SCHEMA_COLUMNS,
  REQUIRED_SCHEMA_INDEXES,
  REQUIRED_SCHEMA_FKS,
} from './schema-ddl.js';
const nodeRequire = createRequire(import.meta.url);

type SqliteDatabaseConstructor = new (filePath: string, options?: { readOnly?: boolean; readonly?: boolean }) => SqliteWriteHandle;

function loadSqliteDatabaseConstructor(): SqliteDatabaseConstructor {
  try {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' || Boolean(process.versions.bun)) {
      const module = require('bun:sqlite') as { Database?: SqliteDatabaseConstructor };
      if (!module.Database) throw new Error('bun:sqlite did not expose Database');
      const BunDatabase = module.Database as unknown as new (filePath: string, options?: { readonly?: boolean }) => {
        query(sql: string): { all(...args: unknown[]): unknown; get(...args: unknown[]): unknown };
        exec(sql: string): void;
        close(): void;
      };
      return class BunSqliteAdapter {
        private readonly db: InstanceType<typeof BunDatabase>;
        constructor(filePath: string, options?: { readOnly?: boolean; readonly?: boolean }) {
          const readonly = options?.readOnly ?? options?.readonly;
          this.db = readonly === undefined ? new BunDatabase(filePath) : new BunDatabase(filePath, { readonly });
        }
        prepare(sql: string) {
          const query = this.db.query(sql);
          return { all: (...args: unknown[]) => query.all(...args), get: (...args: unknown[]) => query.get(...args) };
        }
        exec(sql: string) { this.db.exec(sql); }
        close() { this.db.close(); }
      } as unknown as SqliteDatabaseConstructor;
    }
    const module = nodeRequire('node:sqlite') as { DatabaseSync?: SqliteDatabaseConstructor };
    if (!module.DatabaseSync) throw new Error('node:sqlite did not expose DatabaseSync');
    return module.DatabaseSync;
  } catch (cause) {
    throw new PersistenceReadinessError('SQLite runtime is unavailable. Install a runtime with node:sqlite or bun:sqlite support.', { cause });
  }
}

/**
 * Shared database path resolver for bootstrap, TUI, and tests.
 * Precedence:
 * 1. SDD_PLUGIN_DB_PATH (explicit file path)
 * 2. SDD_PLUGIN_DATA_DIR (directory, appends opencode-models.db)
 * 3. Platform user-data directory default (Windows %LOCALAPPDATA%, macOS Library/Application Support, XDG_DATA_HOME/Linux)
 */
export function resolveDatabasePath(): string {
  if (process.env.SDD_PLUGIN_DB_PATH) {
    return path.resolve(process.env.SDD_PLUGIN_DB_PATH);
  }

  if (process.env.SDD_PLUGIN_DATA_DIR) {
    return path.resolve(process.env.SDD_PLUGIN_DATA_DIR, 'opencode-models.db');
  }

  let dataDir: string;
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    dataDir = path.join(localAppData, 'sdd-plugin');
  } else if (process.platform === 'darwin') {
    dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'sdd-plugin');
  } else {
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    dataDir = path.join(xdgData, 'sdd-plugin');
  }

  return path.join(dataDir, 'opencode-models.db');
}

/**
 * Walks upward from startDir (or module location) looking for package.json,
 * and checks if an opencode-models.db exists at that package root.
 */
export function findLegacyProjectDatabase(startDir: string = process.cwd()): string | null {
  let curr = path.resolve(startDir);
  const root = path.parse(curr).root;

  while (curr && curr !== root) {
    const pkgJson = path.join(curr, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const candidate = path.join(curr, 'opencode-models.db');
      if (fs.existsSync(candidate) && isValidSqliteDatabase(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

export interface InitializeDatabaseOptions {
  projectDbPath?: string;
}

/** Tables that must exist before a database file is considered usable. */
export const REQUIRED_SCHEMA_TABLES = [
  'Provider',
  'Model',
  'ModelProvider',
  'ModelProviderPricing',
] as const;

/**
 * Effective PRAGMA values observed on a connection after configuration.
 *
 * `journalMode` is persisted in the database file itself, so it is a durable
 * guarantee. `synchronous` and `foreignKeys` are per-connection settings and
 * must be re-applied by every runtime connection.
 */
export interface PragmaState {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
}

/** Minimal structural view of the `node:sqlite` handles used here. */
interface SqliteReadHandle {
  prepare(sql: string): { all(...args: unknown[]): unknown; get(...args: unknown[]): unknown };
  close(): void;
}

interface SqliteWriteHandle extends SqliteReadHandle {
  exec(sql: string): void;
}

/** Close a SQLite handle without masking the original control flow. */
function closeQuietly(db: { close(): void }): void {
  try {
    db.close();
  } catch {
    // Connection already invalid; nothing further to release.
  }
}

/** Raised when the persistence layer cannot establish its durability contract. */
export class PersistenceReadinessError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'PersistenceReadinessError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Additive schema migrations applied to existing databases on startup.
 *
 * Each migration is idempotent and additive only: a missing column is
 * added as NULL, an already-present column is left untouched, and never
 * a destructive change is performed. Runtime migrations exist because
 * the published `dist/` package does not include `prisma/migrations/`
 * (only `dist/schema-ddl.js`), so a fresh Prisma `db push` cannot run
 * against a destination the user already provisioned. Without this step,
 * `assertValidSqliteDatabase` would reject every existing DB that
 * predates the `quarantineReason` columns, even though the only gap is
 * the new nullable column.
 *
 * Adding a new migration: append an entry to `RUNTIME_ADDITIVE_MIGRATIONS`
 * with a unique `id`, the `table` it touches, the column to add, and the
 * `pragma_table_info` row check that proves the migration already ran.
 * The migration framework will skip the step on a DB that already
 * exposes the column, and apply it otherwise. Never make these steps
 * destructive (DROP, RENAME, type changes, NOT NULL additions) — those
 * require a coordinated Prisma migration and runtime release.
 */
const RUNTIME_ADDITIVE_MIGRATIONS: ReadonlyArray<{
  readonly id: string;
  readonly table: string;
  readonly column: string;
  readonly ddl: string;
}> = [
  {
    id: '20260727000000_add_quarantine_reason',
    table: 'Provider',
    column: 'quarantineReason',
    ddl: 'ALTER TABLE "Provider" ADD COLUMN "quarantineReason" TEXT',
  },
  {
    id: '20260727000000_add_quarantine_reason',
    table: 'Model',
    column: 'quarantineReason',
    ddl: 'ALTER TABLE "Model" ADD COLUMN "quarantineReason" TEXT',
  },
  {
    id: '20260727000000_add_quarantine_reason',
    table: 'ModelProvider',
    column: 'quarantineReason',
    ddl: 'ALTER TABLE "ModelProvider" ADD COLUMN "quarantineReason" TEXT',
  },
];

/**
 * Apply every idempotent additive migration. The DB is opened in write
 * mode; if any migration throws, the helper closes the handle and
 * re-raises so `initializeDatabase` can surface a structured readiness
 * error. Already-applied migrations are skipped via a `pragma_table_info`
 * probe so re-runs (e.g. a second startup after the first one already
 * upgraded the DB) are a no-op.
 */
export function applyAdditiveMigrations(filePath: string): void {
  const Database = loadSqliteDatabaseConstructor();
  const db = new Database(filePath) as SqliteWriteHandle;
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    for (const migration of RUNTIME_ADDITIVE_MIGRATIONS) {
      // Idempotency probe: skip when the column already exists. This is
      // the only check the framework performs; destructive changes are
      // intentionally absent.
      const probe = db.prepare(
        `SELECT 1 AS hit FROM pragma_table_info('${migration.table}') WHERE "name" = ?`,
      );
      const present = probe.get(migration.column) as { hit?: number } | undefined;
      if (present && Number(present.hit ?? 0) === 1) {
        continue;
      }
      // The table MUST already exist (else we are not in a valid
      // database). `assertValidSqliteDatabase` runs after this helper
      // and enforces that.
      db.exec(migration.ddl);
    }
  } finally {
    closeQuietly(db);
  }
}

/**
 * Validates database file existence, SQLite header ('SQLite format 3\0'),
 * PRAGMA foreign_keys, WAL/synchronous configuration, and required Prisma schema tables
 * (Provider, Model, ModelProvider, ModelProviderPricing).
 */
export function isValidSqliteDatabase(filePath: string): boolean {
  try {
    assertValidSqliteDatabase(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertValidSqliteDatabase(filePath: string): void {
  if (!fs.existsSync(filePath)) throw new PersistenceReadinessError(`Database file does not exist: ${filePath}`);
  const stats = fs.statSync(filePath);
  if (stats.size < 100) throw new PersistenceReadinessError(`Database file is too small to be SQLite: ${filePath}`);
  const buffer = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buffer, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (buffer.toString('utf8', 0, 15) !== 'SQLite format 3') {
    throw new PersistenceReadinessError(`Database file is not SQLite: ${filePath}`);
  }
  try {
    const Database = loadSqliteDatabaseConstructor();
    const db = new Database(filePath, { readOnly: true });
    try {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
      for (const table of REQUIRED_SCHEMA_TABLES) {
        if (!tables.has(table)) {
          throw new PersistenceReadinessError(
            `Database is missing required table '${table}'. Remediation: delete destination file at ${filePath} or migrate using DDL.`,
          );
        }
      }

      for (const spec of REQUIRED_SCHEMA_COLUMNS) {
        const stmt = db.prepare(`SELECT 1 AS hit FROM pragma_table_info('${spec.table}') WHERE "name" = ?`);
        const result = stmt.get(spec.column) as { hit?: number } | undefined;
        if (!result || Number(result.hit ?? 0) !== 1) {
          throw new PersistenceReadinessError(
            `Database table '${spec.table}' is missing required column '${spec.column}'. Remediation: delete destination file at ${filePath} or migrate using DDL.`,
          );
        }
      }

      const indexRows = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
      const indexNames = new Set(indexRows.map((r) => r.name));
      for (const idxSpec of REQUIRED_SCHEMA_INDEXES) {
        if (!indexNames.has(idxSpec.name)) {
          throw new PersistenceReadinessError(
            `Database table '${idxSpec.table}' is missing required index/unique constraint '${idxSpec.name}'. Remediation: delete destination file at ${filePath} or migrate using DDL.`,
          );
        }
      }

      for (const fkSpec of REQUIRED_SCHEMA_FKS) {
        const fkRows = db.prepare(`SELECT "from" FROM pragma_foreign_key_list('${fkSpec.table}')`).all() as Array<{ from: string }>;
        const fkCols = new Set(fkRows.map((r) => r.from));
        if (!fkCols.has(fkSpec.foreignKey)) {
          throw new PersistenceReadinessError(
            `Database table '${fkSpec.table}' is missing required foreign key constraint on '${fkSpec.foreignKey}'. Remediation: delete destination file at ${filePath} or migrate using DDL.`,
          );
        }
      }

    } finally { closeQuietly(db); }
  } catch (cause) {
    if (cause instanceof PersistenceReadinessError) throw cause;
    throw new PersistenceReadinessError(`SQLite readiness inspection failed for ${filePath}.`, { cause });
  }
  if (!isSchemaCompatible(filePath)) throw new PersistenceReadinessError(`Database schema is incompatible: ${filePath}`);
}

/**
 * Validate the destination path against expected tables/columns/indexes.
 * Fails closed (returns false) when schema compatibility cannot be confirmed.
 *
 * This is what callers should use before trusting an existing destination
 * that another process/race may have produced.
 */
export function isSchemaCompatible(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  let Database: SqliteDatabaseConstructor;
  try { Database = loadSqliteDatabaseConstructor(); } catch { return false; }
  let db: SqliteReadHandle;
  try {
    db = new Database(filePath, { readOnly: true }) as SqliteReadHandle;
  } catch {
    return false;
  }
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tables = new Set(rows.map((r) => r.name));
    for (const t of REQUIRED_SCHEMA_TABLES) {
      if (!tables.has(t)) return false;
    }

    // Check all required columns across all tables
    for (const spec of REQUIRED_SCHEMA_COLUMNS) {
      const stmt = db.prepare(`SELECT 1 AS hit FROM pragma_table_info('${spec.table}') WHERE "name" = ?`);
      const result = stmt.get(spec.column) as { hit?: number } | undefined;
      if (!result || Number(result.hit ?? 0) !== 1) return false;
    }

    // Check required indexes / unique constraints
    const indexRows = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    const indexNames = new Set(indexRows.map((r) => r.name));
    for (const idxSpec of REQUIRED_SCHEMA_INDEXES) {
      if (!indexNames.has(idxSpec.name)) return false;
    }

    // Check required FK constraints via pragma_foreign_key_list
    for (const fkSpec of REQUIRED_SCHEMA_FKS) {
      const fkRows = db.prepare(`SELECT "from" FROM pragma_foreign_key_list('${fkSpec.table}')`).all() as Array<{ from: string }>;
      const fkCols = new Set(fkRows.map((r) => r.from));
      if (!fkCols.has(fkSpec.foreignKey)) return false;
    }

    return true;
  } catch {
    return false;
  } finally {
    closeQuietly(db);
  }
}

/**
 * Acquire an exclusive creator lock on a sibling marker file.
 *
 * Writes a JSON payload containing the owner's PID and started-at timestamp so
 * losers can attribute the lock and detect stale owners. The caller MUST pass
 * a destination-scoped path (one file per destination); per-call random lock
 * files would let every initializer "win" and overwrite one another's
 * destination.
 */
function acquireExclusiveLock(
  markerPath: string,
  owner: { pid: number; startedAt: number },
): { release(): void; owns: boolean } {
  try {
    const fd = fs.openSync(markerPath, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify(owner));
    } finally {
      fs.closeSync(fd);
    }
    return {
      owns: true,
      release: () => {
        try {
          fs.unlinkSync(markerPath);
        } catch {
          // Best-effort: lock is advisory and short-lived.
        }
      },
    };
  } catch {
    return { owns: false, release: () => undefined };
  }
}

/**
 * Read the JSON owner payload currently recorded in `markerPath`, or `null`
 * if the file does not exist or cannot be parsed. Best-effort: malformed
 * payloads are treated as "owner unknown" so losers fall back to mtime-based
 * staleness detection.
 */
function readLockOwner(markerPath: string): { pid: number; startedAt: number } | null {
  try {
    const raw = fs.readFileSync(markerPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'pid' in parsed &&
      'startedAt' in parsed &&
      typeof (parsed as { pid: unknown }).pid === 'number' &&
      typeof (parsed as { startedAt: unknown }).startedAt === 'number'
    ) {
      return parsed as { pid: number; startedAt: number };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Touch the lock file's mtime so a live winner keeps publishing its heartbeat.
 * Losers use this signal to detect staleness and decide whether to take over.
 */
function heartbeatLock(markerPath: string): void {
  const now = new Date();
  try {
    fs.utimesSync(markerPath, now, now);
  } catch {
    // Lock may have been released concurrently; the next loop iteration
    // re-evaluates ownership from scratch.
  }
}

/** Lock timing constants. See design rev 2 §8. */
const INIT_LOCK_STALE_MS = 30_000; // 30s: a winner is presumed dead.
const INIT_LOCK_WAIT_TIMEOUT_MS = 5_000; // 5s: loser sleep-poll window.
const INIT_LOCK_POLL_MS = 25; // 25ms: loser sleep granularity.
const INIT_LOCK_HEARTBEAT_MS = 1_000; // 1s: winner heartbeat cadence.

/**
 * Sleep the loser thread for `ms` milliseconds. Centralized so the polling
 * cadence is observable in tests and refactors can swap to a fake clock.
 */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  // Busy-wait fallback when Atomics.wait is unavailable (older Node). Losers
  // wait at most 5s and the cadence is 25ms, so a busy-wait is acceptable.
  while (Date.now() < end) {
    // Yield to the event loop occasionally.
  }
}

/**
 * Configure durability and referential-integrity PRAGMAs. See header docs.
 */
export function configurePragmas(filePath: string): PragmaState {
  const Database = loadSqliteDatabaseConstructor();
  let db: SqliteWriteHandle;
  try {
    db = new Database(filePath) as SqliteWriteHandle;
  } catch (err) {
    throw new PersistenceReadinessError(
      `Persistence PRAGMA configuration failed for ${filePath}.`,
      { cause: err },
    );
  }
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = FULL;');

    const journal = db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
    const sync = db.prepare('PRAGMA synchronous;').get() as { synchronous: number };
    const fk = db.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number };

    const state: PragmaState = {
      journalMode: String(journal.journal_mode).toLowerCase(),
      synchronous: Number(sync.synchronous),
      foreignKeys: Number(fk.foreign_keys),
    };

    if (state.journalMode !== 'wal') {
      throw new PersistenceReadinessError(
        `Persistence durability not established for ${filePath}: expected journal_mode=wal, got ${state.journalMode}.`,
      );
    }
    if (state.synchronous !== 2) {
      throw new PersistenceReadinessError(
        `Persistence durability not established for ${filePath}: expected synchronous=2 (FULL), got ${state.synchronous}.`,
      );
    }
    if (state.foreignKeys !== 1) {
      throw new PersistenceReadinessError(
        `Persistence integrity not established for ${filePath}: expected foreign_keys=1, got ${state.foreignKeys}.`,
      );
    }

    return state;
  } catch (err) {
    if (err instanceof PersistenceReadinessError) throw err;
    throw new PersistenceReadinessError(
      `Persistence PRAGMA configuration failed for ${filePath}.`,
      { cause: err },
    );
  } finally {
    closeQuietly(db);
  }
}

/**
 * Perform a WAL-safe atomic snapshot/copy of sourcePath to destPath.
 */
export function copyDatabaseWalSafe(sourcePath: string, destPath: string): void {
  const Database = loadSqliteDatabaseConstructor();
  const copyWithSidecars = (): void => {
    fs.copyFileSync(sourcePath, destPath);
    const walFile = `${sourcePath}-wal`;
    const shmFile = `${sourcePath}-shm`;
    if (fs.existsSync(walFile)) fs.copyFileSync(walFile, `${destPath}-wal`);
    if (fs.existsSync(shmFile)) fs.copyFileSync(shmFile, `${destPath}-shm`);
  };

  let srcDb: SqliteWriteHandle;
  try {
    srcDb = new Database(sourcePath, { readOnly: true }) as SqliteWriteHandle;
  } catch {
    copyWithSidecars();
    return;
  }

  try {
    // VACUUM INTO produces a consistent, WAL-checkpointed single-file snapshot,
    // so committed data living only in the -wal sidecar is included.
    const escapedDest = destPath.replace(/'/g, "''");
    srcDb.exec(`VACUUM INTO '${escapedDest}'`);
  } catch {
    copyWithSidecars();
  } finally {
    closeQuietly(srcDb);
  }
}

/**
 * One-time atomic initialization / migration function.
 * Ensures destination directory exists.
 * If destination file exists: validates schema readiness, configures PRAGMAs, returns path.
 * If destination file is absent: attempts WAL-safe atomic copy/rename from projectDbPath or auto-discovered legacy DB.
 * If neither destination nor source exists, provisions the bundled schema.
 */
export function initializeDatabase(options: InitializeDatabaseOptions = {}): string {
  const destPath = resolveDatabasePath();
  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true });

  if (fs.existsSync(destPath)) {
    // Additive runtime migration runs BEFORE readiness validation so an
    // existing DB that predates the `quarantineReason` columns is upgraded
    // in place (idempotent, NULL default) and passes the column probe the
    // validator performs. Without this step, every existing stable DB
    // would be permanently rejected.
    try { applyAdditiveMigrations(destPath); }
    catch (cause) {
      throw new PersistenceReadinessError(
        `Persistence initialization failed: runtime migration could not upgrade destination database at ${destPath}.`,
        { cause },
      );
    }
    try { assertValidSqliteDatabase(destPath); }
    catch (cause) {
      throw new PersistenceReadinessError(`Persistence initialization failed for destination database at ${destPath}.`, { cause });
    }
    configurePragmas(destPath);
    return destPath;
  }

  // Resolve the migration source, most explicit first:
  //   1. caller-provided path,
  //   2. SDD_PLUGIN_LEGACY_DB_PATH (explicit operator/test override),
  //   3. package-root discovery (the production default).
  const explicitSource = options.projectDbPath ? path.resolve(options.projectDbPath) : null;
  const envSource = process.env.SDD_PLUGIN_LEGACY_DB_PATH
    ? path.resolve(process.env.SDD_PLUGIN_LEGACY_DB_PATH)
    : null;
  const hasExplicitSource = Boolean(options.projectDbPath || process.env.SDD_PLUGIN_LEGACY_DB_PATH);
  const sourcePath = explicitSource ?? envSource ?? findLegacyProjectDatabase();

  if (sourcePath) {
    if (isValidSqliteDatabase(sourcePath)) {
    // === Destination-scoped exclusive lock ===
    // Every initializer targeting the same destination competes for one
    // fixed marker file (`destDir/.opencode-models.db.init.lock`). The winner
    // provisions; losers sleep-poll the marker, validate the destination the
    // winner produced, and never overwrite it. A heartbeat keeps the marker
    // mtime fresh while the winner publishes; losers use mtime staleness
    // against INIT_LOCK_STALE_MS to detect dead owners and take over.
    const lockPath = path.join(destDir, '.opencode-models.db.init.lock');
    const owner = { pid: process.pid, startedAt: Date.now() };
    const lock = acquireExclusiveLock(lockPath, owner);
    let published = '';
    try {
      if (lock.owns) {
        // === Winner path ===
        // Re-check that the destination does not exist (a competing winner may
        // have raced to publish and removed their marker before we observed).
        if (fs.existsSync(destPath)) {
          published = destPath;
        } else {
          const tmpPath = path.join(destDir, `.tmp-migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
          let heartbeatTimer: NodeJS.Immediate | NodeJS.Timeout | null = null;
          try {
            // Heartbeat keeps the lock mtime fresh while provisioning so
            // concurrent losers can distinguish a live winner from a stale
            // crashed owner. INIT_LOCK_HEARTBEAT_MS bounds the cadence.
            heartbeatTimer = setInterval(() => heartbeatLock(lockPath), INIT_LOCK_HEARTBEAT_MS);
            if (typeof heartbeatTimer === 'object' && heartbeatTimer !== null && 'unref' in heartbeatTimer) {
              (heartbeatTimer as { unref(): unknown }).unref();
            }
            copyDatabaseWalSafe(sourcePath, tmpPath);
            configurePragmas(tmpPath);
            try {
              fs.renameSync(tmpPath, destPath);
            } catch (err) {
              if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
              if (!fs.existsSync(destPath)) throw err;
            }
            configurePragmas(destPath);
            published = destPath;
          } catch (err) {
            // If a competing initializer produced the destination while we
            // were preparing, fall through to revalidation rather than fail.
            if (fs.existsSync(destPath)) {
              published = destPath;
            } else {
              throw err;
            }
          } finally {
            if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
          }
        }
      } else {
        // === Loser path === sleep-poll the marker up to
        //     INIT_LOCK_WAIT_TIMEOUT_MS. If the winner releases early the
        //     destination will exist; otherwise we re-evaluate the marker
        //     mtime once against INIT_LOCK_STALE_MS to decide takeover.
        const waitStart = Date.now();
        while (!fs.existsSync(destPath) && Date.now() - waitStart < INIT_LOCK_WAIT_TIMEOUT_MS) {
          sleepSync(INIT_LOCK_POLL_MS);
        }

        if (!fs.existsSync(destPath)) {
          // The wait window expired without a destination appearing. Probe
          // the marker mtime once: if it is older than INIT_LOCK_STALE_MS,
          // the owner is presumed dead and we take over by acquiring the
          // same fixed lock path. Otherwise the owner is still alive and we
          // fail loudly so the operator can investigate.
          let markerStat: fs.Stats | null = null;
          try {
            markerStat = fs.statSync(lockPath);
          } catch {
            markerStat = null;
          }
          if (markerStat === null) {
            // The marker was released without producing a destination; the
            // original winner failed mid-provisioning. Take over and try
            // again from scratch.
            const takeoverLock = acquireExclusiveLock(lockPath, owner);
            if (takeoverLock.owns) {
              const tmpPath = path.join(
                destDir,
                `.tmp-migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
              );
              let takeoverHeartbeat: NodeJS.Immediate | NodeJS.Timeout | null = null;
              try {
                takeoverHeartbeat = setInterval(() => heartbeatLock(lockPath), INIT_LOCK_HEARTBEAT_MS);
                if (typeof takeoverHeartbeat === 'object' && takeoverHeartbeat !== null && 'unref' in takeoverHeartbeat) {
                  (takeoverHeartbeat as { unref(): unknown }).unref();
                }
                copyDatabaseWalSafe(sourcePath, tmpPath);
                configurePragmas(tmpPath);
                try {
                  fs.renameSync(tmpPath, destPath);
                } catch (err) {
                  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                  if (!fs.existsSync(destPath)) throw err;
                }
                configurePragmas(destPath);
                published = destPath;
              } finally {
                if (takeoverHeartbeat !== null) clearInterval(takeoverHeartbeat);
                takeoverLock.release();
              }
            } else {
              throw new PersistenceReadinessError(
                `Persistence initialization failed: existing initializer held the lock at ${lockPath} but produced no destination within ${INIT_LOCK_WAIT_TIMEOUT_MS}ms.`,
              );
            }
          } else {
            const markerAgeMs = Date.now() - markerStat.mtimeMs;
            if (markerAgeMs > INIT_LOCK_STALE_MS) {
              // Stale owner: take over via a fresh `wx` open. If another
              // process has already taken over, fall through to revalidation.
              const takeoverLock = acquireExclusiveLock(lockPath, owner);
              if (takeoverLock.owns) {
                const tmpPath = path.join(
                  destDir,
                  `.tmp-migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
                );
                let takeoverHeartbeat: NodeJS.Immediate | NodeJS.Timeout | null = null;
                try {
                  takeoverHeartbeat = setInterval(() => heartbeatLock(lockPath), INIT_LOCK_HEARTBEAT_MS);
                  if (typeof takeoverHeartbeat === 'object' && takeoverHeartbeat !== null && 'unref' in takeoverHeartbeat) {
                    (takeoverHeartbeat as { unref(): unknown }).unref();
                  }
                  copyDatabaseWalSafe(sourcePath, tmpPath);
                  configurePragmas(tmpPath);
                  try {
                    fs.renameSync(tmpPath, destPath);
                  } catch (err) {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                    if (!fs.existsSync(destPath)) throw err;
                  }
                  configurePragmas(destPath);
                  published = destPath;
                } finally {
                  if (takeoverHeartbeat !== null) clearInterval(takeoverHeartbeat);
                  takeoverLock.release();
                }
              } else {
                throw new PersistenceReadinessError(
                  `Persistence initialization failed: concurrent initializer is provisioning at ${destPath}; try again.`,
                );
              }
            } else {
              const liveOwner = readLockOwner(lockPath);
              throw new PersistenceReadinessError(
                `Persistence initialization failed: another initializer (pid=${liveOwner?.pid ?? 'unknown'}) holds the destination-scoped lock at ${lockPath}; try again.`,
              );
            }
          }
        }
      }

      if (!published) {
        published = fs.existsSync(destPath) ? destPath : '';
      }

      if (!published) {
        throw new Error(
          `Persistence initialization failed: race produced no usable destination at ${destPath}`,
        );
      }
      // The copy may have come from a legacy DB that predates the
      // `quarantineReason` columns. Apply the additive migration before
      // the readiness validation so a stable existing DB is upgraded in
      // place rather than rejected.
      try { applyAdditiveMigrations(published); }
      catch (cause) {
        throw new PersistenceReadinessError(
          `Persistence initialization failed: runtime migration could not upgrade destination database at ${published}.`,
          { cause },
        );
      }
      if (!isValidSqliteDatabase(published)) {
        throw new Error(
          `Persistence initialization failed: race produced no usable destination at ${destPath}`,
        );
      }
      configurePragmas(published);
      return published;
    } finally {
      lock.release();
    }
    } else if (hasExplicitSource) {
      throw new PersistenceReadinessError(`Persistence initialization failed: No valid database found at source ${sourcePath}.`);
    }
  }

  // Provision fresh database from bundled SCHEMA_DDL when no source/destination exists.
  // Build it off-destination, then publish atomically so a failed DDL execution cannot
  // leave a partially initialized file that future startups mistake for a database.
  const Database = loadSqliteDatabaseConstructor();
  const tmpPath = path.join(destDir, `.tmp-schema-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let freshDb: SqliteWriteHandle | undefined;
  try {
    freshDb = new Database(tmpPath) as SqliteWriteHandle;
    freshDb.exec(SCHEMA_DDL);
    closeQuietly(freshDb);
    freshDb = undefined;
    configurePragmas(tmpPath);
    assertValidSqliteDatabase(tmpPath);
    fs.renameSync(tmpPath, destPath);
  } catch (cause) {
    if (freshDb) closeQuietly(freshDb);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw new PersistenceReadinessError(
      `Persistence initialization failed while provisioning schema at ${destPath}.`,
      { cause },
    );
  }
  configurePragmas(destPath);
  return destPath;
}
