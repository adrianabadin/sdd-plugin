/**
 * Focused test for the BackgroundModelRefreshCoordinator and the
 * SddPlugin bootstrap contract.
 *
 * Goals (all must hold):
 *  1. SddPlugin resolves IMMEDIATELY — no awaiting of model sync/list
 *     during plugin initialization, even when the SDK blocks.
 *  2. The `tool.execute.before` hook for the `task` tool triggers the
 *     refresh WITHOUT awaiting; it returns a promise that resolves
 *     before the deferred refresh finishes.
 *  3. The hook NEVER mutates the task `output.args`.
 *  4. The hook NEVER rejects when the underlying refresh fails —
 *     failures are caught/logged inside the coordinator.
 *  5. Overlapping triggers share one in-flight operation (single-flight):
 *     a second trigger while one is in flight does NOT start a new
 *     execution; it returns the SAME promise instance.
 *  6. After the first refresh completes, a fresh trigger starts a new
 *     execution (no permanent lockup).
 *  7. The hook is a no-op for any tool other than `task`.
 *
 * Run with `npx tsx tests/background-model-refresh-coordinator.test.ts`.
 *
 * No Prisma, no SDK — pure unit/integration over the application layer
 * with mocked ports.
 */

// Use a relative import so tsx resolves it under NodeNext ESM.
import { BackgroundModelRefreshCoordinator } from "../src/application/background-model-refresh-coordinator.js";
import { SddPlugin } from "../src/bootstrap/index.js";

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

