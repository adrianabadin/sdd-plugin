/**
 * Composition root: the ONLY module that knows how to instantiate
 * adapters and wire them into use cases.
 *
 * The plugin contract: an async function that receives the OpenCode
 * runtime context and returns a map of hook handlers.
 *
 * Rev 2 — no boot identity, no signing key, no lease, no foreign-agent
 * scan, no OpenCode version check. Routing is wired directly from
 * `routes.json` (whitelist) + `variants.json` (variant snapshot). The
 * hook works in a plain OpenCode session that knows nothing about the
 * routing infrastructure.
 */
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../infrastructure/prisma/generated-prisma-client.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ListConnectedModelsUseCase } from "../application/list-connected-models/list-connected-models.use-case.js";
import { SyncConnectedModelsUseCase } from "../application/sync-connected-models/sync-connected-models.use-case.js";
import { SaveModelDetailUseCase } from "../application/save-model-detail/save-model-detail.use-case.js";
import { ListQuarantinesUseCase } from "../application/quarantine/index.js";
import { BackgroundModelRefreshCoordinator } from "../application/background-model-refresh-coordinator.js";
import { OpenCodeAppLogNotifierAdapter } from "../infrastructure/logging/opencode-app-log.notifier.adapter.js";
import { ModelRefreshTraceLogger } from "../infrastructure/logging/model-refresh-trace.logger.js";
import { OpenCodeModelCatalogAdapter } from "../infrastructure/opencode/opencode-model-catalog.adapter.js";
import { PrismaModelRouteQuarantineAdapter } from "../infrastructure/prisma/model-route-quarantine.adapter.js";
import { PrismaModelRepositoryAdapter } from "../infrastructure/prisma/prisma-model-repository.adapter.js";
import { ModelRouteResolver } from "../domain/model-routing/model-route-resolver.js";
import { RouteWhitelist, loadRouteWhitelist } from "../domain/model-routing/route-whitelist.js";
import { parseModelRouteGrammar } from "../domain/model-routing/model-route-grammar.js";
import { NATURAL_MODEL_ALIASES } from "../domain/model-routing/natural-model-aliases.js";
import { parseNaturalModelIntent } from "../domain/model-routing/natural-model-intent.js";
import { ModelRouteTaskHook } from "../infrastructure/opencode/model-route-task-hook.js";
import { readVariantSnapshot } from "../infrastructure/opencode/variant-snapshot.js";
import { resolveDatabasePath, initializeDatabase } from "../infrastructure/runtime/database-path.js";
import { getOrCreateModelConfigRegistry } from "../infrastructure/runtime/model-config-registry.js";
import { getGlobalQuarantineStore } from "../infrastructure/runtime/quarantine-store.js";
import { SqliteMcpToolClient } from "../infrastructure/pmc/sqlite-mcp-tool-client.adapter.js";
import { PmcSddArtifactStoreAdapter } from "../infrastructure/pmc/pmc-sdd-artifact-store.adapter.js";
import { createProjectConfigSkillResolverFactory } from "../infrastructure/skills/project-config-skill-resolver.factory.js";
import { buildSddTools } from "./sdd-tools.js";

/**
 * Clients created by this composition root.
 *
 * The OpenCode bootstrap contract (`SddPluginContext`) exposes no lifecycle or
 * dispose callback, so there is no host hook to register against. Ownership is
 * therefore explicit: every client built here is tracked and released by
 * `disposeBootstrapPersistence()`, which is idempotent and single-flight.
 */
const bootstrapClients = new Set<PrismaClient>();
let bootstrapDisposePromise: Promise<void> | null = null;

/**
 * Apply the runtime PRAGMAs every bootstrap connection must enforce:
 * `foreign_keys = ON`, `synchronous = FULL`, and `busy_timeout = 5000`. libSQL
 * opens a fresh native SQLite connection per Prisma client and inherits the
 * file's journal_mode; `foreign_keys`, `synchronous`, and `busy_timeout` are
 * per-connection settings that must be applied directly through the Prisma
 * client. The async call is dispatched so the synchronous getPrismaClient()
 * boundary stays compatible with the existing composition contract; any
 * failure is logged, never swallowed.
 *
 * `busy_timeout` enforces the bounded contention bound the persistence spec
 * requires: writers wait up to 5000ms for the SQLite writer lock to clear
 * before failing explicitly. The value is the same constant the TUI writer
 * and verifier use so the bootstrap client honors the same contract.
 */
