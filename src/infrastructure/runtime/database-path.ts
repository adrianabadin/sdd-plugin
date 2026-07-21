import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared database path resolver for bootstrap, TUI, and tests.
 * Resolves opencode-models.db relative to workspace root / package root,
 * ensuring package exports have one authoritative runtime database path.
 */
export function resolveDatabasePath(): string {
  if (process.env.SDD_PLUGIN_DB_PATH) {
    return path.resolve(process.env.SDD_PLUGIN_DB_PATH);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // src/infrastructure/runtime -> ../../../opencode-models.db
  // dist/infrastructure/runtime -> ../../../opencode-models.db
  return path.resolve(__dirname, '..', '..', '..', 'opencode-models.db');
}
