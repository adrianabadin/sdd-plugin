/**
 * Fleet filter for the pre-start generator. Rev 2: `routes.json` is the
 * only inclusion authority. The filter's only subtractive force is
 * `permanent` quarantines (which are removed BEFORE generation). TTL
 * quarantines are still INCLUDED here so the generator can produce
 * their agent files; the dispatcher enforces TTL at hook time.
 *
 * The previous NOT_CONNECTED branch (rejected routes whose provider was
 * not in the Prisma catalog) is gone: a route in `routes.json` whose
 * provider is currently disconnected still produces an agent file
 * that fails loudly on use, instead of being silently dropped from
 * the fleet.
 */

import type { ModelRouteQuarantinePort } from "../../ports/model-route-quarantine.port.js";
import { resolveQuarantinePrecedence } from "../../domain/model/quarantine.js";
import type { RouteEntry } from "../../infrastructure/opencode/disk-agent-generator.js";
import type {
  ExcludedRoute,
  FilterFleetRoutesInput,
  FilterFleetRoutesOutput,
} from "./filter-fleet-routes.input.js";

export class FilterFleetRoutesUseCase {
  constructor(
    private readonly quarantinePort: ModelRouteQuarantinePort,
  ) {}

  async execute(input: FilterFleetRoutesInput): Promise<FilterFleetRoutesOutput> {
    const allQuarantines = await this.quarantinePort.listActive();
    const permanentQuarantines = allQuarantines.filter((q) => q.type === "permanent");

    const included: RouteEntry[] = [];
    const excluded: ExcludedRoute[] = [];

    for (const route of input.routes) {
      const activePermanentQuarantine = resolveQuarantinePrecedence(
        permanentQuarantines,
        route.providerId,
        route.modelId,
      );
      if (activePermanentQuarantine) {
        const reasonPart = typeof activePermanentQuarantine.reason === "string" && activePermanentQuarantine.reason.length > 0
          ? ` (${activePermanentQuarantine.reason})`
          : "";
        excluded.push({
          route,
          reason: "PERMANENTLY_QUARANTINED",
          detail: `quarantined at ${activePermanentQuarantine.level} level${reasonPart}`,
        });
        continue;
      }
      included.push(route);
    }

    return { included, excluded };
  }
}
