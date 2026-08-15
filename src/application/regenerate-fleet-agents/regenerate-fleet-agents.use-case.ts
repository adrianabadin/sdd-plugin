/**
 * Rev 2: pre-start fleet regeneration use case.
 *
 *  - `routes.json` is the only inclusion authority. No catalog port is
 *    consulted at generation time; routes whose provider is currently
 *    disconnected are still generated (they fail loudly on use).
 *  - Quarantine is the only subtractive force: `permanent` quarantines
 *    remove the route before generation; `ttl` quarantines are still
 *    included (the dispatcher enforces them at hook time).
 *  - Before generation we re-collect the SDK variant snapshot
 *    (best-effort). On success we persist it; on failure we keep the
 *    on-disk `variants.json` (or treat as empty if absent) so the
 *    dispatch never breaks.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { ModelRouteQuarantinePort } from "../../ports/model-route-quarantine.port.js";
import type { ModelRouteAuditLogger } from "../../infrastructure/logging/model-route-audit.logger.js";
import {
  decodeRoutesConfig,
  DiskAgentGenerator,
  PathTraversalDetectedError,
  type RoutesConfig,
} from "../../infrastructure/opencode/disk-agent-generator.js";
import {
  buildVariantSnapshots,
  collectVariantsFromSdk,
  readVariantSnapshot,
  writeVariantSnapshot,
  type OpenCodeClient,
} from "../../infrastructure/opencode/variant-snapshot.js";
import { FilterFleetRoutesUseCase } from "../filter-fleet-routes/filter-fleet-routes.use-case.js";
import type {
  RegenerateFleetAgentsInput,
  RegenerateFleetAgentsOutput,
} from "./regenerate-fleet-agents.input.js";

export class RegenerateFleetAgentsUseCase {
  constructor(
    private readonly quarantinePort: ModelRouteQuarantinePort,
    private readonly auditLogger: ModelRouteAuditLogger,
    private readonly openCodeClient?: OpenCodeClient,
  ) {}

  async execute(input: RegenerateFleetAgentsInput): Promise<RegenerateFleetAgentsOutput> {
    const rootAbs = path.resolve(input.workspaceRoot);
    const rawPath = input.routesConfigPath ?? path.join("config", "model-routing", "routes.json");
    const resolvedConfigPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(rootAbs, rawPath);

    if (!resolvedConfigPath.startsWith(rootAbs + path.sep) && resolvedConfigPath !== rootAbs) {
      throw new PathTraversalDetectedError(
        resolvedConfigPath,
        "routes config path must live inside workspace root",
      );
    }

    const configJson = readFileSync(resolvedConfigPath, "utf8");
    const config = decodeRoutesConfig(configJson);

    const filterUseCase = new FilterFleetRoutesUseCase(this.quarantinePort);
    const filterResult = await filterUseCase.execute({ routes: config.routes });

    const correlationId = input.correlationId ?? randomBytes(16).toString("hex");
    const startTime = Date.now();

    for (const ex of filterResult.excluded) {
      await this.auditLogger.append({
        stage: "generation.route.excluded",
        status: "warning",
        correlationId,
        providerId: ex.route.providerId,
        modelId: ex.route.modelId,
        baseTemplate: ex.route.baseTemplate,
        reason: ex.reason,
        detail: ex.detail,
        durationMs: Date.now() - startTime,
      });
    }

    if (filterResult.included.length === 0) {
      await this.auditLogger.append({
        stage: "generation.fleet.empty",
        status: "warning",
        correlationId,
        excludedCount: filterResult.excluded.length,
        durationMs: Date.now() - startTime,
      });
    }

    // Variant snapshot: best-effort SDK collection; on failure, keep the
    // on-disk snapshot (or empty if absent) so dispatch never breaks.
    const existingSnapshot = readVariantSnapshot(rootAbs);
    let snapshot = existingSnapshot;
    if (this.openCodeClient !== undefined) {
      try {
        const raw = await collectVariantsFromSdk(this.openCodeClient);
        const collected = buildVariantSnapshots(raw);
        writeVariantSnapshot(rootAbs, collected);
        snapshot = collected;
      } catch {
        // Keep `existingSnapshot` as the fallback. Dispatch still works.
      }
    }

    const filteredConfig: RoutesConfig = {
      schemaVersion: config.schemaVersion,
      generatorVersion: config.generatorVersion,
      cap: config.cap,
      sizeException: config.sizeException,
      routes: filterResult.included,
    };

    const generator = new DiskAgentGenerator({
      workspaceRoot: rootAbs,
      routesConfig: filteredConfig,
      variantSnapshot: snapshot,
    });

    const genResult = await generator.generate();

    return {
      generated: genResult.generated,
      excluded: filterResult.excluded,
      manifestHash: genResult.manifest.manifestHash,
      sweptRelativePaths: genResult.sweptRelativePaths,
    };
  }
}
