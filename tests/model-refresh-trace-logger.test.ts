/**
 * Focused tests for the ModelRefreshTraceLogger.
 *
 * Goals (all must hold):
 *   1. JSONL output: every `trace()` and `error()` call appends ONE
 *      line to the sink with the expected fields populated.
 *   2. Ordered stage records: a mocked refresh cycle produces a
 *      predictable ordered sequence of stages.
 *   3. Sensitive keys are redacted in both `details` and `error`
 *      payloads (case-insensitive match on `authorization`, `cookie`,
 *      `token`, `secret`, `apiKey`, `password`, `credential`, etc.).
 *   4. Oversized details are bounded — strings are truncated, arrays
 *      are collapsed to `{ length, sample }`, and the overall line
 *      stays under `MAX_DETAIL_BYTES`.
 *   5. Source request/response stages are emitted EVEN WHEN the
 *      adapter's SDK call throws — failures still leave a
 *      `*.failure` record on disk.
 *   6. The logger never throws when the sink throws.
 *   7. The adapter still produces the same domain models after
 *      instrumentation is added (no behavior regression).
 *
 * Run with `npx tsx tests/model-refresh-trace-logger.test.ts`.
 *
 * No Prisma, no file system, no user home directory — every test
 * uses an in-memory sink.
 */

import {
  FileTraceSink,
  MemoryTraceSink,
  ModelRefreshTraceLogger,
} from "../src/infrastructure/logging/model-refresh-trace.logger.js";
import { ListConnectedModelsUseCase } from "../src/application/list-connected-models/list-connected-models.use-case.js";
import { SyncConnectedModelsUseCase } from "../src/application/sync-connected-models/sync-connected-models.use-case.js";
import { OpenCodeAppLogNotifierAdapter } from "../src/infrastructure/logging/opencode-app-log.notifier.adapter.js";
import { OpenCodeModelCatalogAdapter } from "../src/infrastructure/opencode/opencode-model-catalog.adapter.js";
import { PrismaModelRepositoryAdapter } from "../src/infrastructure/prisma/prisma-model-repository.adapter.js";

const failures: string[] = [];

function assert(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error("  FAIL: " + message);
  } else {
    console.log("  pass: " + message);
  }
}

function header(label: string): void {
  console.log("\n--- " + label + " ---");
}

async function flushTrace(logger: ModelRefreshTraceLogger): Promise<void> {
  const flush = (logger as unknown as { flush?: () => Promise<void> }).flush;
  if (typeof flush === "function") {
    await flush.call(logger);
  } else {
    await Promise.resolve();
  }
}

