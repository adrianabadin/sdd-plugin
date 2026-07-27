/**
 * Minimal ambient declaration for `node:sqlite`.
 *
 * The pinned @types/node (v20) predates the synchronous SQLite API, which is
 * available at runtime on the Node version used here. Declaring only the small
 * surface the persistence tests use keeps this scoped, instead of bumping
 * @types/node as an unrelated dependency change.
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
