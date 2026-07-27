/**
 * Cross-process initializer worker.
 *
 * Loaded via `child_process.fork(workerPath, [], { shell: false })` from
 * `tests/helpers/init-child-runner.ts`. Each child listens on the IPC channel
 * for one `initialize` request, runs the production
 * `src/infrastructure/runtime/database-path.js` initializer through the tsx
 * `--import` pre-loaded TypeScript hook, and posts a structured result back.
 *
 * The worker is intentionally CJS so `fork()` can launch it without any ESM
 * loader dance. The tsx loader is registered via NODE_OPTIONS inheritance
 * from the parent process (parent runs under `tsx`); if the parent started
 * the child via Node directly, the child silently inherits NODE_OPTIONS from
 * the parent and tsx loads the source modules on import.
 */
process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  const request = msg;
  if (request.type !== "initialize") return;

  const projectDbPath = request.projectDbPath;
  const started = Date.now();
  let response;
  try {
    const mod = await import("../../src/infrastructure/runtime/database-path.js");
    const initOptions = {};
    if (projectDbPath !== null) initOptions.projectDbPath = projectDbPath;
    const destination = mod.initializeDatabase(initOptions);
    response = {
      type: "result",
      ok: true,
      destination,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    response = {
      type: "result",
      ok: false,
      error: err instanceof Error ? `${err.message}` : String(err),
      durationMs: Date.now() - started,
    };
  }
  try {
    process.send(response);
  } catch {
    // Parent went away — nothing else to do.
  }
});