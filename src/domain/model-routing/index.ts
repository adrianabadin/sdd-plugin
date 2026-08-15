/**
 * Pure domain surface for deterministic model routing.
 *
 * Runtime staging, readiness, and transport hooks live outside this barrel.
 */

export {
  parseModelRouteGrammar,
  ModelRouteGrammarError,
  MODEL_ROUTE_MAX_BYTES,
  MODEL_ROUTE_BASE_MAX_LENGTH,
  MODEL_ROUTE_REFERENCE_MAX_BYTES,
  type ParsedModelRouteV1,
  type ModelRouteGrammarErrorCode,
} from "./model-route-grammar.js";

export {
  makeCanonicalModelId,
  parseCanonicalModelId,
  type CanonicalModelId,
} from "./canonical-model-id.js";

export {
  ModelRouteResolver,
  RouteUnknownError,
  RouteAmbiguousError,
  type ModelRouteAliasTable,
} from "./model-route-resolver.js";

export {
  ROUTED_HOST_NAME_PREFIX,
  formatCanonicalModelId,
  hashHostName,
  type CanonicalModelIdentity,
  type RoutedHostName,
} from "./model-route-host-naming.js";

export {
  OPENCODE_COMPAT_VERSION,
  OpenCodeCompatError,
  assertOpenCodeCompatible,
} from "./opencode-compat.js";

export {
  RouteWhitelist,
  loadRouteWhitelist,
  DEFAULT_ROUTES_CONFIG_RELATIVE,
  type WhitelistedRoute,
} from "./route-whitelist.js";

export {
  NORMALIZED_LEVELS,
  normalizeEffortLevels,
  nearestLevel,
  isLevelExposed,
  type NormalizedEffortLevel,
  type EffortLevelMapping,
} from "./effort-levels.js";