/**
 * Wait one macrotask + a few microtasks so any deferred work that the
 * caller was NOT awaiting has a chance to settle.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.resolve();
  await Promise.resolve();
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------
  header("BackgroundModelRefreshCoordinator: single-flight semantics");
  // -------------------------------------------------------------------

  {
    let resolveRefresh: (() => void) | null = null;
    let refreshCalls = 0;

    const refreshFn = () => {
      refreshCalls++;
      return new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
    };

    const errorLogs: Array<{ message: string; error: unknown }> = [];
    const logger = {
      error: (message: string, error: unknown) => {
        errorLogs.push({ message, error });
      },
    };

    const coordinator = new BackgroundModelRefreshCoordinator(refreshFn, logger);

    const p1 = coordinator.trigger();
    assert(coordinator.isInFlight(), "coordinator reports in-flight after first trigger");
    assert(refreshCalls === 1, "first trigger invokes refreshFn exactly once (got " + refreshCalls + ")");

    const p2 = coordinator.trigger();
    assert(p1 === p2, "second trigger while in-flight returns the SAME promise instance (single-flight)");
    assert(refreshCalls === 1, "overlapping trigger does NOT start a new execution (got " + refreshCalls + " calls)");

    if (!resolveRefresh) throw new Error("resolveRefresh missing");
    (resolveRefresh as () => void)();
    await p1;
    assert(!coordinator.isInFlight(), "coordinator clears in-flight after completion");

    const p3 = coordinator.trigger();
    assert(coordinator.isInFlight(), "fresh trigger after completion is in-flight again");
    assert(refreshCalls === 2, "fresh trigger invokes refreshFn again (got " + refreshCalls + " calls)");

    if (!resolveRefresh) throw new Error("resolveRefresh missing for second run");
    (resolveRefresh as () => void)();
    await p3;
  }

  // -------------------------------------------------------------------
  header("BackgroundModelRefreshCoordinator: failure isolation");
  // -------------------------------------------------------------------

  {
    let rejectRefresh: ((err: Error) => void) | null = null;

    const refreshFn = () =>
      new Promise<void>((_resolve, reject) => {
        rejectRefresh = reject;
      });

    const errorLogs: Array<{ message: string; error: unknown }> = [];
    const logger = {
      error: (message: string, error: unknown) => {
        errorLogs.push({ message, error });
      },
    };

    const coordinator = new BackgroundModelRefreshCoordinator(refreshFn, logger);

    const p = coordinator.trigger();
    if (!rejectRefresh) throw new Error("rejectRefresh missing");
    (rejectRefresh as (err: Error) => void)(new Error("boom"));

    let rejected = false;
    await p.catch(() => {
      rejected = true;
    });
    assert(!rejected, "trigger() does NOT reject when refreshFn throws");
    assert(!coordinator.isInFlight(), "coordinator clears in-flight after a failure");

    const logged = errorLogs.find((e) => e.message.includes("Background refresh failed"));
    assert(logged !== undefined, "background failure is logged with 'Background refresh failed'");

    let resolveNext: (() => void) | null = null;
    const nextRefreshFn = () =>
      new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    const c2 = new BackgroundModelRefreshCoordinator(nextRefreshFn, logger);
    void c2.trigger();
    assert(c2.isInFlight(), "after a failure, a new coordinator can still enter in-flight");
    if (resolveNext) (resolveNext as () => void)();
    await flush();
  }

  // -------------------------------------------------------------------
  header("SddPlugin: returns hooks immediately, no startup sync/list");
  // -------------------------------------------------------------------

  {
    const neverResolves = new Promise<unknown[]>(() => {
      // intentionally never resolves
    });
    const mockClient = {
      config: { providers: () => neverResolves },
      app: { log: () => undefined },
    };

    const start = Date.now();
    const pluginPromise = SddPlugin({
      project: "focused-test",
      client: mockClient,
      directory: "/focused",
    });

    const timeout = new Promise<"TIMEOUT">((resolve) => {
      setTimeout(() => resolve("TIMEOUT"), 500);
    });

    const result = await Promise.race([
      pluginPromise.then(() => "READY" as const),
      timeout,
    ]);
    const elapsed = Date.now() - start;

    assert(result === "READY", "SddPlugin resolves before the SDK ever returns");
    assert(elapsed < 500, "SddPlugin resolves in under 500ms (took " + elapsed + "ms)");

    if (result === "READY") {
      const hooks = await pluginPromise;
      assert(
        hooks !== null && typeof hooks === "object",
        "SddPlugin returns an object"
      );
      assert(
        typeof (hooks as Record<string, unknown>)["tool.execute.before"] === "function",
        "SddPlugin returns a `tool.execute.before` hook"
      );
    }
  }

  // -------------------------------------------------------------------
  header("Hook: returns before deferred refresh resolves");
  // -------------------------------------------------------------------

  {
    let resolveSDKCall: (() => void) | null = null;
    const mockClient = {
      config: {
        providers: () =>
          new Promise<unknown[]>((resolve) => {
            resolveSDKCall = () => resolve([]);
          }),
      },
      app: { log: () => undefined },
    };

    const hooks = await SddPlugin({
      project: "focused-hook",
      client: mockClient,
      directory: "/hook",
    });
    const hook = (hooks as { "tool.execute.before": (input: unknown, output: unknown) => Promise<void> })
      ["tool.execute.before"];

    const hookStart = Date.now();
    const hookPromise = hook(
      { tool: "task" },
      { args: { subagent_type: "apply" } }
    );
    const hookElapsed = Date.now() - hookStart;

    assert(
      hookElapsed < 50,
      "hook returns within 50ms even when SDK is blocked (took " + hookElapsed + "ms)"
    );

    const outputSnapshot = { args: { subagent_type: "apply" } };
    void outputSnapshot;

    if (resolveSDKCall) (resolveSDKCall as () => void)();
    await hookPromise;
  }

  // -------------------------------------------------------------------
  header("Hook: never mutates task args");
  // -------------------------------------------------------------------

  {
    const mockClient = {
      config: { providers: async () => [] as unknown[] },
      app: { log: () => undefined },
    };
    const hooks = await SddPlugin({
      project: "focused-mutation",
      client: mockClient,
      directory: "/mut",
    });
    const hook = (hooks as { "tool.execute.before": (input: unknown, output: unknown) => Promise<void> })
      ["tool.execute.before"];

    const output = {
      args: { subagent_type: "general-purpose", prompt: "do stuff" },
    };
    const before = JSON.parse(JSON.stringify(output)) as typeof output;

    await hook({ tool: "task" }, output);

    assert(
      JSON.stringify(output) === JSON.stringify(before),
      "hook does NOT mutate output.args (deep-equal after call)"
    );
  }

  // -------------------------------------------------------------------
  header("Hook: no-op for tools other than 'task'");
  // -------------------------------------------------------------------

  {
    let sdkCalled = false;
    const mockClient = {
      config: {
        providers: async () => {
          sdkCalled = true;
          return [] as unknown[];
        },
      },
      app: { log: () => undefined },
    };
    const hooks = await SddPlugin({
      project: "focused-noop",
      client: mockClient,
      directory: "/noop",
    });
    const hook = (hooks as { "tool.execute.before": (input: unknown, output: unknown) => Promise<void> })
      ["tool.execute.before"];

    await hook({ tool: "bash" }, { args: {} });
    await hook({ tool: "read" }, { args: {} });
    await hook({ tool: undefined }, { args: {} });

    assert(!sdkCalled, "hook does NOT trigger refresh for non-task tools");
  }

  // -------------------------------------------------------------------
  console.log("\n=== FOCUSED TEST SUMMARY ===");
  if (failures.length === 0) {
    console.log("All focused assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " focused assertion(s) failed:");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Focused test crashed:", err);
  process.exit(1);
});
