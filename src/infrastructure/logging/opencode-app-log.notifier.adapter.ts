import { formatConnectedModels } from "../../domain/model/format-connected-models.js";
import type { NotifierPort } from "../../ports/notifier.port.js";
import type { RefreshedModelEntry } from "../../domain/model/refreshed-model.js";
import type { OpenCodeClient } from "../opencode/opencode-model-catalog.adapter.js";
import type { RefreshTraceContext } from "../../ports/model-catalog.port.js";
import type { ModelRefreshTraceLogger } from "./model-refresh-trace.logger.js";

/**
 * Adapter: render the refreshed model list and forward it to the
 * OpenCode client's `app.log` channel when available, falling back
 * to the system console otherwise (mirrors the legacy plugin).
 *
 * Trace instrumentation: `showModels` emits `display.start` /
 * `display.finish` / `display.failure` events through the optional
 * `ModelRefreshTraceLogger` so a runtime debugger can confirm the
 * list reached the user. When no logger is supplied the notifier
 * behaves exactly as before.
 */
export class OpenCodeAppLogNotifierAdapter implements NotifierPort {
  private readonly trace: ModelRefreshTraceLogger | undefined;

  constructor(
    private readonly client: OpenCodeClient,
    options: { trace?: ModelRefreshTraceLogger } = {},
  ) {
    this.trace = options.trace;
  }

  async showModels(
    models: ReadonlyArray<RefreshedModelEntry>,
    context: RefreshTraceContext = {},
  ): Promise<void> {
    const correlationId = context.correlationId ?? this.trace?.newCorrelationId() ?? "";
    const startedAt = Date.now();
    if (this.trace) {
      this.trace.trace({
        correlationId,
        stage: "display.start",
        status: "start",
        details: { modelCount: models.length },
      });
    }
    try {
      const message = formatConnectedModels(models);

      const log = this.client.app?.log;
      if (typeof log === "function") {
        log(message);
      } else {
        console.log(message);
      }
      if (this.trace) {
        this.trace.trace({
          correlationId,
          stage: "display.finish",
          status: "success",
          durationMs: Date.now() - startedAt,
          details: {
            modelCount: models.length,
            channel: typeof log === "function" ? "client.app.log" : "console",
          },
        });
      }
    } catch (error) {
      if (this.trace) {
        this.trace.error({
          correlationId,
          stage: "display.failure",
          durationMs: Date.now() - startedAt,
          details: { modelCount: models.length },
          error,
        });
      }
      throw error;
    }
  }
}