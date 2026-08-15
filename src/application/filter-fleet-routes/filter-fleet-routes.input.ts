import type { RouteEntry } from "../../infrastructure/opencode/disk-agent-generator.js";

export interface FilterFleetRoutesInput {
  readonly routes: ReadonlyArray<RouteEntry>;
}

export type RouteExclusionReason = "PERMANENTLY_QUARANTINED";

export interface ExcludedRoute {
  readonly route: RouteEntry;
  readonly reason: RouteExclusionReason;
  readonly detail: string;
}

export interface FilterFleetRoutesOutput {
  readonly included: ReadonlyArray<RouteEntry>;
  readonly excluded: ReadonlyArray<ExcludedRoute>;
}
