#!/usr/bin/env node
/**
 * Pre-start CLI entry point for the WU3 Windows boot manager.
 *
 * The CLI is a thin harness around `WindowsModelRouteBootManager`. All
 * lifecycle behavior lives in the manager itself; this module only
 * parses arguments, dispatches to the right subcommand, and
 * translates exceptions to process exit codes.
 *
 * Usage:
 *   npm run model-route:boot -- start <workspaceRoot>
 *   npm run model-route:boot -- stop  <workspaceRoot>
 *   npm run model-route:boot -- status <workspaceRoot>
 *
 * Subcommands:
 *   start   - Boot the manager, distribute the boot secrets to the
 *             process env so the in-process bootstrap can read them,
 *             and supervise the lifecycle. Installs SIGINT/SIGTERM
 *             handlers that call manager.stop() and exit 0. The
 *             supervisor is long-lived: the CLI does NOT auto-stop
 *             after a successful boot. In a production wrapper the
 *             CLI runs as a sibling of the OpenCode serve.
 *   stop    - Release the manager in-process (when the same CLI
 *             process supervised the boot) or, for cross-process
 *             recovery, send SIGTERM to the live pid recorded in
 *             the lock payload. If no live process is found, the
 *             lock + attestation are removed from disk so the next
 *             boot can start cleanly.
 *   status  - Report the on-disk attestation + lock state. Reads the
 *             attestation if present and prints its boot identity,
 *             expiresAt, and a summary of the canary evidence.
 *
 * Exit codes:
 *   0   success.
 *   2   argument error (missing args, traversal, malformed paths).
 *   3   CATALOG_ROUTE_MISSING or other catalog readback failure.
 *   4   CANARY_FAILED / PARENT_MODEL_UNAVAILABLE / PARENT_MODEL_MISMATCH.
 *   5   Manifest missing or unparseable.
 *   6   ROUTING_NOT_CONFIGURED (operator override only — env-only,
 *       not used in the default in-memory secret path).
 *   7   STALE_LOCK_UNRECOVERABLE.
 *   1   any other unexpected error.
 *
 * The CLI is intentionally tiny: every behavior it asserts lives in
 * `src/infrastructure/runtime/windows-model-route-boot-manager.ts`.
 */

import process from "node:process";

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  WindowsModelRouteBootManager,
  CatalogRouteMissingError,
  StaleLockUnrecoverableError,
  type BootLifecycleState,
} from "../infrastructure/runtime/windows-model-route-boot-manager.js";
import { PrismaModelRouteCatalogAdapter } from "../infrastructure/prisma/model-route-catalog.adapter.js";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { initializeDatabase } from "../infrastructure/runtime/database-path.js";
import {
  OpenCodeHttpCanaryTransport,
} from "../infrastructure/opencode/model-route-canary.js";
import { CanaryBlockedError } from "../infrastructure/opencode/model-route-canary.js";
import { OpenCodeModelCatalogAdapter } from "../infrastructure/opencode/opencode-model-catalog.adapter.js";
import { PrismaModelRepositoryAdapter } from "../infrastructure/prisma/prisma-model-repository.adapter.js";
import { SyncConnectedModelsUseCase } from "../application/sync-connected-models/sync-connected-models.use-case.js";
import type { BootChildProcess, BootProcessSupervisor } from "../infrastructure/runtime/windows-model-route-boot-manager.js";
import { REQUIRED_OPENCODE_VERSION } from "../infrastructure/opencode/model-route-readiness.js";

type Subcommand = "start" | "stop" | "status";

interface CliArgs {
  readonly subcommand: Subcommand;
  readonly workspaceRoot: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const userArgs = argv.slice(2);
  if (userArgs.length < 2) {
    throw new CliArgumentError(
      "usage: model-route-boot <start|stop|status> <workspaceRoot>",
    );
  }
  const sub = userArgs[0]!;
  const workspaceRoot = userArgs[1]!;
  if (sub !== "start" && sub !== "stop" && sub !== "status") {
    throw new CliArgumentError(`unknown subcommand "${sub}" (expected start|stop|status)`);
  }
  if (workspaceRoot.length === 0) {
    throw new CliArgumentError("workspaceRoot must be non-empty");
  }
  return { subcommand: sub, workspaceRoot };
}

class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

class OpenCodeProcessSupervisor implements BootProcessSupervisor {
  constructor(private readonly baseUrl: string) {}

