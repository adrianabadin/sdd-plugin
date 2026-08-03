/**
 * Minimal ambient declaration for `node:sqlite`.
 *
 * The pinned @types/node (v20) predates the synchronous SQLite API, which is
 * available at runtime on the Node version used here (engines: >=24). Declaring
 * only the small surface consumed here keeps this scoped, instead of bumping
 * @types/node as an unrelated dependency change.
 *
 * This lives under `src/` rather than `tests/` because production code
 * (`src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.ts`) imports the
 * module, so the build program (`tsconfig.json`, which includes `src/**`) needs
 * it too. Every test program also globs `src/**`, so this single copy serves
 * all of them — do not add a second declaration elsewhere or the ambient module
 * declarations will collide.
 */
declare module "node:sqlite" {
  export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(location: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
