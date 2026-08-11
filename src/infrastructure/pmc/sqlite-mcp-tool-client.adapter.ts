/**
 * SQLite-direct implementation of `McpToolClientPort` (SS-8).
 *
 * ARCHITECTURE DECISION (Option B, pragmatic): the OpenCode plugin SDK
 * exposes no mechanism for a plugin's tool handler to invoke tools exposed by
 * OTHER MCP servers. `agent-memory-mcp` (the sole persistence backend for SDD
 * artifacts) is a separate stdio MCP server spawned by OpenCode; this plugin
 * cannot reach it over MCP. Rather than spawn a SECOND copy of that server
 * and speak JSON-RPC (Option A, faithful to SS-8's "structured MCP, no CLI
 * scraping" letter but heavy: new dependency + spawned process + lifecycle),
 * this adapter opens the SAME SQLite file `agent-memory-mcp` writes to
 * (`MEMORY_DB_PATH`, opened through the runtime-agnostic synchronous SQLite
 * handle in `../runtime/sqlite-sync.js` so the module also loads on Bun, which
 * OpenCode uses to execute plugins) and reads/writes the
 * `memories` rows directly.
 *
 * TRADE-OFF acknowledged: this couples the plugin to `agent-memory-mcp`'s
 * private table schema. The schema is stable (it has only grown additively
 * across migrations) and this adapter writes only the columns required for a
 * key/value artifact+checkpoint store (id, content, category, tags, version,
 * timestamps, status), but a breaking schema change upstream would require a
 * matching change here. The coupling is documented and localized to this one
 * file; the application layer still talks only to `SddArtifactStorePort`.
 *
 * WHAT IT IMPLEMENTS: the two tool names `PmcSddArtifactStoreAdapter` calls —
 * `pmc-agent-memory_store` and `pmc-agent-memory_recall` — with the
 * key/value contract that adapter (and its tests) already encode:
 *   store:  { key, content, kind, expectedVersion? } -> { version, conflict? }
 *   recall: { key, kind } -> { content, version }
 * `key` maps to `memories.id`; `content` to `memories.content`; `version` to
 * `memories.version` (incremented on each write, used for optimistic
 * concurrency). `kind` is recorded in `tags` for debuggability but does not
 * affect storage. The FTS triggers on `memories` keep the search index in
 * sync automatically on INSERT/REPLACE.
 */

import type { McpToolClientPort } from "../../ports/mcp-tool-client.port.js";
import { loadSqliteSyncConstructor, type SqliteSyncHandle } from "../runtime/sqlite-sync.js";

const STORE_TOOL = "pmc-agent-memory_store";
const RECALL_TOOL = "pmc-agent-memory_recall";

interface StoreArgs {
  key: string;
  content: unknown;
  kind?: string;
  expectedVersion?: number;
}

interface RecallArgs {
  key: string;
  kind?: string;
}

interface StoreResult {
  version: number;
  conflict?: boolean;
}

interface RecallResult {
  content: unknown | null;
  version: number;
}

/**
 * Resolves the SQLite file path from `MEMORY_DB_PATH`. The env var holds a
 * stem (no extension); `agent-memory-mcp`'s store-factory appends `.db`, and
 * so does this resolver. Throws if the env var is unset — the SDD surface
 * cannot operate without its persistence backend.
 */
export function resolveMemoryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const stem = env.MEMORY_DB_PATH;
  if (!stem || stem.length === 0) {
    throw new Error(
      "SDD_MEMORY_DB_UNRESOLVED: MEMORY_DB_PATH is not set; the SDD artifact store cannot locate its SQLite backend.",
    );
  }
  return stem.endsWith(".db") ? stem : `${stem}.db`;
}

export interface SqliteMcpToolClientOptions {
  /** Override the DB path (tests pass a temp file; production resolves MEMORY_DB_PATH). */
  readonly dbPath?: string;
}

export class SqliteMcpToolClient implements McpToolClientPort {
  private readonly db: SqliteSyncHandle;