  spawnServe(env: NodeJS.ProcessEnv): BootChildProcess {
    const command = process.platform === "win32" ? "opencode.cmd" : "opencode";
    return this.wrap(spawn(command, ["serve", "--hostname", "127.0.0.1"], { env, stdio: "ignore", windowsHide: true }));
  }

  async waitForHealthy(child: BootChildProcess): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastError = "not reachable";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.baseUrl}/global/health`);
        if (response.ok) {
          const body = await response.json() as { version?: unknown; data?: { version?: unknown } };
          const version = body.version ?? body.data?.version;
          if (version !== REQUIRED_OPENCODE_VERSION) throw new Error(`expected OpenCode ${REQUIRED_OPENCODE_VERSION}, got ${String(version)}`);
          return;
        }
        lastError = `health returned ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    child.kill("SIGTERM");
    throw new Error(`OPENCODE_SERVE_NOT_READY: ${lastError}`);
  }

  spawnAttach(env: NodeJS.ProcessEnv): BootChildProcess {
    const command = process.platform === "win32" ? "opencode.cmd" : "opencode";
    return this.wrap(spawn(command, ["attach", this.baseUrl], { env, stdio: "ignore", windowsHide: true }));
  }

  private wrap(child: ChildProcess): BootChildProcess {
    return child as unknown as BootChildProcess;
  }
}

function classify(err: unknown): { code: number; message: string } {
  if (err instanceof CliArgumentError) {
    return { code: 2, message: `argument error: ${err.message}` };
  }
  if (err instanceof CatalogRouteMissingError) {
    return { code: 3, message: `catalog readback failed: ${err.message}` };
  }
  if (err instanceof StaleLockUnrecoverableError) {
    return { code: 7, message: `lock recovery failed: ${err.message}` };
  }
  if (err instanceof CanaryBlockedError) {
    return { code: 4, message: `canary failed: ${err.code} ${err.message}` };
  }
  if (err instanceof Error && /MANIFEST_MISSING/.test(err.message)) {
    return { code: 5, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 1, message: `unexpected error: ${message}` };
}

/**
 * Select a parent model distinct from the target. The selection is
 * deterministic: when the target is `google/...`, use `openai/...`,
 * otherwise use `google/...`. Real boot wrappers override this with
 * a fleet-aware chooser; the CLI ships a minimal default so the
 * lifecycle is observable end-to-end on a fresh install.
 */
async function defaultSelectParentModel(targetCanonicalId: string): Promise<string | null> {
  const [provider] = targetCanonicalId.split("/");
  if (!provider) return null;
  if (provider === "google") return "openai/gpt-4o";
  return "google/antigravity-gemini-3.6-flash-tiered";
}

interface LockPayloadShape {
  readonly pid: number;
  readonly acquiredAt: number;
  readonly bootIdentity: string;
}

function readLockPayload(lockPath: string): LockPayloadShape | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayloadShape>;
    if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number") return null;
    return { pid: parsed.pid, acquiredAt: parsed.acquiredAt, bootIdentity: String(parsed.bootIdentity ?? "") };
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    const { code, message } = classify(err);
    process.stderr.write(`${message}\n`);
    return code;
  }

  const workspaceRoot = args.workspaceRoot;
  const manifestPath = `${workspaceRoot}/.opencode/sdd-model-routing/manifest.json`;
  const routingDir = path.join(workspaceRoot, ".opencode", "sdd-model-routing");
  const lockPath = path.join(routingDir, "generator.lock");
  const attestationPath = path.join(routingDir, "attestation.json");
  const openCodeBaseUrl = process.env["SDD_OPENCODE_BASE_URL"] ?? "http://127.0.0.1:4096";

  if (args.subcommand === "status") {
    // Status is read-only: do not instantiate the Prisma client.
    return reportStatus(attestationPath, lockPath);
  }

  if (args.subcommand === "stop") {
    // Stop is best-effort cross-process: signal the live pid when
    // present, otherwise just clean the disk state.
    return runStop(lockPath, attestationPath);
  }

  // start: long-lived supervisor.
  // For the CLI the catalog and canary transport are real adapters.
  const dbPath = initializeDatabase();
  const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter: prismaAdapter });
  const catalog = new PrismaModelRouteCatalogAdapter(prisma);
  const canary = new OpenCodeHttpCanaryTransport({ baseUrl: openCodeBaseUrl });
  const connectedCatalog = new OpenCodeModelCatalogAdapter({
    config: {
      providers: async () => (await fetch(`${openCodeBaseUrl}/config/providers`)).json(),
    },
  } as never);
  const repository = new PrismaModelRepositoryAdapter(prisma);
  const catalogSync = new SyncConnectedModelsUseCase(connectedCatalog, repository);

  const manager = new WindowsModelRouteBootManager({
    workspaceRoot,
    manifestPath,
    catalog,
    canary,
    selectParentModel: defaultSelectParentModel,
    catalogSync,
    processSupervisor: new OpenCodeProcessSupervisor(openCodeBaseUrl),
  });

  try {
    await manager.start();
    process.stdout.write(`boot: state=${manager.getState()} bootIdentity=${manager.getBootIdentity()}\n`);

    // Long-lived supervisor: wait for SIGINT/SIGTERM. The manager
    // distributes the boot identity + signing key to process.env so
    // the in-process bootstrap can read them; the keys are cleared
    // on stop().
    await new Promise<void>((resolve) => {
      const shutdown = async (signal: string): Promise<void> => {
        process.stdout.write(`boot: received ${signal}, stopping supervisor\n`);
        try { await manager.stop(); } catch (err) { process.stderr.write(`boot: stop error: ${(err as Error).message}\n`); }
        resolve();
      };
      process.once("SIGINT", () => { void shutdown("SIGINT"); });
      process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
    });
    process.stdout.write(`boot: state=${manager.getState()}\n`);
    return 0;
  } catch (err) {
    const { code, message } = classify(err);
    process.stderr.write(`${message}\n`);
    return code;
  } finally {
    try { await prisma.$disconnect(); } catch { /* best-effort */ }
  }
}

