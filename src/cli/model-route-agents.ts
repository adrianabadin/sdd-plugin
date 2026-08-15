#!/usr/bin/env node
/**
 * Pre-start CLI entry point for the deterministic model routing disk
 * generator.
 *
 * Usage:
 *   npm run generate:model-routes -- <workspaceRoot> <routesConfigPath>
 *
 *   <workspaceRoot>     absolute or repo-relative path to the workspace
 *                       that owns `.opencode/`. The generator never writes
 *                       anywhere else.
 *   <routesConfigPath>  absolute or workspace-relative path to the
 *                       `config/model-routing/routes.json` whitelist. The
 *                       generator refuses paths that live outside the
 *                       workspace root.
 *
 * Exit codes:
 *   0   success; manifest + owned artifacts were written and verified.
 *   2   argument error (missing args, traversal, malformed paths).
 *   3   routes.json validation error (cap, schema, duplicates).
 *   4   disk safety / path safety error.
 *   5   generator lock contention / stale lock unrecoverable.
 *   6   manifest invalid (corruption / shape mismatch).
 *   7   descriptor budget exceeded.
 *   8   sweep incomplete error.
 *   1   any other unexpected error / database or audit initialization failure.
 */

import process from "node:process";
import path from "node:path";

import { getPrismaClient, disposeBootstrapPersistence } from "../bootstrap/index.js";
import { PrismaModelRouteQuarantineAdapter } from "../infrastructure/prisma/model-route-quarantine.adapter.js";
import { ModelRouteAuditLogger } from "../infrastructure/logging/model-route-audit.logger.js";
import { RegenerateFleetAgentsUseCase } from "../application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.js";
import {
  DescriptorBudgetExceededError,
  DiskAgentGeneratorError,
  DiskSafetyError,
  GeneratorLockActiveError,
  ManifestInvalidError,
  ModifiedOwnedFileError,
  PathTraversalDetectedError,
  RouteCapExceededError,
  RoutesConfigInvalidError,
  StaleLockUnrecoverableError,
  SweepIncompleteError,
} from "../infrastructure/opencode/disk-agent-generator.js";

interface CliArgs {
  readonly workspaceRoot: string;
  readonly routesConfigPath: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const userArgs = argv.slice(2);
  if (userArgs.length < 2) {
    throw new CliArgumentError(
      "usage: generate:model-routes <workspaceRoot> <routesConfigPath>",
    );
  }
  const workspaceRoot = userArgs[0]!;
  const routesConfigPath = userArgs[1]!;
  if (!workspaceRoot) throw new CliArgumentError("workspaceRoot must be non-empty");
  if (!routesConfigPath) throw new CliArgumentError("routesConfigPath must be non-empty");
  return { workspaceRoot, routesConfigPath };
}

class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

function classify(err: unknown): { code: number; message: string } {
  if (err instanceof CliArgumentError) {
    return { code: 2, message: `argument error: ${err.message}` };
  }
  if (err instanceof PathTraversalDetectedError) {
    return { code: 4, message: `path-traversal error: ${err.message}` };
  }
  if (err instanceof DiskSafetyError) {
    return { code: 4, message: `disk-safety error: ${err.message}` };
  }
  if (err instanceof RoutesConfigInvalidError) {
    return { code: 3, message: `routes-config error: ${err.message}` };
  }
  if (err instanceof RouteCapExceededError) {
    return { code: 3, message: `route-cap error: ${err.message}` };
  }
  if (err instanceof GeneratorLockActiveError || err instanceof StaleLockUnrecoverableError) {
    return { code: 5, message: `lock error: ${err.message}` };
  }
  if (err instanceof ManifestInvalidError) {
    return { code: 6, message: `manifest error: ${err.message}` };
  }
  if (err instanceof ModifiedOwnedFileError) {
    return { code: 4, message: `modified-owned-file error: ${err.message}` };
  }
  if (err instanceof DescriptorBudgetExceededError) {
    return { code: 7, message: `descriptor-budget error: ${err.message}` };
  }
  if (err instanceof SweepIncompleteError) {
    return { code: 8, message: `sweep error: ${err.message}` };
  }
  if (err instanceof DiskAgentGeneratorError) {
    return { code: 1, message: `${err.name}: ${err.message}` };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 1, message: `unexpected error: ${message}` };
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

  let auditLogger: ModelRouteAuditLogger | null = null;
  try {
    const prisma = getPrismaClient();
    const quarantinePort = new PrismaModelRouteQuarantineAdapter(prisma);
    const auditPath = path.resolve(
      args.workspaceRoot,
      ".opencode",
      "sdd-model-routing",
      "routing.audit.jsonl",
    );
    auditLogger = new ModelRouteAuditLogger({ path: auditPath });

    const useCase = new RegenerateFleetAgentsUseCase(quarantinePort, auditLogger);
    const result = await useCase.execute({
      workspaceRoot: args.workspaceRoot,
      routesConfigPath: args.routesConfigPath,
    });

    process.stdout.write(
      `deterministic-model-routing: generated=${result.generated.length} ` +
        `excluded=${result.excluded.length} ` +
        `manifest=${result.manifestHash.slice(0, 12)}...\n`,
    );
    return 0;
  } catch (err) {
    const { code, message } = classify(err);
    process.stderr.write(`${message}\n`);
    return code;
  } finally {
    if (auditLogger) {
      await auditLogger.close().catch(() => {});
    }
    await disposeBootstrapPersistence().catch(() => {});
  }
}

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