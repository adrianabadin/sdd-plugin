/**
 * Shared helpers for persistence tests.
 *
 * Every helper here operates strictly inside `os.tmpdir()`. No helper may read,
 * write, or create a database inside the workspace: the real project database
 * (`opencode-models.db`) must never be touched by a test run.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SCHEMA_DDL } from "../../src/infrastructure/runtime/schema-ddl.js";

/** Tables the production readiness check requires. */
export const REQUIRED_TABLES = [
  "Provider",
  "Model",
  "ModelProvider",
  "ModelProviderPricing",
] as const;

/** Create a temp directory guaranteed to live outside the workspace. */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Best-effort recursive delete (Windows may hold SQLite handles briefly). */
export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can keep a transient lock on freshly closed SQLite files.
  }
}

/**
 * Create a real SQLite database carrying the production schema.
 * Returns the created path.
 */
export function createSchemaDatabase(destPath: string): string {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const db = new DatabaseSync(destPath);
  try {
    db.exec(SCHEMA_DDL);
  } finally {
    db.close();
  }
  return destPath;
}

/**
 * Create a real SQLite database via `prisma db push`, so the Prisma client can
 * run production queries against it. Used where production Prisma wiring must
 * really execute (built-TUI Save, PRAGMA/runtime-driver probes).
 */
export function createPrismaSchemaDatabase(destPath: string): string {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Invoke the Prisma CLI through the current Node binary: spawning `npx.cmd`
  // without a shell fails with EINVAL on Windows.
  const prismaCli = path.resolve("node_modules", "prisma", "build", "index.js");
  execFileSync(
    process.execPath,
    [prismaCli, "db", "push", "--accept-data-loss", "--url", `file:${destPath}`],
    {
      stdio: "ignore",
      env: { ...process.env, DATABASE_URL: `file:${destPath}` },
    },
  );
  return destPath;
}

/** Seed identity rows (provider/model/link) required as Save preconditions. */
export function seedIdentity(
  dbPath: string,
  options: { providerId: string; modelId: string; modelProviderId: string },
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO "Provider" ("id","name","isBlocked","updatedAt") VALUES (?, ?, 0, ?)`,
    ).run(options.providerId, "seed-provider-name", now);
    db.prepare(
      `INSERT OR REPLACE INTO "Model" ("id","name","updatedAt") VALUES (?, ?, ?)`,
    ).run(options.modelId, "seed-model-name", now);
    db.prepare(
      `INSERT OR REPLACE INTO "ModelProvider" ("id","modelId","providerId") VALUES (?, ?, ?)`,
    ).run(options.modelProviderId, options.modelId, options.providerId);
  } finally {
    db.close();
  }
}

/** Read effective PRAGMA values through a fresh connection. */
export function readPragmas(dbPath: string): {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
} {
  const db = new DatabaseSync(dbPath);
  try {
    const journal = db.prepare("PRAGMA journal_mode;").get() as {
      journal_mode: string;
    };
    const sync = db.prepare("PRAGMA synchronous;").get() as {
      synchronous: number;
    };
    const fk = db.prepare("PRAGMA foreign_keys;").get() as {
      foreign_keys: number;
    };
    return {
      journalMode: String(journal.journal_mode).toLowerCase(),
      synchronous: Number(sync.synchronous),
      foreignKeys: Number(fk.foreign_keys),
    };
  } finally {
    db.close();
  }
}

/** List user tables in a SQLite file. */
export function listTables(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

/** Snapshot of persistence-related environment variables. */
export interface EnvSnapshot {
  [key: string]: string | undefined;
}

const PERSISTENCE_ENV_KEYS = [
  "SDD_PLUGIN_DB_PATH",
  "SDD_PLUGIN_DATA_DIR",
  "SDD_PLUGIN_LEGACY_DB_PATH",
  "DATABASE_URL",
  "LOCALAPPDATA",
  "XDG_DATA_HOME",
];

/** Capture persistence env vars so a test can restore them afterwards. */
export function snapshotEnv(): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of PERSISTENCE_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

/** Restore a previously captured environment snapshot. */
export function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of PERSISTENCE_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
