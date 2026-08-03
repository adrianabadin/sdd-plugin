/**
 * Application services for SDD entry flow (WU10 tasks EF-1 to EF-21).
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-entry-flow`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§3, §8).
 */

import {
  parseRequestTextDomain,
  slugifyTaskDescription,
  resolveChangeNameDomain,
  type ParsedRequest,
  type ResolvedChangeName,
} from "../../domain/sdd/entry-flow.js";
import { sddHealthKey } from "../../domain/sdd/sdd-keys.js";
import type { SddArtifactStorePort } from "../../ports/sdd-artifact-store.port.js";
import {
  RouteUnknownError,
  RouteAmbiguousError,
} from "../../domain/model-routing/model-route-resolver.js";
import { QuarantinedModelError } from "../../infrastructure/opencode/model-route-task-hook.js";
import { withAbortableTimeout, SemanticGatewayTimeoutError } from "./semantic-gateway.js";

export class GatewayTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayTimeoutError";
  }
}

export interface ParseRequestOptions {
  service?: {
    parse?: (text: string) => Promise<ParsedRequest>;
    fallbackService?: () => Promise<void>;
  };
  timeoutMs?: number;
}

export async function sddParseRequest(
  text: string,
  options?: ParseRequestOptions,
): Promise<ParsedRequest> {
  if (options?.service?.parse) {
    // EF-4: a gateway parse call is bounded by `timeoutMs`. The earlier
    // implementation only caught a synchronous throw from `service.parse` —
    // it never read `timeoutMs` and a genuinely hanging gateway call would
    // hang forever. `withAbortableTimeout` arms a real `AbortController`
    // (the same primitive SG-5 uses) so a hanging `parse` is aborted and
    // surfaced as `GatewayTimeoutError` when `timeoutMs` elapses.
    const runParse = async (): Promise<ParsedRequest> => {
      try {
        return await options.service!.parse!(text);
      } catch (err: unknown) {
        if (err instanceof GatewayTimeoutError) {
          throw err;
        }
        throw new GatewayTimeoutError(`Gateway call failed: ${(err as Error).message}`);
      }
    };
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      try {
        return await withAbortableTimeout((signal) => {
          // If parse honors AbortSignal it can short-circuit; either way the
          // controller aborting makes withAbortableTimeout reject on timeout.
          void signal;
          return runParse();
        }, options.timeoutMs);
      } catch (err: unknown) {
        // withAbortableTimeout translates the controller abort into
        // SemanticGatewayTimeoutError; EF-4's contract is GatewayTimeoutError.
        if (err instanceof SemanticGatewayTimeoutError) {
          throw new GatewayTimeoutError(
            `Gateway call timed out after ${options.timeoutMs}ms`,
          );
        }
        throw err;
      }
    }
    return runParse();
  }
  return parseRequestTextDomain(text);
}

export function deriveChangeName(taskDescription: string): string {
  return slugifyTaskDescription(taskDescription);
}

export function resolveChangeName(
  derivedSlug: string,
  existingChanges: readonly { changeName: string }[],
): ResolvedChangeName {
  return resolveChangeNameDomain(derivedSlug, existingChanges);
}

export interface PreflightProbeOptions {
  initialized?: boolean;
  gatewayReachable?: boolean;
  pmcContextAvailable?: boolean;
}

export interface PreflightProbeResult {
  healthy: boolean;
  refused: boolean;
  reason?: string;
  degradedGateway?: boolean;
  batchNotesDisabled?: boolean;
  directQuestions?: boolean;
  degradedPmcContext?: boolean;
  plainReads?: boolean;
}

export async function runPreflightProbe(
  _projectRoot: string,
  projectRootHash: string,
  store: SddArtifactStorePort,
  options?: PreflightProbeOptions,
): Promise<PreflightProbeResult> {
  // EF-16: Unbootstrapped project check
  if (options?.initialized === false) {
    return {
      healthy: false,
      refused: true,
      reason: "Project unbootstrapped. Run 'pmc init' or 'map-project' first.",
    };
  }

  // EF-20, EF-21: Health probe performs write-then-read-back on fixed key sdd-health/{projectRootHash}
  const healthKey = sddHealthKey(projectRootHash);
  const probePayload = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await store.writeArtifact(healthKey, probePayload);
    const readBack = await store.readArtifact(healthKey);

    if (readBack !== probePayload) {
      return {
        healthy: false,
        refused: true,
        reason: "Unreachable artifact store (write-readback failed).",
      };
    }
  } catch (err: unknown) {
    return {
      healthy: false,
      refused: true,
      reason: `Unreachable artifact store probe error: ${(err as Error).message}`,
    };
  }

  // EF-18: Unreachable gateway degrades instead of refusing
  const degradedGateway = options?.gatewayReachable === false;
  // EF-19: Unavailable pmc_get_context degrades
  const degradedPmcContext = options?.pmcContextAvailable === false;

  return {
    healthy: true,
    refused: false,
    degradedGateway,
    batchNotesDisabled: degradedGateway,
    directQuestions: degradedGateway,
    degradedPmcContext,
    plainReads: degradedPmcContext,
  };
}

export interface ModelRouteResolverLike {
  resolve(reference: string): Promise<{ providerId: string; modelId: string }>;
}