  constructor(options: SqliteMcpToolClientOptions = {}) {
    const dbPath = options.dbPath ?? resolveMemoryDbPath();
    const DatabaseSync = loadSqliteSyncConstructor();
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    // Ensure the table exists (idempotent). On the real agent-memory-mcp DB
    // this is a no-op; on a fresh test DB it creates the minimal shape this
    // adapter needs. We intentionally do NOT recreate the full upstream
    // schema (FTS, embeddings, triggers) — only the base table this adapter
    // reads/writes, plus the columns the OCC write path touches.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        origin TEXT NOT NULL DEFAULT 'sdd-plugin',
        source_tool TEXT,
        session_id TEXT,
        content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        memory_state TEXT NOT NULL DEFAULT 'active',
        non_forgettable INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  async callTool<TResult = unknown>(toolName: string, args: Readonly<Record<string, unknown>>): Promise<TResult> {
    if (toolName === STORE_TOOL) {
      return this.handleStore(args as unknown as StoreArgs) as unknown as TResult;
    }
    if (toolName === RECALL_TOOL) {
      return this.handleRecall(args as unknown as RecallArgs) as unknown as TResult;
    }
    throw new Error(`SqliteMcpToolClient: unsupported tool '${toolName}'`);
  }

  /** Release the underlying SQLite handle. Safe to call once at shutdown. */
  close(): void {
    this.db.close();
  }

  /**
   * Synchronous, transaction-safe variant of `callTool`. Used inside
   * `runInTransactionSync` so the adapter can drive the SQLite-direct
   * store without an async hop. The caller MUST be inside an active
   * BEGIN ... COMMIT window. The result is the same shape as
   * `callTool`'s result, but synchronous.
   */
  rawCall<T = unknown>(toolName: string, args: Readonly<Record<string, unknown>>): T {
    if (toolName === STORE_TOOL) {
      return this.handleStore(args as unknown as StoreArgs) as unknown as T;
    }
    if (toolName === RECALL_TOOL) {
      return this.handleRecall(args as unknown as RecallArgs) as unknown as T;
    }
    throw new Error(`SqliteMcpToolClient: unsupported tool '${toolName}'`);
  }

  /**
   * Run `work` inside a single SQLite transaction (BEGIN ... COMMIT). If
   * `work` throws, ROLLBACK is issued and the error re-raised. Used by
   * `PmcSddArtifactStoreAdapter.persistArtifactWithOwnership` to wrap the
   * verify + artifact write + readback + state update in one atomic
   * operation, closing the verify-then-write TOCTOU window that a
   * concurrent same-phase reclaim could otherwise exploit.
   *
   * The `work` callback is invoked synchronously and may issue any
   * `rawCall` invocations; all such calls share the transactional view
   * for the duration of the callback.
   */
  runInTransactionSync<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback itself failed; rethrow the original error.
      }
      throw error;
    }
  }

  private handleStore(args: StoreArgs): StoreResult {
    const now = new Date().toISOString();
    const tags = JSON.stringify(args.kind ? [args.kind] : []);
    const content = typeof args.content === "string" ? args.content : JSON.stringify(args.content);

    // A conditional write must compare and mutate in one SQLite statement.
    // A read followed by an upsert lets two clients both accept the same
    // expected version and silently overwrite each other.
    if (args.expectedVersion !== undefined) {
      const updated = this.db
        .prepare(
          `UPDATE memories SET
             content = ?,
             tags = ?,
             updated_at = ?,
             last_accessed_at = ?,
             version = version + 1
           WHERE id = ? AND version = ?
           RETURNING version`,
        )
        .get(content, tags, now, now, args.key, args.expectedVersion) as
        | { version: number }
        | undefined;
      if (updated) {
        return { version: updated.version };
      }

      if (args.expectedVersion === 0) {
        const inserted = this.db
          .prepare(
            `INSERT INTO memories (id, content, category, tags, created_at, updated_at, access_count, last_accessed_at, version, origin, source_tool, status, memory_state)
             VALUES (?, ?, 'other', ?, ?, ?, 0, ?, 1, 'sdd-plugin', 'sdd-artifact-store', 'active', 'active')
             ON CONFLICT(id) DO NOTHING
             RETURNING version`,
          )
          .get(args.key, content, tags, now, now, now) as { version: number } | undefined;
        if (inserted) {
          return { version: inserted.version };
        }
      }

      const existing = this.db.prepare("SELECT version FROM memories WHERE id = ?").get(args.key) as
        | { version: number }
        | undefined;
      return { version: existing?.version ?? 0, conflict: true };
    }

    const existingForVersion = this.db.prepare("SELECT version FROM memories WHERE id = ?").get(args.key) as
      | { version: number }
      | undefined;
    const nextVersion = (existingForVersion?.version ?? 0) + 1;

    this.db
      .prepare(
        `INSERT INTO memories (id, content, category, tags, created_at, updated_at, access_count, last_accessed_at, version, origin, source_tool, status, memory_state)
         VALUES (?, ?, 'other', ?, ?, ?, 0, ?, ?, 'sdd-plugin', 'sdd-artifact-store', 'active', 'active')
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           tags = excluded.tags,
           updated_at = excluded.updated_at,
           last_accessed_at = excluded.last_accessed_at,
           version = excluded.version`,
      )
      .run(args.key, content, tags, now, now, now, nextVersion);

    return { version: nextVersion };
  }

  private handleRecall(args: RecallArgs): RecallResult {
    const row = this.db.prepare("SELECT content, version FROM memories WHERE id = ?").get(args.key) as
      | { content: string; version: number }
      | undefined;
    if (!row) {
      return { content: null, version: 0 };
    }
    // content may be JSON (checkpoints) or a raw string (artifacts). The
    // caller (PmcSddArtifactStoreAdapter) treats artifact content as a string
    // and checkpoint content as unknown (parsed by the application layer).
    let parsed: unknown = row.content;
    try {
      parsed = JSON.parse(row.content);
    } catch {
      // Not JSON — return the raw string (artifact path).
      parsed = row.content;
    }
    return { content: parsed, version: row.version };
  }
}
