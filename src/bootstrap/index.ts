/**
 * Composition root: the ONLY module that knows how to instantiate
 * adapters and wire them into use cases.
 *
 * The plugin contract: an async function that receives the OpenCode
 * runtime context and returns a map of hook handlers.
 */
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@prisma/client";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ListConnectedModelsUseCase } from "../application/list-connected-models/list-connected-models.use-case.js";
import { SyncConnectedModelsUseCase } from "../application/sync-connected-models/sync-connected-models.use-case.js";
import { BackgroundModelRefreshCoordinator } from "../application/background-model-refresh-coordinator.js";
import { OpenCodeAppLogNotifierAdapter } from "../infrastructure/logging/opencode-app-log.notifier.adapter.js";
import { ModelRefreshTraceLogger } from "../infrastructure/logging/model-refresh-trace.logger.js";
import { OpenCodeModelCatalogAdapter } from "../infrastructure/opencode/opencode-model-catalog.adapter.js";
import { PrismaModelRepositoryAdapter } from "../infrastructure/prisma/prisma-model-repository.adapter.js";

/**
 * Resolve the absolute SQLite path relative to this file (works for
 * `dist/bootstrap/index.js` after tsc) and inject it into the Prisma
 * env. Done once at module load so the PrismaClient below picks it up.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, "..", "..", "opencode-models.db");
process.env.DATABASE_URL = `file:${dbPath}`;

/**
 * Prisma 7 requires a driver adapter at runtime (the generator emits a
 * client that runs against `engineType = "client"` by default). We use
 * the `@prisma/adapter-libsql` to support both Node and Bun.
 */
const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter: prismaAdapter });

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
export const SddPlugin = async (ctx: SddPluginContext) => {
  const project = ctx?.project ?? "opencode";
  const directory = ctx?.directory ?? "";
  const client = ctx?.client;

  const logger = {
    info: (message: string) => console.log(`[${project}] INFO: ${message}`),
    error: (message: string, err: unknown) =>
      console.error(`[${project}] ERROR: ${message}`, err),
  };

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

  return {
    /**
     * Intercept the `task` tool to take control of the workflow /
     * subagent spawning. We MUST NOT mutate `output` — the task must
     * run exactly as the LLM requested. We catch errors so a sync
     * failure never blocks the task itself.
     */
    "tool.execute.before": async (
      _input: { tool?: string },
      output: { args?: { subagent_type?: string } },
    ) => {
      if (_input.tool !== "task") return;

      logger.info(
        `Intercepting task: ${output.args?.subagent_type ?? "unknown"}`,
      );
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
  project?: string;
  client?: unknown;
  directory?: string;
  worktree?: string;
}