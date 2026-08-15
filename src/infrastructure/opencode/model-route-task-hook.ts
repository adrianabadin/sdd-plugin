/**
 * Synchronous deterministic model-routing `tool.execute.before` hook.
 *
 * Rev 2 — `routes.json` is the only routing authority; no attestation,
 * no manifest, no boot identity, no signing key, no OpenCode version
 * check. The hook works in a plain OpenCode session that knows nothing
 * about the routing infrastructure.
 *
 * Two paths converge on the same selection:
 *   A. Explicit-grammar `model-route:v1|sdd-mr-base|<modelRef>[|<effort>]`
 *      — the 4th segment is optional and selects the effort level.
 *   B. Natural-intent prompt trigger (with optional effort phrase).
 *
 * Selection (after parse + resolve + quarantine reconcile):
 *   1. lookup hostName in whitelist (else ROUTE_NOT_WHITELISTED)
 *   2. read variant mapping for the canonical id
 *   3. resolve requested level (default low) against the mapping
 *      - mapping empty     -> base agent + MODEL_HAS_NO_VARIANTS warning
 *      - level not exposed -> nearest available + LEVEL_NOT_EXPOSED
 *   4. confirm target .md exists on disk (else ROUTED_AGENT_UNAVAILABLE)
 *   5. rewrite args.subagent_type
 *   6. append best-effort audit entry (failure logs and continues)
 *
 * Constraints:
 *  - `args.model` is NEVER read, written, or relied on for routing.
 *  - `args.prompt` bytes are NEVER mutated by parsing.
 *  - The hook only writes the audit line; no manifest, no agent files,
 *    no lock, no journal. All disk writes belong to the pre-start CLI.
 *  - No natural trigger + no grammar trigger -> byte-for-byte
 *    passthrough, no audit entry.
 *  - Prompt injection resistance: the prompt is data; the canonical
 *    identity is what controls every gate. The prompt is never recorded
 *    in audit entries.
 *
 * Design: 0695919c-2264-4e0d-a3fb-f7d4190661fc.
 * Rev 2 plan: docs/plans/2026-08-14-model-routing-whitelist-only.md.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { parseModelRouteGrammar, ModelRouteGrammarError } from "../../domain/model-routing/model-route-grammar.js";
import { ModelRouteResolver, RouteUnknownError, RouteAmbiguousError } from "../../domain/model-routing/model-route-resolver.js";
import {
  parseNaturalModelIntent,
  NaturalIntentAmbiguousError,
  NaturalIntentMalformedError,
  EffortLevelUnknownError,
  type NaturalModelIntent,
} from "../../domain/model-routing/natural-model-intent.js";
import type { NormalizedEffortLevel } from "../../domain/model-routing/effort-levels.js";
import { isLevelExposed, nearestLevel } from "../../domain/model-routing/effort-levels.js";
import { RouteWhitelist } from "../../domain/model-routing/route-whitelist.js";
import type { VariantSnapshot } from "./variant-snapshot.js";
import type { QuarantineStore } from "../runtime/quarantine-store.js";
import type { QuarantineEntry } from "../../domain/model/quarantine.js";
import { resolveQuarantinePrecedence } from "../../domain/model/quarantine.js";
import {
  ModelRouteAuditLogger,
  type ModelRouteAuditEntry,
} from "../logging/model-route-audit.logger.js";

export class RouteNotWhitelistedError extends Error {
  readonly code = "ROUTE_NOT_WHITELISTED";
  constructor(canonical: string) {
    super(`ROUTE_NOT_WHITELISTED: ${canonical} is not in routes.json`);
    this.name = "RouteNotWhitelistedError";
  }
}

export class RoutedAgentUnavailableError extends Error {
  readonly code = "ROUTED_AGENT_UNAVAILABLE";
  constructor(agentFile: string) {
    super(`ROUTED_AGENT_UNAVAILABLE: agent file missing on disk: ${agentFile}`);
    this.name = "RoutedAgentUnavailableError";
  }
}

export class QuarantinedModelError extends Error {
  readonly code = "QUARANTINED_MODEL";
  constructor(message: string) {
    super(`QUARANTINED_MODEL: ${message}`);
    this.name = "QuarantinedModelError";
  }
}

export type EffortFallbackReason = "MODEL_HAS_NO_VARIANTS" | "LEVEL_NOT_EXPOSED";

export interface ModelRouteTaskHookLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const NOOP_LOGGER: ModelRouteTaskHookLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface ModelRouteTaskHookOptions {
  readonly workspaceRoot: string;
  readonly whitelist: RouteWhitelist;
  readonly variants: ReadonlyMap<string, VariantSnapshot>;
  readonly resolver: ModelRouteResolver;
  readonly quarantineStore: QuarantineStore;
  readonly audit: { path: string; maxFieldBytes?: number; maxDepth?: number };
  readonly loadQuarantineEntries?: () => Promise<ReadonlyArray<QuarantineEntry>>;
  readonly logger?: ModelRouteTaskHookLogger;
  readonly now?: () => number;
}

interface HookInput {
  readonly tool?: string;
  readonly callID?: string;
  readonly [key: string]: unknown;
}

interface HookOutput {
  args?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

interface ResolvedRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly trigger?: string;
  readonly naturalReference?: string;
}

export class ModelRouteTaskHook {
  private readonly workspaceRoot: string;
  private readonly whitelist: RouteWhitelist;
  private readonly variants: ReadonlyMap<string, VariantSnapshot>;
  private readonly resolver: ModelRouteResolver;
  private readonly quarantineStore: QuarantineStore;
  private readonly auditLogger: ModelRouteAuditLogger;
  private readonly now: () => number;
  private readonly loadQuarantineEntries?: () => Promise<ReadonlyArray<QuarantineEntry>>;
  private readonly logger: ModelRouteTaskHookLogger;

  constructor(options: ModelRouteTaskHookOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.whitelist = options.whitelist;
    this.variants = options.variants;
    this.resolver = options.resolver;
    this.quarantineStore = options.quarantineStore;
    const auditOptions: { path: string; maxFieldBytes?: number; maxDepth?: number } = { path: options.audit.path };
    if (options.audit.maxFieldBytes !== undefined) auditOptions.maxFieldBytes = options.audit.maxFieldBytes;
    if (options.audit.maxDepth !== undefined) auditOptions.maxDepth = options.audit.maxDepth;
    this.auditLogger = new ModelRouteAuditLogger(auditOptions);
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? NOOP_LOGGER;
    if (options.loadQuarantineEntries !== undefined) this.loadQuarantineEntries = options.loadQuarantineEntries;
  }

  async execute(input: HookInput, output: HookOutput): Promise<void> {
    if (input.tool !== "task") return;

    const subagentType = typeof output.args?.["subagent_type"] === "string"
      ? (output.args["subagent_type"] as string)
      : undefined;

    // Path A: explicit grammar.
    let parsedGrammar: ReturnType<typeof parseModelRouteGrammar> = null;
    if (typeof subagentType === "string") {
      try {
        parsedGrammar = parseModelRouteGrammar(subagentType);
      } catch (error) {
        if (error instanceof ModelRouteGrammarError) {
          // Malformed grammar is not a routing request — pass through.
          this.logger.warn(`[sdd-plugin.routing] grammar error: ${error.message}`);
          return;
        }
        throw error;
      }
    }

    if (parsedGrammar !== null) {
      const effortFromGrammar = parsedGrammar.effort;
      await this.dispatch(
        input,
        output,
        parsedGrammar.reference,
        effortFromGrammar,
        {},
      );
      return;
    }

    // Path B: natural-intent.
    const promptRaw = output.args?.["prompt"];
    if (typeof promptRaw !== "string" || promptRaw.length === 0) {
      return;
    }
    let intent: NaturalModelIntent | null;
    try {
      intent = parseNaturalModelIntent(promptRaw);
    } catch (error) {
      if (error instanceof NaturalIntentAmbiguousError) {
        this.logger.warn(`[sdd-plugin.routing] ${error.message}`);
        return;
      }
      if (error instanceof NaturalIntentMalformedError) {
        this.logger.warn(`[sdd-plugin.routing] natural intent malformed (${error.code})`);
        return;
      }
      if (error instanceof EffortLevelUnknownError) {
        this.logger.warn(`[sdd-plugin.routing] ${error.message}`);
        return;
      }
      throw error;
    }
    if (intent === null) return;

    await this.dispatch(
      input,
      output,
      intent.rawReference,
      intent.effort,
      { trigger: intent.trigger, naturalReference: intent.rawReference },
    );
  }

  /**
   * Common selection flow: parse → resolve → quarantine → whitelist →
   * variant → disk check → rewrite → best-effort audit.
   */
  private async dispatch(
    input: HookInput,
    output: HookOutput,
    requestedReference: string,
    requestedEffort: NormalizedEffortLevel | undefined,
    auditExtras: { trigger?: string; naturalReference?: string },
  ): Promise<void> {
    const startedAt = this.now();
    const correlationId = this.correlationIdFor(input);

    // 1. Reconcile quarantine.
    if (this.loadQuarantineEntries) {
      try {
        const entries = await this.loadQuarantineEntries();
        this.quarantineStore.reconcile([...entries]);
      } catch (error) {
        this.logger.error(`[sdd-plugin.routing] quarantine load failed: ${(error as Error).message}`);
        await this.appendAudit({
          stage: "routing.blocked",
          status: "error",
          correlationId,
          requestedAlias: requestedReference,
          resolutionTier: "exact",
          resolvedProviderId: "",
          resolvedModelId: "",
          routedAgent: "",
          quarantineChecked: false,
          durationMs: this.now() - startedAt,
          errorClass: (error as Error).name,
          ...auditExtras,
        });
        throw error;
      }
    }

    // 2. Resolve to canonical identity. The whitelist is the only
    //    source of truth, so a "model route unknown" is effectively
    //    "model route not whitelisted" — we translate `RouteUnknownError`
    //    to `RouteNotWhitelistedError` so the call site has one error
    //    class to recognize. `RouteAmbiguousError` is preserved as-is
    //    (multiple whitelisted candidates for the same reference is a
    //    distinct failure mode the operator should see).
    let canonical: ResolvedRoute;
    try {
      const id = await this.resolver.resolve(requestedReference);
      canonical = { providerId: id.providerId, modelId: id.modelId };
    } catch (error) {
      if (error instanceof RouteUnknownError) {
        const whitelistedError = new RouteNotWhitelistedError(requestedReference);
        await this.appendAudit({
          stage: auditExtras.trigger ? "routing.natural.blocked" : "routing.blocked",
          status: "error",
          correlationId,
          requestedAlias: requestedReference,
          resolutionTier: "exact",
          resolvedProviderId: "",
          resolvedModelId: "",
          routedAgent: "",
          quarantineChecked: true,
          durationMs: this.now() - startedAt,
          errorClass: whitelistedError.name,
          ...auditExtras,
        });
        throw whitelistedError;
      }
      if (error instanceof RouteAmbiguousError) {
        await this.appendAudit({
          stage: auditExtras.trigger ? "routing.natural.blocked" : "routing.blocked",
          status: "error",
          correlationId,
          requestedAlias: requestedReference,
          resolutionTier: "normalized",
          resolvedProviderId: "",
          resolvedModelId: "",
          routedAgent: "",
          quarantineChecked: true,
          durationMs: this.now() - startedAt,
          errorClass: error.name,
          ...auditExtras,
        });
        throw error;
      }
      await this.appendAudit({
        stage: auditExtras.trigger ? "routing.natural.blocked" : "routing.blocked",
        status: "error",
        correlationId,
        requestedAlias: requestedReference,
        resolutionTier: "exact",
        resolvedProviderId: "",
        resolvedModelId: "",
        routedAgent: "",
        quarantineChecked: true,
        durationMs: this.now() - startedAt,
        errorClass: (error as Error).name,
        ...auditExtras,
      });
      throw error;
    }

    // 3. Quarantine check.
    if (this.quarantineStore.isActive(canonical.providerId, canonical.modelId)) {
      const reason = this.activeQuarantineReason(canonical.providerId, canonical.modelId);
      const message = `${canonical.providerId}/${canonical.modelId} is quarantined${reason !== null ? ` (${reason})` : ""}; refusing to route`;
      const error = new QuarantinedModelError(message);
      await this.appendAudit({
        stage: auditExtras.trigger ? "routing.natural.blocked" : "routing.blocked",
        status: "error",
        correlationId,
        requestedAlias: requestedReference,
        resolutionTier: "exact",
        resolvedProviderId: canonical.providerId,
        resolvedModelId: canonical.modelId,
        routedAgent: "",
        quarantineChecked: true,
        durationMs: this.now() - startedAt,
        errorClass: error.name,
        ...auditExtras,
      });
      throw error;
    }

    // 4. Whitelist lookup.
    const hostName = this.whitelist.findHostName(canonical.providerId, canonical.modelId);
    if (hostName === null) {
      const error = new RouteNotWhitelistedError(`${canonical.providerId}/${canonical.modelId}`);
      await this.appendAudit({
        stage: auditExtras.trigger ? "routing.natural.blocked" : "routing.blocked",
        status: "error",
        correlationId,
        requestedAlias: requestedReference,
        resolutionTier: "exact",
        resolvedProviderId: canonical.providerId,
        resolvedModelId: canonical.modelId,
        routedAgent: "",
        quarantineChecked: true,
        durationMs: this.now() - startedAt,
        errorClass: error.name,
        ...auditExtras,
      });
      throw error;
    }

    // 5. Effort selection.
    const canonicalId = `${canonical.providerId}/${canonical.modelId}`;
    const mapping = this.variants.get(canonicalId)?.levels ?? {};
    const requested: NormalizedEffortLevel = requestedEffort ?? "low";
    let targetAgent = hostName;
    let appliedLevel: NormalizedEffortLevel | null = requested;
    let fallbackReason: EffortFallbackReason | null = null;

    if (Object.keys(mapping).length === 0) {
      // No variants -> base agent + non-blocking warning.
      fallbackReason = "MODEL_HAS_NO_VARIANTS";
      appliedLevel = null;
      this.logger.warn(
        `[sdd-plugin.routing] model ${canonicalId} exposes no effort variants; dispatched base agent (requested: ${requested})`,
      );
    } else {
      if (isLevelExposed(requested, mapping)) {
        targetAgent = `${hostName}-${requested}` as typeof hostName;
      } else {
        const nearest = nearestLevel(requested, mapping);
        if (nearest !== null) {
          fallbackReason = "LEVEL_NOT_EXPOSED";
          appliedLevel = nearest;
          targetAgent = `${hostName}-${nearest}` as typeof hostName;
        } else {
          targetAgent = hostName;
        }
      }
    }

    // 6. Disk check.
    const agentFile = path.join(this.workspaceRoot, ".opencode", "agents", `${targetAgent}.md`);
    if (!existsSync(agentFile)) {
      const error = new RoutedAgentUnavailableError(agentFile);
      await this.appendAudit({
        stage: auditExtras.trigger ? "routing.natural.blocked" : "routing.blocked",
        status: "error",
        correlationId,
        requestedAlias: requestedReference,
        resolutionTier: "exact",
        resolvedProviderId: canonical.providerId,
        resolvedModelId: canonical.modelId,
        routedAgent: targetAgent,
        quarantineChecked: true,
        durationMs: this.now() - startedAt,
        errorClass: error.name,
        ...auditExtras,
        effortRequested: requested,
        effortApplied: appliedLevel,
        effortFallbackReason: fallbackReason,
      });
      throw error;
    }

    // 7. Rewrite.
    output.args = { ...output.args, subagent_type: targetAgent };

    // 8. Best-effort audit.
    await this.appendAudit({
      stage: auditExtras.trigger ? "routing.natural.launch" : "routing.launch",
      status: fallbackReason === null ? "success" : "warning",
      correlationId,
      requestedAlias: requestedReference,
      resolutionTier: "exact",
      resolvedProviderId: canonical.providerId,
      resolvedModelId: canonical.modelId,
      routedAgent: targetAgent,
      quarantineChecked: true,
      durationMs: this.now() - startedAt,
      ...auditExtras,
      effortRequested: requested,
      effortApplied: appliedLevel,
      effortFallbackReason: fallbackReason,
    });
  }

  /**
   * Append a single audit line. Wrapped in try/catch so a sink failure
   * (disk full, ENOSPC, EACCES) is logged and the dispatch still
   * returns successfully — routing is NEVER blocked by audit.
   */
  private async appendAudit(entry: ModelRouteAuditEntry): Promise<void> {
    try {
      await this.auditLogger.append(entry);
    } catch (error) {
      this.logger.error(
        `[sdd-plugin.routing] audit append failed (best-effort, continuing): ${(error as Error).message}`,
      );
    }
  }

  private correlationIdFor(input: HookInput): string {
    const callId = input.callID;
    if (typeof callId === "string" && callId.length > 0) return callId;
    return `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private activeQuarantineReason(providerId: string, modelId: string): string | null {
    const active = resolveQuarantinePrecedence(
      [...this.quarantineStore.snapshot()],
      providerId,
      modelId,
      new Date(this.now()),
    );
    return typeof active?.reason === "string" && active.reason.length > 0 ? active.reason : null;
  }
}
