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
 *             handlers that call manager.stop() and exit 0.
 *   stop    - Release the manager in-process or via SIGTERM to lock pid.
 *   status  - Report on-disk attestation + lock state.
 */

import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  WindowsModelRouteBootManager,
  CatalogRouteMissingError,
  StaleLockUnrecoverableError,
  type BootLifecycleState,
  type BootChildProcess,
  type BootProcessSupervisor,
} from "../infrastructure/runtime/windows-model-route-boot-manager.js";
import { PrismaModelRouteCatalogAdapter } from "../infrastructure/prisma/model-route-catalog.adapter.js";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { initializeDatabase } from "../infrastructure/runtime/database-path.js";
import { OpenCodeHttpCanaryTransport, CanaryBlockedError } from "../infrastructure/opencode/model-route-canary.js";
import { OpenCodeModelCatalogAdapter } from "../infrastructure/opencode/opencode-model-catalog.adapter.js";
import { PrismaModelRepositoryAdapter } from "../infrastructure/prisma/prisma-model-repository.adapter.js";
import { SyncConnectedModelsUseCase } from "../application/sync-connected-models/sync-connected-models.use-case.js";
import { REQUIRED_OPENCODE_VERSION } from "../infrastructure/opencode/model-route-readiness.js";
import { stopModelRouteSupervisor } from "../infrastructure/runtime/model-route-boot-control.js";
import { mapModelRouteStopResult } from "./model-route-boot-stop-output.js";
import { ModelRouteAuditLogger } from "../infrastructure/logging/model-route-audit.logger.js";
import { RegenerateFleetAgentsUseCase } from "../application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.js";

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

export class OpenCodeProcessSupervisor implements BootProcessSupervisor {
  constructor(private readonly baseUrl: string) {}

  spawnServe(env: NodeJS.ProcessEnv): BootChildProcess {
    const command = process.platform === "win32" ? "opencode.cmd" : "opencode";
    return this.wrap(spawn(command, ["serve", "--hostname", "127.0.0.1"], { env, stdio: "ignore", windowsHide: true, shell: process.platform === "win32" }));
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
    return this.wrap(spawn(command, ["attach", this.baseUrl], { env, stdio: "ignore", windowsHide: true, shell: process.platform === "win32" }));
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

export async function defaultSelectParentModel(targetCanonicalId: string): Promise<string | null> {
  const [provider] = targetCanonicalId.split("/");
  if (!provider) return null;
  if (provider === "google") return "openai/gpt-4o";
  return "google/antigravity-gemini-3.6-flash-tiered";
}

export interface ProductionBootComponents {
  readonly manager: WindowsModelRouteBootManager;
  readonly prisma: PrismaClient;
  readonly auditLogger: ModelRouteAuditLogger;
  readonly fleetRegeneration: RegenerateFleetAgentsUseCase;
  readonly routesConfigPath: string;
}

export function createProductionBootComponents(
  workspaceRoot: string,
  options?: {
    openCodeBaseUrl?: string;
    prisma?: PrismaClient;
    auditLogger?: ModelRouteAuditLogger;
    processSupervisor?: BootProcessSupervisor;
  },
): ProductionBootComponents {
  const openCodeBaseUrl = options?.openCodeBaseUrl ?? process.env["SDD_OPENCODE_BASE_URL"] ?? "http://127.0.0.1:4096";
  const manifestPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");

  let prisma = options?.prisma;
  if (!prisma) {
    const dbPath = initializeDatabase();
    const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
    prisma = new PrismaClient({ adapter: prismaAdapter });
  }

  const catalog = new PrismaModelRouteCatalogAdapter(prisma);
  const quarantinePort = new PrismaModelRepositoryAdapter(prisma);
  const canary = new OpenCodeHttpCanaryTransport({ baseUrl: openCodeBaseUrl });
  const connectedCatalog = new OpenCodeModelCatalogAdapter({
    config: {
      providers: async () => (await fetch(`${openCodeBaseUrl}/config/providers`)).json(),
    },
  } as never);
  const catalogSync = new SyncConnectedModelsUseCase(connectedCatalog, quarantinePort);

  const auditPath = path.resolve(workspaceRoot, ".opencode", "sdd-model-routing", "routing.audit.jsonl");
  const auditLogger = options?.auditLogger ?? new ModelRouteAuditLogger({ path: auditPath });

  const fleetRegeneration = new RegenerateFleetAgentsUseCase(catalog, quarantinePort, auditLogger);
  const routesConfigPath = path.resolve(workspaceRoot, "config/model-routing/routes.json");

  const manager = new WindowsModelRouteBootManager({
    workspaceRoot,
    manifestPath,
    catalog,
    canary,
    selectParentModel: defaultSelectParentModel,
    catalogSync,
    fleetRegeneration,
    routesConfigPath,
    processSupervisor: options?.processSupervisor ?? new OpenCodeProcessSupervisor(openCodeBaseUrl),
  });

  return {
    manager,
    prisma,
    auditLogger,
    fleetRegeneration,
    routesConfigPath,
  };
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
  const routingDir = path.join(workspaceRoot, ".opencode", "sdd-model-routing");
  const lockPath = path.join(routingDir, "generator.lock");
  const attestationPath = path.join(routingDir, "attestation.json");
  const controlPath = path.join(routingDir, "boot-control.json");

  if (args.subcommand === "status") {
    return reportStatus(attestationPath, lockPath);
  }

  if (args.subcommand === "stop") {
    return runStop(lockPath, attestationPath, controlPath);
  }

  // subcommand === "start"
  const components = createProductionBootComponents(workspaceRoot);
  const { manager, prisma, auditLogger } = components;

  try {
    await manager.start();
    process.stdout.write(`boot: state=${manager.getState()} bootIdentity=${manager.getBootIdentity()}\n`);

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
    try { await auditLogger.close(); } catch { /* best-effort */ }
    try { await prisma.$disconnect(); } catch { /* best-effort */ }
  }
}

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

function runStop(lockPath: string, attestationPath: string, controlPath: string): number {
  const result = stopModelRouteSupervisor({ lockPath, attestationPath, controlPath });
  const output = mapModelRouteStopResult(result);
  if (output.stdout.length > 0) process.stdout.write(output.stdout);
  if (output.stderr.length > 0) process.stderr.write(output.stderr);
  return output.code;
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("model-route-boot.ts") ||
    process.argv[1].endsWith("model-route-boot.js"))
) {
  main().then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      const { code, message } = classify(err);
      process.stderr.write(`${message}\n`);
      process.exit(code);
    },
  );
}
