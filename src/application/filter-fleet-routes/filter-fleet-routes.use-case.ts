import type { ModelRouteCatalogPort } from "../../ports/model-route-catalog.port.js";
import type { QuarantineWritePort } from "../../ports/quarantine-write.port.js";
import { resolveQuarantinePrecedence } from "../../domain/model/quarantine.js";
import type { RouteEntry } from "../../infrastructure/opencode/disk-agent-generator.js";
import type {
  ExcludedRoute,
  FilterFleetRoutesInput,
  FilterFleetRoutesOutput,
} from "./filter-fleet-routes.input.js";

export class FilterFleetRoutesUseCase {
  constructor(
    private readonly catalogPort: ModelRouteCatalogPort,
    private readonly quarantinePort: QuarantineWritePort,
  ) {}

  async execute(input: FilterFleetRoutesInput): Promise<FilterFleetRoutesOutput> {
    const allQuarantines = await this.quarantinePort.listQuarantines();
    const permanentQuarantines = allQuarantines.filter((q) => q.type === "permanent");

    const included: RouteEntry[] = [];
    const excluded: ExcludedRoute[] = [];

    for (const route of input.routes) {
      const isConnected = await this.catalogPort.existsCanonical(
        route.providerId,
        route.modelId,
      );

      if (!isConnected) {
        excluded.push({
          route,
          reason: "NOT_CONNECTED",
          detail: "Not present in persistent catalog",
        });
        continue;
      }

      const activePermanentQuarantine = resolveQuarantinePrecedence(
        permanentQuarantines,
        route.providerId,
        route.modelId,
      );

      if (activePermanentQuarantine) {
        excluded.push({
          route,
          reason: "PERMANENTLY_QUARANTINED",
          detail: `quarantined at ${activePermanentQuarantine.level} level`,
        });
        continue;
      }

      included.push(route);
    }

    return { included, excluded };
  }
}