export interface ModelResolutionResult {
  subagentType?: string;
  canonicalRef?: string;
  blockedOn?: {
    phase: string;
    question: string;
    progressSummary: string;
  };
}

export async function resolveModelPhraseAndFormatGrammar(
  modelPhrase: string | null,
  resolver: ModelRouteResolverLike,
  defaultConfiguredModel: string,
): Promise<ModelResolutionResult> {
  // EF-15: Unnamed model still dispatches through grammar with default model
  if (!modelPhrase) {
    return {
      subagentType: `model-route:v1|sdd-mr-base|${defaultConfiguredModel}`,
      canonicalRef: defaultConfiguredModel,
    };
  }

  try {
    const canonical = await resolver.resolve(modelPhrase);
    const canonicalRef = `${canonical.providerId}/${canonical.modelId}`;
    return {
      subagentType: `model-route:v1|sdd-mr-base|${canonicalRef}`,
      canonicalRef,
    };
  } catch (err: unknown) {
    // EF-12: RouteUnknownError becomes blockedOn question
    if (err instanceof RouteUnknownError) {
      return {
        blockedOn: {
          phase: "entry",
          question: `Unknown model phrase "${modelPhrase}". Please specify a valid model reference.`,
          progressSummary: "Blocked on unknown model phrase resolution",
        },
      };
    }
    // EF-13: RouteAmbiguousError surfaces candidates list
    if (err instanceof RouteAmbiguousError) {
      const candidates = (err as RouteAmbiguousError).candidates;
      const candidatesText = candidates.map((c) => `${c.providerId}/${c.modelId}`).join(", ");
      return {
        blockedOn: {
          phase: "entry",
          question: `Ambiguous model phrase "${modelPhrase}". Candidates: ${candidatesText}`,
          progressSummary: "Blocked on ambiguous model phrase resolution",
        },
      };
    }
    // EF-14: QuarantinedModelError surfaces as blockedOn question
    if (err instanceof QuarantinedModelError || (err as Error).name === "QuarantinedModelError") {
      return {
        blockedOn: {
          phase: "entry",
          question: `Model phrase "${modelPhrase}" resolved to a quarantined model. Please select an active model.`,
          progressSummary: "Blocked on quarantined model resolution",
        },
      };
    }
    throw err;
  }
}

export interface SddGoOptions {
  requestText: string;
  projectRoot: string;
  projectRootHash: string;
  store: SddArtifactStorePort;
  initialized?: boolean;
  existingChanges?: readonly { changeName: string }[];
  defaultModel?: string;
  modelResolver?: ModelRouteResolverLike;
  onGateEvaluated?: (gateName: string) => void;
}

export interface SddGoResult {
  action: "route" | "refused" | "blocked";
  reason?: string;
  changeName?: string;
  subagentType?: string;
  blockedOn?: {
    phase: string;
    question: string;
    progressSummary: string;
  };
  editedFiles?: undefined;
}

export async function runSddGo(options: SddGoOptions): Promise<SddGoResult> {
  const {
    requestText,
    projectRoot,
    projectRootHash,
    store,
    initialized = true,
    existingChanges = [],
    defaultModel = "claude-3-5-sonnet",
    modelResolver,
    onGateEvaluated,
  } = options;

  // Gate 1: explicit SDD mention (EF-8, EF-9)
  onGateEvaluated?.("explicitSddMention");
  const parsed = await sddParseRequest(requestText);
  if (!parsed.explicitSddMention) {
    return {
      action: "refused",
      reason: "No explicit SDD mention",
    };
  }

  // Gate 2: preflight health probe (EF-16, EF-17, EF-9)
  onGateEvaluated?.("preflightProbe");
  const probe = await runPreflightProbe(projectRoot, projectRootHash, store, { initialized });
  if (probe.refused) {
    return {
      action: "refused",
      ...(probe.reason !== undefined ? { reason: probe.reason } : {}),
    };
  }

  // Gate 3: model resolution (EF-11, EF-12, EF-13, EF-14, EF-15, EF-9)
  onGateEvaluated?.("modelResolution");
  let subagentType = `model-route:v1|sdd-mr-base|${defaultModel}`;
  if (parsed.modelPhrase && modelResolver) {
    const res = await resolveModelPhraseAndFormatGrammar(parsed.modelPhrase, modelResolver, defaultModel);
    if (res.blockedOn) {
      return {
        action: "blocked",
        blockedOn: res.blockedOn,
      };
    }
    if (res.subagentType) {
      subagentType = res.subagentType;
    }
  }

  // Gate 4: change resolution (EF-5, EF-6, EF-7, EF-9)
  onGateEvaluated?.("changeResolution");
  const derivedSlug = deriveChangeName(parsed.taskDescription);
  const changeRes = resolveChangeName(derivedSlug, existingChanges);

  if (changeRes.askUser) {
    return {
      action: "blocked",
      blockedOn: {
        phase: "entry",
        question: `Multiple changes match '${derivedSlug}': ${changeRes.candidates?.join(", ")}. Which one would you like to use?`,
        progressSummary: "Blocked on change selection",
      },
    };
  }

  // EF-10: /sdd-go ONLY routes; never edits files or implements
  return {
    action: "route",
    changeName: changeRes.changeName ?? derivedSlug,
    subagentType,
    editedFiles: undefined,
  };
}
