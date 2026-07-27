/**
 * Cross-process initializer runner.
 *
 * The single-process `Promise.all([initializeDatabase(...), initializeDatabase(...)])`
 * race in `tests/concurrent-initialization.test.ts` is too tame: it shares one
 * Node process and one file-descriptor table, so the OS scheduler decides the
 * ordering without exercising the real cross-process race the destination-scoped
 * lock is supposed to defend against.
 *
 * This helper spawns a real Node child per initializer via `child_process.fork`
 * — Windows-friendly (no shell), inherits only the env keys the production path
 * needs, and uses IPC to deliver a structured outcome back to the parent. Each
 * child runs `initializeDatabase({projectDbPath})` against the SAME destination
 * and reports whether it threw, what it returned, and how long it took.
 *
 * The parent collects every outcome, asserts the destination exists, and proves
 * either exactly one winner wrote the file or every non-throwing participant
 * resolved on the same destination the winner produced.
 */
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InitializeDatabaseOptions } from "../../src/infrastructure/runtime/database-path.js";

export interface InitChildOutcome {
  /** 1-based index of the child that produced this outcome (for debugging). */
  readonly index: number;
  /** Whether `initializeDatabase` returned without throwing. */
  readonly ok: boolean;
  /** The destination path returned by the child, when `ok` is true. */
  readonly destination: string | undefined;
  /** The serialized error message, when `ok` is false. */
  readonly error: string | undefined;
  /** Wall-clock duration the child spent inside `initializeDatabase`. */
  readonly durationMs: number;
}

export interface RunChildInitOptions {
  /**
   * Children inherit only these env keys. The test must inject
   * `SDD_PLUGIN_DB_PATH` or `SDD_PLUGIN_DATA_DIR` so every child targets the
   * same destination directory.
   */
  readonly env?: Record<string, string | undefined>;
  /** Hard ceiling for a single child to settle. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

interface InternalRequest {
  readonly type: "initialize";
  readonly projectDbPath: string | null;
}

interface InternalResponse {
  readonly type: "result";
  readonly ok: boolean;
  readonly destination?: string;
  readonly error?: string;
  readonly durationMs: number;
}

const isWindows = process.platform === "win32";

/**
 * Run `initializeDatabase({projectDbPath})` in `count` real child Node
 * processes in parallel, each targeting the same destination directory. Returns
 * one outcome per child in spawn order.
 *
 * Children are forked from `this` script with the path-to-file URL of a tiny
 * inline worker — see `workerModulePath` below. The worker receives the source
 * DB path over IPC, executes `initializeDatabase`, and posts the structured
 * result back.
 *
 * `projectDbPaths[i]` (or `projectDbPath` if supplied once) defines the
 * source each child passes to `initializeDatabase`. Pass `null` to omit the
 * `projectDbPath` option entirely so the child resolves a legacy DB through
 * the package-root discovery path.
 */
export async function runChildInitialize(args: {
  count: number;
  /** Single source path shared by every child. */
  projectDbPath?: string | null;
  /** Per-child source paths. Overrides `projectDbPath` when supplied. */
  projectDbPaths?: Array<string | null | undefined>;
  options?: RunChildInitOptions;
}): Promise<InitChildOutcome[]> {
  const { count, options } = args;
  if (count < 1) throw new Error("runChildInitialize: count must be >= 1");
  const timeoutMs = options?.timeoutMs ?? 30_000;

  const perChildSources: Array<string | null> = [];
  for (let i = 0; i < count; i++) {
    const fromList = args.projectDbPaths?.[i];
    if (fromList !== undefined) {
      perChildSources.push(fromList ?? null);
      continue;
    }
    perChildSources.push(args.projectDbPath ?? null);
  }

  const inheritedEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(inheritedEnv)) {
    if (!ALLOWED_ENV_KEYS.has(key)) delete inheritedEnv[key];
  }
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined) delete inheritedEnv[key];
      else inheritedEnv[key] = value;
    }
  }

  const children: Array<ChildProcess> = [];
  const outcomes: InitChildOutcome[] = new Array(count);

  try {
    const ready: Array<Promise<void>> = [];
    for (let i = 0; i < count; i++) {
      const idx = i;
      const child = fork(workerModulePath, [], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: inheritedEnv,
        // Re-register the tsx loader in the child so `import('../../src/...')`
        // resolves the TypeScript source regardless of how the parent process
        // was launched (CLI vs MCP server). Without this, a child forked from a
        // parent that did NOT pass `--import tsx/esm` in its own execArgv
        // would fail to load the database-path module.
        execArgv: ["--import", "tsx/esm"],
        // Windows-safe defaults: `shell` defaults to false in `fork()` options,
        // which is exactly what we want — `shell:true` would re-spawn through
        // cmd.exe and deadlock the long-lived IPC child.
      });
      children.push(child);

      const settled = new Promise<void>((resolve, reject) => {
        const request: InternalRequest = {
          type: "initialize",
          projectDbPath: perChildSources[idx] ?? null,
        };
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`child ${idx} exceeded ${timeoutMs}ms`));
        }, timeoutMs);

        child.once("message", (msg: unknown) => {
          clearTimeout(killTimer);
          const response = msg as InternalResponse;
          if (!response || response.type !== "result") {
            reject(new Error(`child ${idx} sent unexpected payload: ${String(msg)}`));
            return;
          }
          outcomes[idx] = {
            index: idx,
            ok: response.ok,
            destination: response.destination,
            error: response.error,
            durationMs: response.durationMs,
          };
          resolve();
        });

        child.once("exit", (code) => {
          clearTimeout(killTimer);
          if (outcomes[idx] !== undefined) return;
          reject(
            new Error(
              `child ${idx} exited with code ${String(code)} before producing a result`,
            ),
          );
        });

        child.send(request);
      });
      ready.push(settled);
    }

    await Promise.all(ready);
  } finally {
    for (const child of children) {
      if (!child.killed && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  // Sanity: every slot filled.
  for (let i = 0; i < count; i++) {
    if (!outcomes[i]) throw new Error(`runChildInitialize: missing outcome for slot ${i}`);
  }
  return outcomes;
}

/** Keys persisted across the fork so the child can resolve the destination. */
const ALLOWED_ENV_KEYS = new Set([
  "SDD_PLUGIN_DB_PATH",
  "SDD_PLUGIN_DATA_DIR",
  "SDD_PLUGIN_LEGACY_DB_PATH",
  "LOCALAPPDATA",
  "XDG_DATA_HOME",
  "HOME",
  "USERPROFILE",
  "PATH",
  "PATHEXT",
  "NODE_OPTIONS",
]);

/**
 * Resolved at module load: absolute disk path to the CJS worker module that
 * forks load via `child_process.fork`. CJS so Node can launch it without
 * juggling ESM loader hooks; the worker itself loads the production
 * TypeScript source through the tsx loader passed via `execArgv`.
 *
 * `fileURLToPath` is the canonical way to translate a `file:///` URL into a
 * platform-correct disk path; `new URL(...).pathname` returns a leading-slash
 * form on Windows (`/C:/Users/...`) that `path.join`/`path.resolve` mishandle.
 */
const workerModulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "init-child-worker.cjs",
);

/**
 * The real child-side entry. Forked workers import it through the path above
 * and register an IPC handler that runs the production initializer with the
 * payload the parent sends. This avoids string-parsing init code through a
 * child eval() — every child reuses the exact production module graph.
 */
export type { InitializeDatabaseOptions };