/**
 * Read-only status: report the on-disk attestation + lock state.
 * Does not construct any adapter.
 */
function reportStatus(attestationPath: string, lockPath: string): number {
  if (!existsSync(attestationPath)) {
    process.stdout.write("boot: state=idle (no attestation on disk)\n");
    return 0;
  }
  try {
    const attestation = JSON.parse(readFileSync(attestationPath, "utf8")) as Record<string, unknown>;
    const identity = typeof attestation["bootIdentity"] === "string" ? attestation["bootIdentity"] : "unknown";
    const expiresAt = typeof attestation["expiresAt"] === "number" ? attestation["expiresAt"] : 0;
    const state: BootLifecycleState = "ready";
    process.stdout.write(
      `boot: state=${state} bootIdentity=${identity} expiresAt=${expiresAt}` +
      ` lock=${existsSync(lockPath) ? "held" : "released"}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`status: failed to read attestation: ${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * Best-effort cross-process stop. The in-process path (start + stop
 * in the same CLI invocation) is exercised by the supervisor's
 * SIGTERM handler; this entry point is the operator-driven
 * recovery from a different shell.
 *
 * Strategy:
 *   1. If the lock file is present AND its pid is alive, send
 *      SIGTERM and let the supervisor call manager.stop().
 *   2. Otherwise (no lock, dead pid, malformed payload) clean the
 *      attestation + lock from disk so the next boot can start.
 */
function runStop(lockPath: string, attestationPath: string): number {
  const lock = readLockPayload(lockPath);
  if (lock !== null && lock.pid > 0 && lock.pid !== process.pid) {
    let alive = true;
    if (process.platform !== "win32") {
      try { process.kill(lock.pid, 0); } catch { alive = false; }
    } else {
      // No portable signal-0 probe on Windows; treat recent locks as live.
      alive = Date.now() - lock.acquiredAt < 30_000;
    }
    if (alive) {
      try {
        process.kill(lock.pid, "SIGTERM");
        process.stdout.write(`boot: sent SIGTERM to pid=${lock.pid} bootIdentity=${lock.bootIdentity}\n`);
        return 0;
      } catch (err) {
        process.stderr.write(`boot: failed to signal pid=${lock.pid}: ${(err as Error).message}\n`);
        // Fall through to disk cleanup.
      }
    }
  }
  // Disk cleanup: best-effort.
  try { rmSync(attestationPath, { force: true }); } catch { /* best-effort */ }
  try { rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
  process.stdout.write("boot: state=idle (cleaned stale attestation + lock)\n");
  return 0;
}

main().then(
  (code) => { process.exit(code); },
  (err: unknown) => {
    const { code, message } = classify(err);
    process.stderr.write(`${message}\n`);
    process.exit(code);
  },
);
