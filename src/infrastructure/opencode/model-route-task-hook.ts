/**
 * Synchronous deterministic model-routing `tool.execute.before` hook.
 *
 * Two paths converge here, with EXACTLY the same downstream gate order
 * (resolve → quarantine → readiness → audit → rewrite):
 *
 *   A. Explicit-grammar path: `output.args.subagent_type` parses against
 *      the declared `model-route:v1|base|reference` grammar. The current
 *      behavior is preserved byte-for-byte (Unit 5 contract).
 *
 *   B. Natural-intent path (WU2): subagent_type does NOT carry the
 *      reserved grammar, but the WU1 parser finds exactly one trigger span
 *      in `output.args.prompt`. The extracted raw reference is resolved
 *      through the same `ModelRouteResolver` (now wired with the verified
 *      `NATURAL_MODEL_ALIASES`). The prompt itself is never mutated and
 *      is never read into the routing decision — the canonical identity
 *      is what controls every gate.
 *
 * No trigger in the prompt -> byte-for-byte legacy passthrough (no
 * rewrites, no audit). Multiple / malformed / unknown / ambiguous natural
 * intents fail closed BEFORE child creation with a localized (Spanish +
 * English) actionable error.
 *
 * Strict routing order (no silent fallback, no retry, no substitution):
 *   1. parse                            → ParsedModelRouteV1 OR NaturalModelIntent
 *   2. resolve (exact→alias→unique)     → CanonicalModelId
 *   3. quarantine reconciliation/check  → throw QuarantinedModelError
 *   4. readiness attestation            → manifest/file/hash/lock/journal/version/workspace
 *   5. synchronous durable audit        → routing[.natural].launch / .blocked
 *   6. rewrite subagent_type            → owned fixed host
 *   7. return                           → engine invokes TaskTool
 *
 * Constraints:
 *   - `args.model` is NEVER read, written, or relied on for routing on
 *     EITHER path.
 *   - The hook never mutates the disk: no generator, no manifest, no
 *     agent/command files, no lock, no journal. All disk writes belong
 *     to the pre-start CLI.
 *   - Missing/expired/mismatched attestation blocks immediately.
 *   - Off-fleet canonicals (not in the manifest whitelist) are rejected.
 *   - Audit failures are fail-closed: AUDIT_WRITE_FAILED short-circuits rewrite.
 *   - Prompt injection resistance: the prompt is data; the canonical
 *     identity is what controls every gate. The prompt is never recorded
 *     in audit entries (only the trigger label and the extracted raw
 *     reference are surfaced for traceability).
 *
 * Design: 0695919c-2264-4e0d-a3fb-f7d4190661fc.
 * WU2 design: 41aa141d-1bbf-4cd0-aba7-63f82f83fbd6.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { parseModelRouteGrammar, ModelRouteGrammarError } from "../../domain/model-routing/model-route-grammar.js";
import { ModelRouteResolver, RouteUnknownError, RouteAmbiguousError } from "../../domain/model-routing/model-route-resolver.js";
import {
  parseNaturalModelIntent,
  NaturalIntentAmbiguousError,
  NaturalIntentMalformedError,
} from "../../domain/model-routing/natural-model-intent.js";
import {
  naturalIntentAmbiguousError,
  naturalIntentMalformedError,
  naturalRouteAmbiguousError,
  naturalRouteUnknownError,
  NaturalIntentBlockedError,
} from "../../domain/model-routing/natural-model-routing-errors.js";
import type { QuarantineEntry } from "../../domain/model/quarantine.js";
import { resolveQuarantinePrecedence } from "../../domain/model/quarantine.js";
import type { QuarantineStore } from "../../infrastructure/runtime/quarantine-store.js";
import {
  AttestationExpiredError,
  AttestationMismatchError,
  ModelRouteReadiness,
  REQUIRED_OPENCODE_VERSION,
} from "./model-route-readiness.js";
import {
  ModelRouteAuditLogger,
  type ModelRouteAuditEntry,
} from "../logging/model-route-audit.logger.js";
import type { Manifest } from "./disk-agent-generator.js";

export class RoutedAgentUnavailableError extends Error { readonly code = "ROUTED_AGENT_UNAVAILABLE"; constructor(m: string) { super(`ROUTED_AGENT_UNAVAILABLE: ${m}`); this.name = "RoutedAgentUnavailableError"; } }
export class QuarantinedModelError extends Error { readonly code = "QUARANTINED_MODEL"; constructor(m: string) { super(`QUARANTINED_MODEL: ${m}`); this.name = "QuarantinedModelError"; } }
export class AttestationUnavailableError extends Error { readonly code = "ATTESTATION_UNAVAILABLE"; constructor(m: string) { super(`ATTESTATION_UNAVAILABLE: ${m}`); this.name = "AttestationUnavailableError"; } }
export class TaskHookBootIdentityMissingError extends Error { readonly code = "TASK_HOOK_BOOT_IDENTITY_MISSING"; constructor() { super("TASK_HOOK_BOOT_IDENTITY_MISSING: explicit boot identity is required (no 'boot-default', callID, or env-var fallback)"); this.name = "TaskHookBootIdentityMissingError"; } }
export class TaskHookSigningKeyMissingError extends Error { readonly code = "TASK_HOOK_SIGNING_KEY_MISSING"; constructor() { super("TASK_HOOK_SIGNING_KEY_MISSING: explicit HMAC signing key is required (no 'deterministic-key' or random fallback)"); this.name = "TaskHookSigningKeyMissingError"; } }

export interface ModelRouteTaskHookOptions {
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  readonly attestationPath?: string;
  readonly openCodeVersion?: string;
  readonly bootIdentity: string;
  readonly signingKey: string | Buffer;
  readonly resolver: ModelRouteResolver;
  readonly quarantineStore: QuarantineStore;
  readonly audit: { path: string; maxFieldBytes?: number; maxDepth?: number };
  readonly now?: () => number;
  readonly loadQuarantineEntries?: () => Promise<ReadonlyArray<QuarantineEntry>>;
}

interface HookInput { readonly tool?: string; readonly callID?: string; readonly [key: string]: unknown; }
interface HookOutput { args?: Record<string, unknown>; readonly [key: string]: unknown; }

type ResolutionTier = "exact" | "alias" | "normalized";

interface BlockedFields {
  correlationId: string;
  requestedAlias: string;
  resolutionTier: ResolutionTier;
  resolvedProviderId: string;
  resolvedModelId: string;
  routedAgent: string;
  errorClass: string;
}

export class ModelRouteTaskHook {
  private readonly workspaceRoot: string;
  private readonly manifestPath: string;
  private readonly openCodeVersion: string;
  private readonly bootIdentity: string;
  private readonly signingKey: Buffer;
  private readonly resolver: ModelRouteResolver;
  private readonly quarantineStore: QuarantineStore;
  private readonly auditLogger: ModelRouteAuditLogger;
  private readonly now: () => number;
  private readonly loadQuarantineEntries?: () => Promise<ReadonlyArray<QuarantineEntry>>;

  constructor(options: ModelRouteTaskHookOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.manifestPath = options.manifestPath ?? path.join(this.workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");
    this.openCodeVersion = options.openCodeVersion ?? REQUIRED_OPENCODE_VERSION;
    // Boot identity must come from the operator's stable host nonce; the
    // plugin never invents "boot-default", never derives one from the task
    // callID, and never reads an environment fallback. A missing boot
    // identity is a configuration error and blocks routing immediately.
    if (typeof options.bootIdentity !== "string" || options.bootIdentity.length === 0 || options.bootIdentity === "boot-default") {
      throw new TaskHookBootIdentityMissingError();
    }
    this.bootIdentity = options.bootIdentity;
    // Signing key must be the operator's explicit shared HMAC secret. There
    // is no "deterministic-key" fallback and no random per-process key.
    if (options.signingKey === undefined || options.signingKey === null) {
      throw new TaskHookSigningKeyMissingError();
    }
    const key = options.signingKey;
    if (typeof key === "string" && (key.length === 0 || key === "deterministic-key")) {
      throw new TaskHookSigningKeyMissingError();
    }
    if (key instanceof Buffer && key.length === 0) {
      throw new TaskHookSigningKeyMissingError();
    }
    this.signingKey = typeof key === "string" ? Buffer.from(key, "utf8") : key;
    this.resolver = options.resolver;
    this.quarantineStore = options.quarantineStore;
    const auditOptions: { path: string; maxFieldBytes?: number; maxDepth?: number } = { path: options.audit.path };
    if (options.audit.maxFieldBytes !== undefined) auditOptions.maxFieldBytes = options.audit.maxFieldBytes;
    if (options.audit.maxDepth !== undefined) auditOptions.maxDepth = options.audit.maxDepth;
    this.auditLogger = new ModelRouteAuditLogger(auditOptions);
    this.now = options.now ?? Date.now;
    if (options.loadQuarantineEntries !== undefined) this.loadQuarantineEntries = options.loadQuarantineEntries;
  }

  async execute(input: HookInput, output: HookOutput): Promise<void> {
    if (input.tool !== "task") return;

    const subagentType = typeof output.args?.["subagent_type"] === "string"
      ? (output.args["subagent_type"] as string)
      : undefined;

    let parsed: ReturnType<typeof parseModelRouteGrammar> = null;
    if (typeof subagentType === "string") {
      try {
        parsed = parseModelRouteGrammar(subagentType);
      } catch (error) {
        if (error instanceof ModelRouteGrammarError) {
          await this.block(this.correlationIdFor(input), subagentType, "", "", "", error.name);
        }
        throw error;
      }
    }

    // Path A: explicit `model-route:v1|base|reference` grammar. The
    // existing routing pipeline is preserved byte-for-byte; this is
    // unchanged from Unit 5.
    if (parsed !== null) {
      await this.routeFromGrammar(input, output, parsed);
      return;
    }

    // Path B: WU2 natural-intent path. The prompt is data; the canonical
    // identity is what controls every gate. The prompt itself is never
    // mutated, never read into the routing decision, and is preserved
    // byte-for-byte across the rewrite.
    const promptRaw = output.args?.["prompt"];
    if (typeof promptRaw !== "string" || promptRaw.length === 0) {
      // No prompt -> nothing to parse; byte-for-byte legacy passthrough.
      return;
    }
    const prompt = promptRaw;

    // Parse the prompt for the WU1 bounded trigger set. No trigger ->
    // byte-for-byte legacy passthrough (no rewrites, no audit).
    let intent: ReturnType<typeof parseNaturalModelIntent> = null;
    try {
      intent = parseNaturalModelIntent(prompt);
    } catch (error) {
      if (error instanceof NaturalIntentAmbiguousError) {
        const blocked = naturalIntentAmbiguousError(error.count);
        await this.blockNatural(
          this.correlationIdFor(input),
          blocked.code,
          "",
          "",
          "",
          blocked.code,
          undefined,
        );
        throw blocked;
      }
      if (error instanceof NaturalIntentMalformedError) {
        const blocked = naturalIntentMalformedError(
          // The parser already carries the raw trigger label inside its
          // own message; we forward it to the audit + error extras.
          // The parser does not currently expose the trigger label
          // directly, so we surface the input boundary.
          "natural",
          error.code,
          error.code === "BYTE_LIMIT_EXCEEDED"
            ? `input was ${Buffer.byteLength(prompt, "utf8")} bytes`
            : error.code === "CONTROL_CHARACTER"
              ? "see original input"
              : "reference was empty after trimming",
        );
        await this.blockNatural(
          this.correlationIdFor(input),
          blocked.code,
          "",
          "",
          "",
          blocked.code,
          undefined,
        );
        throw blocked;
      }
      throw error;
    }
    if (intent === null) {
      // No trigger in the prompt -> byte-for-byte legacy passthrough.
      return;
    }

    await this.routeFromIntent(input, output, intent);
  }

  /**
   * Path A: explicit-grammar routing. Preserved from Unit 5.
   */
  private async routeFromGrammar(
    input: HookInput,
    output: HookOutput,
    parsed: NonNullable<ReturnType<typeof parseModelRouteGrammar>>,
  ): Promise<void> {
    const startedAt = this.now();
    const correlationId = this.correlationIdFor(input);
    const requestedAlias = parsed.reference;

    if (this.loadQuarantineEntries) {
      try {
        const entries = await this.loadQuarantineEntries();
        this.quarantineStore.reconcile([...entries]);
      } catch (error) {
        await this.block(correlationId, requestedAlias, "", "", "", (error as Error).name);
        throw error;
      }
    }

    let canonical;
    try {
      canonical = await this.resolver.resolve(parsed.reference);
    } catch (error) {
      const errorClass = error instanceof RouteUnknownError
        ? "RouteUnknownError"
        : error instanceof RouteAmbiguousError
          ? "RouteAmbiguousError"
          : (error as Error).name;
      await this.block(correlationId, requestedAlias, "", "", "", errorClass);
      throw error;
    }

    if (this.quarantineStore.isActive(canonical.providerId, canonical.modelId)) {
      const reason = this.activeQuarantineReason(canonical.providerId, canonical.modelId);
      const error = new QuarantinedModelError(
        `${canonical.providerId}/${canonical.modelId} is quarantined${reason !== null ? ` (${reason})` : ""}; refusing to route`,
      );
      await this.block(correlationId, requestedAlias, canonical.providerId, canonical.modelId, "", error.name);
      throw error;
    }

    const manifest = this.readManifest();
    const hostName = this.manifestHostNameFor(manifest, canonical.providerId, canonical.modelId);
    if (hostName === null) {
      const error = new RoutedAgentUnavailableError(`${canonical.providerId}/${canonical.modelId} is not in the routing manifest fleet whitelist`);
      await this.block(correlationId, requestedAlias, canonical.providerId, canonical.modelId, "", error.name);
      throw error;
    }

    try {
      new ModelRouteReadiness({
        workspaceRoot: this.workspaceRoot,
        now: this.now,
        signingKey: this.signingKey,
      }).verify({
        manifest,
        openCodeVersion: this.openCodeVersion,
        bootIdentity: this.bootIdentity,
      });
    } catch (error) {
      const errorClass = error instanceof AttestationExpiredError
        ? "AttestationExpiredError"
        : error instanceof AttestationMismatchError
          ? "AttestationMismatchError"
          : "AttestationUnavailableError";
      await this.block(correlationId, requestedAlias, canonical.providerId, canonical.modelId, hostName, errorClass);
      if (error instanceof AttestationExpiredError || error instanceof AttestationMismatchError) throw error;
      throw new AttestationUnavailableError((error as Error).message);
    }

    await this.auditLogger.append({
      stage: "routing.launch",
      status: "success",
      correlationId,
      requestedAlias,
      resolutionTier: "exact",
      resolvedProviderId: canonical.providerId,
      resolvedModelId: canonical.modelId,
      routedAgent: hostName,
      quarantineChecked: true,
      durationMs: this.now() - startedAt,
    });

    output.args = { ...output.args, subagent_type: hostName };
  }

  /**
   * Path B (WU2): natural-intent routing. The prompt is data; the
   * canonical identity controls every gate. The prompt is never mutated
   * and never recorded in the audit entry. Only the trigger label and
   * the extracted raw reference are surfaced for traceability.
   */
  private async routeFromIntent(
    input: HookInput,
    output: HookOutput,
    intent: NonNullable<ReturnType<typeof parseNaturalModelIntent>>,
  ): Promise<void> {
    const startedAt = this.now();
    const correlationId = this.correlationIdFor(input);
    const requestedAlias = intent.rawReference;
    const trigger = intent.trigger;

    if (this.loadQuarantineEntries) {
      try {
        const entries = await this.loadQuarantineEntries();
        this.quarantineStore.reconcile([...entries]);
      } catch (error) {
        await this.blockNatural(correlationId, "RouteResolverError", "", "", "", (error as Error).name, trigger);
        throw error;
      }
    }

    let canonical;
    try {
      canonical = await this.resolver.resolve(intent.rawReference);
    } catch (error) {
      if (error instanceof RouteUnknownError) {
        const blocked = naturalRouteUnknownError(intent.rawReference);
        await this.blockNatural(
          correlationId,
          blocked.code,
          "",
          "",
          "",
          blocked.code,
          trigger,
        );
        throw blocked;
      }
      if (error instanceof RouteAmbiguousError) {
        const blocked = naturalRouteAmbiguousError(intent.rawReference, error.candidates);
        await this.blockNatural(
          correlationId,
          blocked.code,
          "",
          "",
          "",
          blocked.code,
          trigger,
        );
        throw blocked;
      }
      const errorClass = (error as Error).name;
      await this.blockNatural(correlationId, errorClass, "", "", "", errorClass, trigger);
      throw error;
    }

    if (this.quarantineStore.isActive(canonical.providerId, canonical.modelId)) {
      const reason = this.activeQuarantineReason(canonical.providerId, canonical.modelId);
      const error = new QuarantinedModelError(
        `${canonical.providerId}/${canonical.modelId} is quarantined${reason !== null ? ` (${reason})` : ""}; refusing to route`,
      );
      await this.blockNatural(
        correlationId,
        error.name,
        canonical.providerId,
        canonical.modelId,
        "",
        error.name,
        trigger,
      );
      throw error;
    }

    const manifest = this.readManifest();
    const hostName = this.manifestHostNameFor(manifest, canonical.providerId, canonical.modelId);
    if (hostName === null) {
      const error = new RoutedAgentUnavailableError(`${canonical.providerId}/${canonical.modelId} is not in the routing manifest fleet whitelist`);
      await this.blockNatural(
        correlationId,
        error.name,
        canonical.providerId,
        canonical.modelId,
        "",
        error.name,
        trigger,
      );
      throw error;
    }

    try {
      new ModelRouteReadiness({
        workspaceRoot: this.workspaceRoot,
        now: this.now,
        signingKey: this.signingKey,
      }).verify({
        manifest,
        openCodeVersion: this.openCodeVersion,
        bootIdentity: this.bootIdentity,
      });
    } catch (error) {
      const errorClass = error instanceof AttestationExpiredError
        ? "AttestationExpiredError"
        : error instanceof AttestationMismatchError
          ? "AttestationMismatchError"
          : "AttestationUnavailableError";
      await this.blockNatural(
        correlationId,
        errorClass,
        canonical.providerId,
        canonical.modelId,
        hostName,
        errorClass,
        trigger,
      );
      if (error instanceof AttestationExpiredError || error instanceof AttestationMismatchError) throw error;
      throw new AttestationUnavailableError((error as Error).message);
    }

    await this.auditLogger.append({
      stage: "routing.natural.launch",
      status: "success",
      correlationId,
      requestedAlias,
      resolutionTier: "alias",
      resolvedProviderId: canonical.providerId,
      resolvedModelId: canonical.modelId,
      routedAgent: hostName,
      quarantineChecked: true,
      trigger,
      requestedNaturalReference: intent.rawReference,
      durationMs: this.now() - startedAt,
    });

    // Rewrite ONLY the declared `subagent_type`. The prompt and every
    // other `output.args` field (including `model`) are preserved
    // byte-for-byte via the spread.
    output.args = { ...output.args, subagent_type: hostName };
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

  private readManifest(): Manifest {
    return JSON.parse(readFileSync(this.manifestPath, "utf8")) as Manifest;
  }

  private manifestHostNameFor(manifest: Manifest, providerId: string, modelId: string): string | null {
    for (const route of manifest.routes) {
      if (route.providerId === providerId && route.modelId === modelId) return route.hostName;
    }
    return null;
  }

  private async block(correlationId: string, requestedAlias: string, resolvedProviderId: string, resolvedModelId: string, routedAgent: string, errorClass: string): Promise<void> {
    const fields: BlockedFields = {
      correlationId, requestedAlias, resolutionTier: "exact",
      resolvedProviderId, resolvedModelId, routedAgent, errorClass,
    };
    const entry: ModelRouteAuditEntry = {
      stage: "routing.blocked",
      status: "error",
      correlationId: fields.correlationId,
      requestedAlias: fields.requestedAlias,
      resolutionTier: fields.resolutionTier,
      resolvedProviderId: fields.resolvedProviderId,
      resolvedModelId: fields.resolvedModelId,
      routedAgent: fields.routedAgent,
      quarantineChecked: true,
      durationMs: 0,
      errorClass: fields.errorClass,
    };
    await this.auditLogger.append(entry);
  }

  /**
   * WU2: emit a `routing.natural.blocked` audit entry. Mirrors `block`
   * but tags the stage as natural so audit consumers can distinguish
   * caller-declared routes from natural-language requests. The raw
   * prompt is NEVER recorded; only the trigger label is surfaced.
   */
  private async blockNatural(
    correlationId: string,
    errorCode: string,
    resolvedProviderId: string,
    resolvedModelId: string,
    routedAgent: string,
    errorClass: string,
    trigger: string | undefined,
  ): Promise<void> {
    const entry: ModelRouteAuditEntry = {
      stage: "routing.natural.blocked",
      status: "error",
      correlationId,
      requestedAlias: errorCode,
      resolutionTier: "alias",
      resolvedProviderId,
      resolvedModelId,
      routedAgent,
      quarantineChecked: true,
      durationMs: 0,
      errorClass,
      ...(trigger !== undefined ? { trigger } : {}),
    };
    await this.auditLogger.append(entry);
  }
}
