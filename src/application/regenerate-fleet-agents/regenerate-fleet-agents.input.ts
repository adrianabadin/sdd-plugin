import type { GeneratedRoute } from "../../infrastructure/opencode/disk-agent-generator.js";
import type { ExcludedRoute } from "../filter-fleet-routes/filter-fleet-routes.input.js";

export interface RegenerateFleetAgentsInput {
  readonly workspaceRoot: string;
  readonly routesConfigPath?: string;
  readonly correlationId?: string;
  readonly excludeCanonicalIds?: ReadonlySet<string>;
}

export interface RegenerateFleetAgentsOutput {
  readonly generated: ReadonlyArray<GeneratedRoute>;
  readonly excluded: ReadonlyArray<ExcludedRoute>;
  readonly manifestHash: string;
  readonly sweptRelativePaths: ReadonlyArray<string>;
}
