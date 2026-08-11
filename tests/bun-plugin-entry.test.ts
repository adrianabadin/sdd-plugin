/**
 * Bun runtime gate for the distributable plugin entry point.
 *
 * OpenCode executes plugins on Bun, not Node. A module that only imports
 * cleanly under Node (for example via `node:sqlite`, which Bun does not
 * provide) loads fine in every Node-based test yet fails silently inside the
 * real host, leaving the SDD tool surface unregistered.
 *
 * This gate imports the BUILT entry point under Bun and asserts the full tool
 * surface is registered and executable, so a Node-only dependency can never
 * ship undetected again.
 *
 * It also pins the host's export contract: OpenCode iterates EVERY export of
 * the entry module and treats each as a plugin factory, so a non-function
 * export drops the plugin entirely and an exported helper would be invoked as
 * a plugin.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXPECTED_TOOLS = [
  "sdd_status",
  "sdd_compose_phase_prompt",
  "sdd_save_artifact",
  "sdd_parse_request",
  "sdd_init_questions",
  "sdd_save_config",
  "sdd_checkpoint",
  "sdd_recover_phase_lock",
] as const;

/**
 * Windows keeps the SQLite/Prisma files locked until every handle is released,
 * and the plugin surface exposes no full teardown. Temp-dir removal is
 * therefore best-effort: it must never turn a passing runtime gate red.
 */
function removeTempDir(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Handles still open on Windows; the OS temp directory is reclaimed later.
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-bun-plugin-entry-"));
const destination = path.join(root, "opencode-models.db");
fs.copyFileSync(path.resolve("opencode-models.test.db"), destination);

const previousDbPath = process.env.SDD_PLUGIN_DB_PATH;
const previousMemoryDbPath = process.env.MEMORY_DB_PATH;
process.env.SDD_PLUGIN_DB_PATH = destination;
process.env.MEMORY_DB_PATH = path.join(root, "agent-memory");

try {
  const entry = await import("../dist/plugin.js");
  const plugin = entry.default;
  assert.equal(typeof plugin, "function", "built entry exports a callable plugin");
  console.log("  pass: dist/plugin.js imports under Bun");

  const exportNames = Object.keys(entry);
  const nonFunctionExports = exportNames.filter(
    (name) => typeof (entry as unknown as Record<string, unknown>)[name] !== "function",
  );
  assert.deepEqual(
    nonFunctionExports,
    [],
    `entry must export only functions; OpenCode rejects the whole plugin otherwise (offenders: ${nonFunctionExports.join(", ")})`,
  );
  const distinctExports = new Set(exportNames.map((name) => (entry as unknown as Record<string, unknown>)[name]));
  assert.equal(
    distinctExports.size,
    1,
    `every entry export must be the same plugin function; extra exports are invoked as plugins by the host (exports: ${exportNames.join(", ")})`,
  );
  console.log(`  pass: entry exports only the plugin function (${exportNames.join(", ")})`);

  const hooks = await plugin({ project: "bun-plugin-entry", directory: root, client: {} });
  const tools = (hooks as { tool?: Record<string, unknown> }).tool;
  assert.ok(tools, "plugin registers a tool surface under Bun");

  for (const name of EXPECTED_TOOLS) {
    assert.equal(typeof tools[name], "object", `tool '${name}' is registered`);
  }
  assert.equal(
    Object.keys(tools).length,
    EXPECTED_TOOLS.length,
    `exactly ${EXPECTED_TOOLS.length} SDD tools are registered`,
  );
  console.log(`  pass: all ${EXPECTED_TOOLS.length} SDD tools registered under Bun`);

  const definition = tools.sdd_status as { execute(args: Record<string, unknown>): Promise<{ output: string }> };
  const status = JSON.parse((await definition.execute({ projectRoot: root })).output) as {
    initialized: boolean;
    nextRecommended: string;
  };
  assert.equal(status.initialized, false, "fresh project root reports initialized=false");
  assert.equal(status.nextRecommended, "init", "fresh project root recommends init");
  console.log("  pass: sdd_status executes under Bun against a temp project root");

  // The real host passes `project` as a Project OBJECT, not a string. Naive
  // string interpolation renders "[object Object]" in every log line, which is
  // how the plugin actually behaved in OpenCode.
  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await plugin({ project: { id: "proj-42", worktree: root }, directory: root, client: {} });
  } finally {
    console.log = originalLog;
  }
  const objectStringified = captured.filter((line) => line.includes("[object Object]"));
  assert.deepEqual(
    objectStringified,
    [],
    `logs must not stringify the project object (offending lines: ${objectStringified.join(" | ")})`,
  );
  assert.ok(
    captured.some((line) => line.includes("proj-42")),
    `logs must identify the project by id (captured: ${captured.join(" | ")})`,
  );
  console.log("  pass: object-shaped host project renders a readable log label");

  const bootstrap = await import("../dist/bootstrap/index.js");
  await bootstrap.disposeBootstrapPersistence();
} finally {
  if (previousDbPath === undefined) delete process.env.SDD_PLUGIN_DB_PATH;
  else process.env.SDD_PLUGIN_DB_PATH = previousDbPath;
  if (previousMemoryDbPath === undefined) delete process.env.MEMORY_DB_PATH;
  else process.env.MEMORY_DB_PATH = previousMemoryDbPath;
  removeTempDir(root);
}

console.log("Bun plugin entry assertions passed.");
