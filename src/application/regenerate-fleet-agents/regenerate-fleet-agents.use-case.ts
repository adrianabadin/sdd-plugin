import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { ModelRouteCatalogPort } from "../../ports/model-route-catalog.port.js";
import type { QuarantineWritePort } from "../../ports/quarantine-write.port.js";
import type { ModelRouteAuditLogger } from "../../infrastructure/logging/model-route-audit.logger.js";
import {
  decodeRoutesConfig,
  DiskAgentGenerator,
  PathTraversalDetectedError,
  type RoutesConfig,
} from "../../infrastructure/opencode/disk-agent-generator.js";
import { FilterFleetRoutesUseCase } from "../filter-fleet-routes/filter-fleet-routes.use-case.js";
import type {
  RegenerateFleetAgentsInput,
  RegenerateFleetAgentsOutput,
} from "./regenerate-fleet-agents.input.js";

export class RegenerateFleetAgentsUseCase {
  constructor(
    private readonly catalogPort: ModelRouteCatalogPort,
    private readonly quarantinePort: QuarantineWritePort,
    private readonly auditLogger: ModelRouteAuditLogger,
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

    const filterUseCase = new FilterFleetRoutesUseCase(this.catalogPort, this.quarantinePort);
    const filterResult = await filterUseCase.execute({
      routes: config.routes,
      excludedCanonicalIds: input.excludeCanonicalIds,
    });

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
