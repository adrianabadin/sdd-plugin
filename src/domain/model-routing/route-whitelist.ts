/**
 * `routes.json` is the only routing authority. This loader is the single
 * place that turns a `routes.json` whitelist into a deterministic
 * `RouteWhitelist` instance keyed by `provider/model`.
 *
 * The whitelist is read on every dispatch invocation so an edit to
 * `routes.json` takes effect without restarting OpenCode.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { hashHostName, type RoutedHostName } from "./model-route-host-naming.js";

export interface WhitelistedRoute {
  readonly baseTemplate: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly hostName: RoutedHostName;
}

export const DEFAULT_ROUTES_CONFIG_RELATIVE = path.join("config", "model-routing", "routes.json");

export class RouteWhitelist {
  private readonly byCanonical: ReadonlyMap<string, WhitelistedRoute>;

  constructor(routes: ReadonlyArray<WhitelistedRoute>) {
    const map = new Map<string, WhitelistedRoute>();
    for (const route of routes) map.set(`${route.providerId}/${route.modelId}`, route);
    this.byCanonical = map;
  }

  get size(): number {
    return this.byCanonical.size;
  }

  findHostName(providerId: string, modelId: string): RoutedHostName | null {
    return this.byCanonical.get(`${providerId}/${modelId}`)?.hostName ?? null;
  }

  existsCanonical(providerId: string, modelId: string): boolean {
    return this.byCanonical.has(`${providerId}/${modelId}`);
  }

  /** All whitelisted routes. */
  routes(): ReadonlyArray<WhitelistedRoute> {
    return [...this.byCanonical.values()];
  }

  /** Substring match over `provider/model`, lowercased. Deterministically sorted. */
  searchNormalized(reference: string, limit: number): ReadonlyArray<WhitelistedRoute> {
    const needle = reference.trim().toLowerCase();
    if (needle.length === 0) return [];
    const hits = [...this.byCanonical.values()].filter((route) =>
      `${route.providerId}/${route.modelId}`.toLowerCase().includes(needle),
    );
    hits.sort((a, b) =>
      a.providerId !== b.providerId
        ? a.providerId < b.providerId ? -1 : 1
        : a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0,
    );
    return hits.slice(0, limit);
  }
}

export function loadRouteWhitelist(workspaceRoot: string, configPath?: string): RouteWhitelist {
  const resolved = configPath ?? path.join(path.resolve(workspaceRoot), DEFAULT_ROUTES_CONFIG_RELATIVE);
  const raw = JSON.parse(readFileSync(resolved, "utf8")) as {
    routes?: ReadonlyArray<{ baseTemplate?: unknown; providerId?: unknown; modelId?: unknown }>;
  };
  const routes: WhitelistedRoute[] = [];
  for (const entry of raw.routes ?? []) {
    const { baseTemplate, providerId, modelId } = entry;
    if (typeof baseTemplate !== "string" || typeof providerId !== "string" || typeof modelId !== "string") continue;
    if (baseTemplate.length === 0 || providerId.length === 0 || modelId.length === 0) continue;
    routes.push({ baseTemplate, providerId, modelId, hostName: hashHostName(baseTemplate, { providerId, modelId }) });
  }
  return new RouteWhitelist(routes);
}