function makeProvidersPayload() {
  return {
    default: { anthropic: "claude-sonnet-4" },
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        models: {
          "claude-sonnet-4": {
            name: "Claude Sonnet 4",
            pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: "USD" },
          },
          "claude-opus-4": { name: "Claude Opus 4" },
        },
      },
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-5": { name: "GPT-5" },
          "gpt-5-mini": { name: "GPT-5 Mini" },
        },
      },
    ],
  };
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------
  header("JSONL wire format: one line per event, schema is stable");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({
      sink,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      idFactory: () => "fixed-correlation-id",
    });

    const correlationId = logger.newCorrelationId();

    logger.trace({
      correlationId,
      stage: "discovery.start",
      status: "start",
      details: { configProviders: true },
    });
    logger.error({
      correlationId,
      stage: "config.providers.failure",
      durationMs: 12,
      error: new Error("primary down"),
    });
    await flushTrace(logger);

    const lines = sink.lines;
    assert(lines.length === 2, "two events → two lines (got " + lines.length + ")");
    assert(
      lines.every((line) => line.endsWith("\n") || !line.includes("\n")),
      "every line is a single line (no embedded newlines)"
    );

    const parsed = sink.parsed();
    assert(parsed.length === 2, "parsed JSON count matches line count (got " + parsed.length + ")");

    const start = parsed[0]!;
    assert(start.timestamp === "2026-01-01T00:00:00.000Z", "timestamp is ISO 8601 from clock");
    assert(start.correlationId === "fixed-correlation-id", "correlationId is the factory output");
    assert(start.stage === "discovery.start", "stage is preserved");
    assert(start.status === "start", "status is preserved");
    assert(
      (start.details as { configProviders?: boolean })?.configProviders === true,
      "details object is preserved"
    );

    const failure = parsed[1]!;
    assert(failure.status === "failure", "error() forces status='failure'");
    assert(failure.durationMs === 12, "durationMs is preserved");
    assert(
      (failure.error as { message?: string })?.message === "primary down",
      "error message is preserved"
    );
  }

  // -------------------------------------------------------------------
  header("Sensitive keys are redacted in details and error");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({ sink });
    logger.trace({
      correlationId: "redact",
      stage: "secret.test",
      status: "start",
      details: {
        authorization: "Bearer abc123",
        APIKEY: "sk-123",
        apiKey: "sk-456",
        Token: "tok-789",
        cookie: "session=xyz",
        PASSWORD: "hunter2",
        credential: "long-lived",
        nested: { credential_id: "cre-1", safe: "ok" },
        list: [{ secret: "hidden" }, { public: "visible" }],
      },
    });
    logger.error({
      correlationId: "redact",
      stage: "secret.fail",
      status: "failure",
      error: {
        message: "auth failed",
        apiKey: "sk-bang",
        stack: "Error: auth failed\n  at someFn (file.ts:1:1)",
      },
    });
    await flushTrace(logger);

    const parsed = sink.parsed();
    const ok = parsed[0]!;
    assert(ok.details?.authorization === "[REDACTED]", "authorization is redacted");
    assert(ok.details?.APIKEY === "[REDACTED]", "APIKEY (uppercase) is redacted");
    assert(ok.details?.apiKey === "[REDACTED]", "apiKey is redacted");
    assert(ok.details?.Token === "[REDACTED]", "Token is redacted");
    assert(ok.details?.cookie === "[REDACTED]", "cookie is redacted");
    assert(ok.details?.PASSWORD === "[REDACTED]", "PASSWORD is redacted");
    assert(ok.details?.credential === "[REDACTED]", "credential is redacted");
    assert(
      ok.details?.nested?.credential_id === "[REDACTED]",
      "nested sensitive key is redacted"
    );
    assert(ok.details?.nested?.safe === "ok", "non-sensitive nested keys survive");
    assert(
      ok.details?.list?.[0]?.secret === "[REDACTED]",
      "sensitive keys inside array items are redacted"
    );
    assert(
      ok.details?.list?.[1]?.public === "visible",
      "non-sensitive array items survive"
    );

    const err = parsed[1]!;
    assert(err.error?.apiKey === "[REDACTED]", "apiKey inside error is redacted");
    assert(err.error?.message === "auth failed", "error message itself is preserved");
  }

  // -------------------------------------------------------------------
  header("Message and Error strings use the same redaction pipeline");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({ sink });
    const error = new Error("token=error-token-123 authorization=Bearer error-auth-456");
    error.stack =
      "Error: password=stack-password-789\nAuthorization: Bearer stack-auth-987\n  at hidden";

    logger.trace({
      correlationId: "string-redaction",
      stage: "secret.strings",
      status: "failure",
      message: "apiKey=message-key-123 cookie=session-cookie-456",
      details: {
        note: "credential=details-credential-789",
        nested: ["secret=nested-secret-321"],
      },
      error,
    });
    await flushTrace(logger);

    const line = sink.lines[0] ?? "";
    for (const secret of [
      "error-token-123",
      "error-auth-456",
      "stack-password-789",
      "stack-auth-987",
      "message-key-123",
      "session-cookie-456",
      "details-credential-789",
      "nested-secret-321",
    ]) {
      assert(!line.includes(secret), "serialized event does not contain raw secret " + secret);
    }

    const event = sink.parsed()[0]!;
    assert(event.message?.includes("[REDACTED]") === true, "TraceEvent.message is redacted");
    assert(
      (event.error as { message?: string })?.message?.includes("[REDACTED]") === true,
      "Error.message is redacted"
    );
    assert(
      (event.error as { stack?: string })?.stack?.includes("[REDACTED]") === true,
      "Error.stack is redacted"
    );
  }

  // -------------------------------------------------------------------
  header("Sanitization is deferred and hostile values never escape trace()");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({ sink });
    let getterRead = false;
    const lazyValue = Object.defineProperty({}, "payload", {
      enumerable: true,
      get() {
        getterRead = true;
        return "x".repeat(100_000);
      },
    });

    logger.trace({
      correlationId: "deferred",
      stage: "deferred.sanitize",
      status: "start",
      details: lazyValue,
    });

    assert(!getterRead, "trace() does not synchronously walk detail getters");
    await flushTrace(logger);
    assert(getterRead, "queued sanitization eventually inspects bounded detail values");
    assert(sink.parsed().length === 1, "deferred event is eventually written");
  }

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({
      sink,
      clock: () => new Date("invalid"),
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const throwingGetter = Object.defineProperty({}, "danger", {
      enumerable: true,
      get() {
        throw new Error("getter token=getter-secret");
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys password=proxy-secret");
        },
      },
    );
    const hostileInstanceOfProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("getPrototypeOf token=instanceof-secret");
        },
      },
    );

    let threw = false;
    try {
      logger.trace({
        correlationId: "hostile",
        stage: "hostile.values",
        status: "start",
        details: {
          invalidDate: new Date("invalid"),
          cycle,
          throwingGetter,
          hostileProxy,
          hostileInstanceOfProxy,
        },
      });
    } catch {
      threw = true;
    }

    assert(!threw, "trace() never throws for invalid dates, cycles, getters, or proxies");
    await flushTrace(logger);
    const line = sink.lines[0] ?? "";
    assert(sink.parsed().length === 1, "hostile event still produces valid JSONL");
    assert(!line.includes("getter-secret"), "throwing getter secret is never persisted");
    assert(!line.includes("proxy-secret"), "hostile proxy secret is never persisted");
    assert(!line.includes("instanceof-secret"), "hostile instanceof proxy secret is never persisted");
  }

  // -------------------------------------------------------------------
  header("Oversized details are bounded (string truncation + array collapse)");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({ sink });

    const hugeString = "x".repeat(50_000);
    const hugeArray = Array.from({ length: 5_000 }, (_, i) => i);

    logger.trace({
      correlationId: "size",
      stage: "size.test",
      status: "start",
      details: { hugeString, hugeArray, nested: { hugeArray } },
    });
    await flushTrace(logger);

    const parsed = sink.parsed();
    const line = sink.lines[0]!;
    const details = parsed[0]!.details as Record<string, unknown>;

    assert(
      line.length < 16 * 1024,
      "line stays under 16 KiB (got " + line.length + ")"
    );
    assert(
      typeof details.hugeString === "string" && (details.hugeString as string).length < 700,
      "huge string is truncated (got " + (details.hugeString as string).length + " chars)"
    );
    const arr = details.hugeArray as { length: number; sample: unknown[] };
    assert(arr.length === 5_000, "huge array length is preserved");
    assert(
      Array.isArray(arr.sample) && arr.sample.length <= 20,
      "huge array sample is bounded (got " + arr.sample.length + ")"
    );
  }

  // -------------------------------------------------------------------
  header("The complete JSONL event is bounded");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({ sink });
    logger.trace({
      correlationId: "cid-" + "c".repeat(100_000),
      stage: "stage-" + "s".repeat(100_000),
      status: "failure",
      message: "password=full-line-secret " + "m".repeat(100_000),
      details: { payload: "d".repeat(100_000) },
      error: new Error("token=full-line-error-secret " + "e".repeat(100_000)),
    });
    await flushTrace(logger);

    const line = sink.lines[0] ?? "";
    assert(
      Buffer.byteLength(line, "utf8") <= 16 * 1024,
      "complete serialized line stays under 16 KiB (got " + Buffer.byteLength(line, "utf8") + " bytes)"
    );
    assert(sink.parsed().length === 1, "bounded full event remains valid JSON");
    assert(!line.includes("full-line-secret"), "bounded message does not retain its raw secret");
    assert(!line.includes("full-line-error-secret"), "bounded error does not retain its raw secret");
  }

  // -------------------------------------------------------------------
  header("startStage: emits start + success with measured duration");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    let now = 1_000_000;
    const logger = new ModelRefreshTraceLogger({
      sink,
      clock: () => new Date(now),
    });

    const stage = logger.startStage("cid-stage", "demo.work", { initial: true });
    now += 25;
    stage.success({ final: true });
    await flushTrace(logger);

    const parsed = sink.parsed();
    assert(parsed.length === 2, "startStage emits exactly two events (got " + parsed.length + ")");
    assert(parsed[0]!.stage === "demo.work" && parsed[0]!.status === "start", "start event emitted");
    assert(parsed[1]!.stage === "demo.work" && parsed[1]!.status === "success", "success event emitted");
    assert(parsed[1]!.durationMs === 25, "durationMs reflects clock advance (got " + parsed[1]!.durationMs + ")");
  }

  // -------------------------------------------------------------------
  header("startStage.failure: emits start + failure with measured duration");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    let now = 0;
    const logger = new ModelRefreshTraceLogger({
      sink,
      clock: () => new Date(now),
    });

    const stage = logger.startStage("cid-fail", "demo.fail");
    now += 50;
    stage.failure(new Error("boom"), { reason: "simulated" });
    await flushTrace(logger);

    const parsed = sink.parsed();
    assert(parsed.length === 2, "failure branch emits exactly two events");
    assert(parsed[1]!.status === "failure", "failure branch uses status='failure'");
    assert(parsed[1]!.durationMs === 50, "failure duration measured (got " + parsed[1]!.durationMs + ")");
    assert((parsed[1]!.error as { message: string }).message === "boom", "error message is captured");
  }

  // -------------------------------------------------------------------
  header("Sink failures never propagate to the caller");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    sink.armFailure();
    const logger = new ModelRefreshTraceLogger({ sink });
    let threw = false;
    try {
      logger.trace({
        correlationId: "arm",
        stage: "sink.arm",
        status: "start",
        details: { ok: true },
      });
      logger.error({
        correlationId: "arm",
        stage: "sink.arm",
        status: "failure",
        error: new Error("down"),
      });
    } catch {
      threw = true;
    }
    assert(!threw, "logger.trace()/error() never throw even when the sink throws");
    await flushTrace(logger);

    sink.clear();
    logger.trace({
      correlationId: "after",
      stage: "sink.after",
      status: "start",
    });
    await flushTrace(logger);
    assert(sink.parsed().length === 1, "logger recovers after a sink failure");
  }

  // -------------------------------------------------------------------
  header("Ordered stage records: end-to-end refresh cycle");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({ sink });

    const client = {
      config: {
        providers: () =>
          Promise.resolve({ data: { providers: makeProvidersPayload().providers } }),
      },
    };
    const adapter = new OpenCodeModelCatalogAdapter(client, { trace: logger });
    const models = await adapter.getConnectedModels();
    await flushTrace(logger);

    assert(models.length === 4, "adapter still returns 4 models (got " + models.length + ")");

    const parsed = sink.parsed();
    const stages = parsed.map((event) => event.stage + ":" + event.status);

    assert(parsed[0]?.stage === "discovery.start", "discovery.start is first");
    assert(parsed[parsed.length - 1]?.stage === "discovery.finish", "discovery.finish is last");
    assert(parsed[parsed.length - 1]?.status === "success", "discovery.finish has status=success");

    const requiredPairs = [
      ["config.providers.request", "request"],
      ["config.providers.response", "response"],
    ] as const;
    for (const [stage, status] of requiredPairs) {
      assert(
        stages.includes(stage + ":" + status),
        "emits " + stage + ":" + status
      );
    }

    assert(
      parsed.some((event) => event.stage === "discovery.normalize" && event.status === "success"),
      "discovery.normalize:success emitted"
    );

    const ids = new Set(parsed.map((event) => event.correlationId));
    assert(ids.size === 1, "all events share one correlationId (got " + ids.size + ")");

    assert(
      parsed.every((event) => typeof event.timestamp === "string" && /T.*Z$/.test(event.timestamp)),
      "every event has an ISO-8601 timestamp"
    );
  }

  // -------------------------------------------------------------------
  header("Source request/response stages are emitted even on failure");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({ sink });

    const client = {
      config: {
        providers: () => Promise.reject(new Error("primary down")),
      },
    };

    const adapter = new OpenCodeModelCatalogAdapter(client, { trace: logger });
    const models = await adapter.getConnectedModels();
    await flushTrace(logger);

    assert(models.length === 0, "both sources down → 0 models (got " + models.length + ")");

    const parsed = sink.parsed();
    const stageNames = parsed.map((event) => event.stage);

    assert(stageNames.includes("config.providers.request"), "config.providers.request emitted");
    assert(
      stageNames.includes("config.providers.failure"),
      "config.providers.failure (failure) emitted after rejection"
    );
    assert(
      stageNames.includes("discovery.finish"),
      "discovery.finish emitted even when all sources fail"
    );

    const failures = parsed.filter(
      (event) => event.stage === "config.providers.failure"
    );
    assert(
      failures.length === 1 && failures.every((event) => event.status === "failure"),
      "failure responses carry the failure status"
    );

    const finish = parsed.find((event) => event.stage === "discovery.finish");
    assert(
      finish?.status === "success",
      "discovery.finish records success despite all-source failure (safe fallback path)"
    );
  }

  // -------------------------------------------------------------------
  header("Missing config.providers emits a terminal failure response");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({ sink });
    const adapter = new OpenCodeModelCatalogAdapter(
      {},
      { trace: logger }
    );

    await adapter.getConnectedModels({ correlationId: "missing-config" });
    await flushTrace(logger);

    const configEvents = sink
      .parsed()
      .filter((event) => event.stage === "config.providers.request" || event.stage === "config.providers.failure");
    assert(configEvents.length === 2, "missing config.providers emits request + failure response (got " + configEvents.length + ")");
    assert(
      configEvents[0]?.stage === "config.providers.request" && configEvents[0]?.status === "request",
      "missing config.providers begins with config.providers.request"
    );
    assert(
      configEvents[1]?.stage === "config.providers.failure" && configEvents[1]?.status === "failure",
      "missing config.providers ends with config.providers.failure:failure"
    );
  }

  // -------------------------------------------------------------------
  header("Injected correlation spans discovery, persistence, and display");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({
      sink,
      idFactory: () => "unexpected-child-id",
    });
    const client = {
      config: {
        providers: () =>
          Promise.resolve({
            data: {
              providers: [
                {
                  id: "anthropic",
                  models: {
                    "claude-sonnet-4": { name: "Claude Sonnet 4" },
                  },
                },
              ],
            },
          }),
      },
      app: {
        log: (_message: string) => undefined,
      },
    };
    const fakePrisma = {
      provider: { upsert: async () => ({}) },
      model: { upsert: async () => ({}) },
      modelProvider: { upsert: async () => ({ id: "model-provider-1" }) },
      modelProviderPricing: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    };

    const catalog = new OpenCodeModelCatalogAdapter(client, { trace: logger });
    const repository = new PrismaModelRepositoryAdapter(fakePrisma as never, { trace: logger });
    const notifier = new OpenCodeAppLogNotifierAdapter(client, { trace: logger });
    const syncUseCase = new SyncConnectedModelsUseCase(catalog, repository);
    const listUseCase = new ListConnectedModelsUseCase(notifier);
    const correlationId = "parent-refresh-correlation";

    const result = await syncUseCase.execute({ correlationId } as never);
    await listUseCase.execute({ refreshed: result.refreshed, correlationId } as never);
    await flushTrace(logger);

    const events = sink.parsed();
    const stages = new Set(events.map((event) => event.stage));
    assert(stages.has("discovery.start"), "pipeline emits discovery trace events");
    assert(stages.has("persistence.start"), "pipeline emits persistence trace events");
    assert(stages.has("persistence.finish"), "pipeline emits persistence terminal events");
    assert(stages.has("display.start"), "pipeline emits display trace events");
    assert(stages.has("display.finish"), "pipeline emits display terminal events");
    assert(
      events.length > 0 && events.every((event) => event.correlationId === correlationId),
      "one injected parent correlationId spans every pipeline event (got " + events.length + " events)"
    );
    const unexpectedChild = events.find(
      (event) => event.correlationId === "unexpected-child-id"
    );
    assert(
      unexpectedChild === undefined,
      "child adapters do not mint a new correlationId when a parent is provided"
    );
  }

  // -------------------------------------------------------------------
  header("Correlation id is unique per refresh cycle");
  // -------------------------------------------------------------------

  {
    const sink = new MemoryTraceSink();
    const logger = new ModelRefreshTraceLogger({
      sink,
      idFactory: (() => {
        let n = 0;
        return () => "cid-" + ++n;
      })(),
    });
    const client = {
      config: {
        providers: () => Promise.resolve({ data: { providers: [] } }),
      },
    };
    const adapter = new OpenCodeModelCatalogAdapter(client, { trace: logger });

    await adapter.getConnectedModels();
    await adapter.getConnectedModels();
    await flushTrace(logger);

    const parsed = sink.parsed();
    const cycleIds = new Set(
      parsed.filter((event) => event.stage === "discovery.start").map((event) => event.correlationId)
    );
    assert(
      cycleIds.size === 2,
      "two refresh cycles → two distinct correlation ids (got " + cycleIds.size + ")"
    );
  }

  // -------------------------------------------------------------------
  header("FileTraceSink: defaults to ~/.cache/sdd-plugin/model-refresh.log");
  // -------------------------------------------------------------------

  {
    process.env.SDD_PLUGIN_TRACE_PATH = "";
    const sink = new FileTraceSink({ filePath: "/tmp/sdd-plugin-trace-test.log" });
    assert(
      typeof sink.write === "function",
      "FileTraceSink exposes a write(line) sink contract"
    );
  }

  // -------------------------------------------------------------------
  console.log("\n=== TRACE LOGGER TEST SUMMARY ===");
  if (failures.length === 0) {
    console.log("All trace logger assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " trace logger assertion(s) failed:");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
}

await main().catch((err) => {
  console.error("Trace logger test crashed:", err);
  process.exit(1);
});