async function applyRuntimePragmas(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
  await client.$executeRawUnsafe('PRAGMA synchronous = FULL;');
  await client.$executeRawUnsafe('PRAGMA busy_timeout = 5000;');
}

export function getPrismaClient(): PrismaClient {
  const dbPath = initializeDatabase();
  const prismaAdapter = new PrismaLibSql({
    url: `file:${dbPath}`,
    // libsql's open-time timeout is what governs SQLITE_BUSY behavior in
    // practice; `PRAGMA busy_timeout` alone is insufficient. Setting the
    // timeout at construction pins the bounded contention bound the spec
    // requires and matches the PRAGMA readback invariant.
    timeout: BOOTSTRAP_BUSY_TIMEOUT_MS,
  });
  const client = new PrismaClient({ adapter: prismaAdapter });
  bootstrapClients.add(client);
  void applyRuntimePragmas(client).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sdd-plugin.bootstrap] runtime PRAGMA failure: ${message}`);
  });
  bootstrapDisposePromise = null;
  return client;
}

/** Per-connection busy_timeout applied to the bootstrap Prisma client. */
export const BOOTSTRAP_BUSY_TIMEOUT_MS = 5000;

/**
 * Release every Prisma client owned by the bootstrap composition root.
 *
 * Safe to call repeatedly and concurrently: each tracked client receives
 * exactly one `$disconnect()` per shutdown cycle.
 */
export function disposeBootstrapPersistence(): Promise<void> {
  if (!bootstrapDisposePromise) {
    const owned = [...bootstrapClients];
    bootstrapClients.clear();
    bootstrapDisposePromise = (async () => {
      await Promise.allSettled(owned.map((client) => client.$disconnect()));
    })();
  }
  return bootstrapDisposePromise;
}

/**
 * Per-step trace logger for the model refresh pipeline. The default
 * file sink targets `~/.cache/sdd-plugin/model-refresh.log`; tests
 * (and any caller that wants to inject) supply their own sink via
 * `SDD_PLUGIN_TRACE_PATH` or a custom logger instance.
 *
 * Trace path is read on construction so a process can redirect the
 * log without code changes (CI runners, hermetic test runners, etc).
 */
const traceLogger = new ModelRefreshTraceLogger();

/**
 * The exported OpenCode plugin entrypoint. The runtime hands us a
 * context object; we extract what we need and wire the use cases.
 *
 * The function is intentionally permissive about the runtime shape
 * (`ctx: any`): OpenCode does not publish a plugin type contract.
 */
/**
 * Render a stable, human-readable label for the host project.
 *
 * OpenCode passes `project` as a Project OBJECT (`{ id, worktree, ... }`), not
 * a string; interpolating it directly renders "[object Object]" in every log
 * line and destroys the only identifier those lines carry. Tests and internal
 * callers still pass a plain string, so both shapes are supported.
 */
function resolveProjectLabel(project: SddPluginContext["project"]): string {
  if (typeof project === "string" && project.length > 0) return project;
  if (project && typeof project === "object") {
    const { id, worktree } = project as { id?: unknown; worktree?: unknown };
    if (typeof id === "string" && id.length > 0) return id;
    if (typeof worktree === "string" && worktree.length > 0) return worktree;
  }
  return "opencode";
}

export const SddPlugin = async (ctx: SddPluginContext) => {
  const project = resolveProjectLabel(ctx?.project);
  const directory = ctx?.directory ?? "";
  const client = ctx?.client;

  const logger = {
    info: (message: string) => console.log(`[${project}] INFO: ${message}`),
    error: (message: string, err: unknown) =>
      console.error(`[${project}] ERROR: ${message}`, err),
  };

  const prisma = getPrismaClient();
  const catalog = new OpenCodeModelCatalogAdapter(client ?? {}, { trace: traceLogger });
  const repository = new PrismaModelRepositoryAdapter(prisma, { trace: traceLogger });
  const notifier = new OpenCodeAppLogNotifierAdapter(client ?? {}, { trace: traceLogger });

  const syncUseCase = new SyncConnectedModelsUseCase(catalog, repository);
  const listUseCase = new ListConnectedModelsUseCase(notifier);

  /**
   * Wrap the actual refresh cycle in a top-level trace so the runtime
   * debugger can grep the cycle start/end. The use case and adapter
   * already emit their own per-step events; this adds the cycle
   * boundary without leaking SDK/Prisma knowledge into the use case.
   */
  const refreshFn = async () => {
    const correlationId = traceLogger.newCorrelationId();
    const startedAt = Date.now();
    traceLogger.trace({
      correlationId,
      stage: "refresh.start",
      status: "start",
      details: { project },
    });
    try {
      const result = await syncUseCase.execute({ correlationId });
      await listUseCase.execute({ refreshed: result.refreshed, correlationId });
      traceLogger.trace({
        correlationId,
        stage: "refresh.finish",
        status: "success",
        durationMs: Date.now() - startedAt,
        details: { refreshedCount: result.refreshed.length },
      });
    } catch (error) {
      traceLogger.error({
        correlationId,
        stage: "refresh.finish",
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
    try {
      await traceLogger.flush();
    } catch {
      // Best-effort flush; refresh already settled.
    }
  };
  const coordinator = new BackgroundModelRefreshCoordinator(refreshFn, logger);

  logger.info(
    `Plugin loaded (cwd=${directory}). Background model refresh coordinator initialized.`,
  );

// SDD MCP tool surface: the EIGHT tools the phase-agent system exposes to
  // the LLM (versioned-contract surface — see
  // `src/bootstrap/sdd-tools.ts` module header and the apply log under
  // the versioned-contract section). The persistence backend is the
  // SQLite-direct McpToolClient (Option B bridge) talking to the same
  // agent-memory-mcp DB OpenCode spawns. Construction is defensive: if
  // the SQLite bridge cannot resolve its DB path, the tools are omitted
  // rather than crashing the whole plugin (the routing hook still works)
  // — but a clear error is logged.
  let sddTools: Record<string, unknown> | undefined;
  try {
    const sddMcpClient = new SqliteMcpToolClient();
    const sddStore = new PmcSddArtifactStoreAdapter(sddMcpClient);
    // Skill resolution reads each project's OWN persisted init config
    // (`sdd-init/{hash}.skillPaths`), which `sdd_save_config` validates before
    // it can be written. Without a real resolver here the default in
    // `composePhasePrompt` always returns null (PC-6), so `sdd-tasks` and
    // `sdd-apply` — the only phases with mandatory skills — could never
    // compose in production.
    //
    // The FACTORY is passed unbound: `buildSddTools` invokes it with the
    // per-call `args.projectRoot` on every invocation (W-N1 — the module's
    // documented invariant forbids a startup-time `directory` capture), and
    // the factory reads THAT root's checkpoint each time. The previous
    // registry resolver read a gitignored, externally-generated
    // `.atl/skill-registry.md` that a fresh clone never has; the config is
    // written by the SDD init round itself, so there is no external producer
    // to depend on. See
    // `src/infrastructure/skills/project-config-skill-resolver.factory.ts`.
    sddTools = buildSddTools({
      store: sddStore,
      changeStateStore: sddStore,
      createSkillResolver: createProjectConfigSkillResolverFactory(sddStore),
      // W-N2 — best-effort lock releases on compose failure must not fail
      // silently; the original compose error is still the one rethrown.
      onLockReleaseError: (releaseError) =>
        logger.error("SDD compose lock release failed (best-effort; original compose error preserved).", releaseError),
    });
    // The eight-tool shape is a deliberate versioned-contract change vs
    // the pre-recovery seven-tool design (design §2). The companion
    // port changes (`boundChangeName` on the change-state port,
    // `persistArtifactWithOwnership` on the artifact-store port,
    // `verifyInitRoundOwnership` on the change-state port) are also
    // documented at the module level in `src/bootstrap/sdd-tools.ts`
    // and in the apply log under the versioned-contract section.
    logger.info(
      "SDD MCP tool surface registered (8 tools: sdd_status, sdd_compose_phase_prompt, sdd_save_artifact, sdd_parse_request, sdd_init_questions, sdd_save_config, sdd_checkpoint, sdd_recover_phase_lock).",
    );
  } catch (err) {
    logger.error("SDD MCP tool surface disabled (persistence backend unavailable).", err);
  }

  return {
    ...(sddTools ? { tool: sddTools } : {}),
    /**
     * Intercept the `task` tool to take control of the workflow /
     * subagent spawning. We MUST NOT mutate `output` — the task must
     * run exactly as the LLM requested. We catch errors so a sync
     * failure never blocks the task itself.
     *
     * Interception is registry-first with DB read-through / hydration fallback.
     */
    "tool.execute.before": async (
      _input: { tool?: string; callID?: string },
      output: { args?: { subagent_type?: string; model?: string; [key: string]: unknown } },
    ) => {
      if (_input.tool !== "task") return;

      const subagentType = output.args?.subagent_type ?? "unknown";
      logger.info(
        `Intercepting task: ${subagentType}`,
      );

      const routingGrammar = typeof subagentType === "string"
        ? parseModelRouteGrammar(subagentType)
        : null;

      if (routingGrammar !== null) {
        // Reserved routing grammar: defer entirely to the deterministic
        // routing pipeline. The legacy code (which reads args.model) is
        // intentionally NOT invoked for routing calls so that the new
        // pipeline can own the parse → resolve → quarantine → whitelist
        // → variant → disk → audit → rewrite sequence without any fallback.
        const routingQuarantineAdapter = new PrismaModelRouteQuarantineAdapter(prisma);
        const workspaceRoot = directory || process.cwd();
        const whitelist = loadRouteWhitelist(workspaceRoot);
        const variants = readVariantSnapshot(workspaceRoot);
        const routingResolver = new ModelRouteResolver(whitelist, new Map());
        const auditPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "routing.audit.jsonl");
        const routingHook = new ModelRouteTaskHook({
          workspaceRoot,
          whitelist,
          variants,
          resolver: routingResolver,
          quarantineStore: getGlobalQuarantineStore(),
          audit: { path: auditPath },
          loadQuarantineEntries: async () => routingQuarantineAdapter.listActive(),
          logger: {
            info: (m: string) => logger.info(m),
            warn: (m: string) => console.warn(`[${project}] WARN: ${m}`),
            error: (m: string) => logger.error(m, null),
          },
        });
        await routingHook.execute(_input, output);
        return;
      }

      // WU2: natural-intent path. The subagent_type is NOT the reserved
      // routing grammar, but the WU1 bounded trigger set may still be
      // present in `output.args.prompt`. If so, route through the
      // natural-intent pipeline; the hook itself enforces:
      //   - prompt is data; the canonical identity controls every gate
      //   - prompt is never mutated, never recorded in audit
      //   - args.model is never read, written, or relied on
      //   - the exact gate order: parse(prompt) -> resolve -> quarantine
      //     -> readiness -> audit -> rewrite
      // If the prompt carries no WU1 trigger, `hook.execute` returns
      // unchanged and the legacy pass-through below runs. If the
      // prompt carries a malformed / ambiguous / unknown trigger, the
      // hook throws a fail-closed `NaturalIntentBlockedError` BEFORE
      // child creation. Operator boot identity and signing key are
      // required for the natural path the same as for explicit routing.
      const promptArg = output.args && typeof output.args === "object"
        ? (output.args as { prompt?: unknown }).prompt
        : undefined;
      if (typeof promptArg === "string" && promptArg.length > 0) {
        let naturalIntent: ReturnType<typeof parseNaturalModelIntent> = null;
        try {
          naturalIntent = parseNaturalModelIntent(promptArg);
        } catch (error) {
          // The hook itself throws on ambiguous/malformed/unknown-level
          // intents. We let those propagate; the hook also handles the
          // grammar-error path internally.
          throw error;
        }
        if (naturalIntent !== null) {
          const routingQuarantineAdapter = new PrismaModelRouteQuarantineAdapter(prisma);
          const workspaceRoot = directory || process.cwd();
          const whitelist: RouteWhitelist = loadRouteWhitelist(workspaceRoot);
          const variants = readVariantSnapshot(workspaceRoot);
          // WU2: the resolver MUST be wired with the verified
          // `NATURAL_MODEL_ALIASES` so the natural reference hits the
          // alias table before any Tier 3 fuzzy fallback. The explicit
          // routing path keeps an empty alias map so it can never pick
          // up natural aliases by accident.
          const routingResolver = new ModelRouteResolver(whitelist, NATURAL_MODEL_ALIASES);
          const auditPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "routing.audit.jsonl");
          const routingHook = new ModelRouteTaskHook({
            workspaceRoot,
            whitelist,
            variants,
            resolver: routingResolver,
            quarantineStore: getGlobalQuarantineStore(),
            audit: { path: auditPath },
            loadQuarantineEntries: async () => routingQuarantineAdapter.listActive(),
            logger: {
              info: (m: string) => logger.info(m),
              warn: (m: string) => console.warn(`[${project}] WARN: ${m}`),
              error: (m: string) => logger.error(m, null),
            },
          });
          await routingHook.execute(_input, output);
          return;
        }
      }

      // Legacy pass-through: byte-for-byte unchanged from the prior
      // composition. This block intentionally keeps its full surface
      // (registry hydration, quarantine blocking via args.model) so
      // non-prefixed calls continue to behave exactly as before.
      // Check registry / DB hydration for runtime model allocation
      const registry = getOrCreateModelConfigRegistry();
      const requestedModel = output.args?.model;
      if (requestedModel && requestedModel.includes("/")) {
        const [pId, mId] = requestedModel.split("/", 2);
        if (pId && mId) {
          let cached = registry.get(pId, mId);
          if (!cached) {
            try {
              const detail = await repository.findModelDetail(pId, mId);
              if (detail) {
                registry.publish({
                  providerId: detail.providerId,
                  modelId: detail.modelId,
                  contextWindow: detail.modelMetadata?.contextWindow ?? null,
                  maxOutputTokens: detail.modelMetadata?.maxOutputTokens ?? null,
                  capabilities: detail.modelMetadata?.capabilities ?? [],
                  inputPerMillion: detail.pricing?.inputPerMillion ?? null,
                  outputPerMillion: detail.pricing?.outputPerMillion ?? null,
                  cachedPerMillion: detail.pricing?.cachedPerMillion ?? null,
                  currency: detail.pricing?.currency ?? "USD",
                  isBlocked: detail.providerIsBlocked,
                  subscription: detail.providerSubscription,
                  metadataEnvelopeHash: detail.metadataEnvelopeHash ?? null,
                });
                cached = registry.get(pId, mId);
              }
            } catch (err) {
              logger.error(`Failed DB read-through hydration for ${requestedModel}`, err);
            }
          }
        }
      }

      // Check quarantine store hydration & active status
      let isQuarantined = false;
      try {
        const quarantineStore = getGlobalQuarantineStore();
        const listQuarantinesUseCase = new ListQuarantinesUseCase(repository, quarantineStore);
        const quarantines = await listQuarantinesUseCase.execute();
        quarantineStore.reconcile(quarantines);

        if (requestedModel && requestedModel.includes("/")) {
          const [pId, mId] = requestedModel.split("/", 2);
          isQuarantined = Boolean(pId && mId && quarantineStore.isActive(pId, mId));
        }
      } catch (err) {
        logger.error("Quarantine check error during task interception", err);
        throw err;
      }
      if (isQuarantined) {
        logger.info(`Blocking task because model ${requestedModel} is quarantined.`);
        throw new Error(`Task invocation blocked: model ${requestedModel} is quarantined.`);
      }

      coordinator.trigger();
    },
  };
};

export default SddPlugin;

/**
 * Minimal structural type for the OpenCode runtime context. Plugins
 * receive a richer object in practice, but we only consume the
 * fields below.
 */
export interface SddPluginContext {
  /**
   * The real host supplies a Project object; tests and internal callers use a
   * plain string. Both are accepted and normalised by `resolveProjectLabel`.
   */
  project?: string | { id?: string; worktree?: string };
  client?: unknown;
  directory?: string;
  worktree?: string;
}
