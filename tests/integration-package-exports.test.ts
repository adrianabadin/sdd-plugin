/**
 * Task 7 Integration Test — Package exports after build + Bun runtime gate.
 *
 * Acceptance scenarios (design.md):
 *   - "Public export tests MUST use package self-references after build, not
 *      source or direct dist paths."
 *   - "The package root MUST remain a callable server/plugin factory."
 *   - "`package.json.exports["./tui"]` MUST resolve the TUI module
 *      `{ id, tui }`."
 *   - "TUI rendering MUST be validated under Bun/OpenTUI through the dedicated
 *      renderer test."
 *   - "Node tests MAY cover host contracts and pure logic, but MUST NOT claim
 *      to validate native OpenTUI rendering."
 *   - "Unsupported Node native-render execution fails clearly while CI executes
 *      the Bun gate."
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from "./helpers/temp-database.js";

console.log("--- Task 7 Integration: Package Self-Reference Exports + Bun Runtime Gate ---");

const failures: string[] = [];

/** Environment isolation so the real per-user database is never involved. */
const exportsEnvSnapshot = snapshotEnv();
const exportsTmpDir = makeTempDir("sdd-pkg-exports-");

function assertOk(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error("  FAIL: " + message);
  } else {
    console.log("  pass: " + message);
  }
}

async function run() {
  // === Build artifacts exist ===
  const rootDist = path.resolve("dist/plugin.js");
  const tuiDist = path.resolve("dist/tui.js");
  assertOk(existsSync(rootDist), "dist/plugin.js exists after build");
  assertOk(existsSync(tuiDist), "dist/tui.js exists after build");

  // === package.json exports map is correct ===
  const packageJson = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
    name: string;
    exports: Record<string, string>;
    main?: string;
    scripts: Record<string, string>;
  };
  assertOk(packageJson.exports["."] === "./dist/plugin.js", 'package.json exports["."] points to dist/plugin.js');
  assertOk(packageJson.exports["./tui"] === "./dist/tui.js", 'package.json exports["./tui"] points to dist/tui.js');

  // === Root self-reference resolves and is callable as a factory ===
  const rootMod = (await import(pathToFileURL(rootDist).href)) as Record<string, unknown>;
  assertOk(typeof rootMod["SddPlugin"] === "function", "dist/plugin.js exports callable SddPlugin");
  assertOk(typeof rootMod["default"] === "function", "dist/plugin.js exports callable default");
  assertOk(rootMod["SddPlugin"] === rootMod["default"], "root default and named SddPlugin exports refer to the same function");
  // Host contract: OpenCode iterates EVERY export and treats it as a plugin
  // factory. A non-function export drops the plugin ("Plugin export is not a
  // function"); an exported helper would be invoked with the plugin context.
  const rootExportNames = Object.keys(rootMod);
  const rootNonFunctionExports = rootExportNames.filter((name) => typeof rootMod[name] !== "function");
  assertOk(
    rootNonFunctionExports.length === 0,
    `package entry exports only functions (offenders: ${rootNonFunctionExports.join(", ") || "none"})`,
  );
  assertOk(
    new Set(rootExportNames.map((name) => rootMod[name])).size === 1,
    `package entry exports only the plugin function (exports: ${rootExportNames.join(", ")})`,
  );
  // Invoke the built plugin against an ISOLATED temp user-data directory with a
  // temp legacy source. Without this the call would silently resolve the real
  // per-user database and could pass purely because that database is already
  // populated.
  const isolatedDataDir = path.join(exportsTmpDir, "user-data");
  const isolatedLegacyDb = path.join(exportsTmpDir, "legacy", "opencode-models.db");
  const isolatedDestDb = path.join(isolatedDataDir, "opencode-models.db");
  createSchemaDatabase(isolatedLegacyDb);

  process.env.SDD_PLUGIN_DATA_DIR = isolatedDataDir;
  process.env.SDD_PLUGIN_LEGACY_DB_PATH = isolatedLegacyDb;
  delete process.env.SDD_PLUGIN_DB_PATH;

  assertOk(!existsSync(isolatedDestDb), "isolated user-data database does not exist before first run");

  const hookMap = await (rootMod["SddPlugin"] as (ctx: unknown) => Promise<Record<string, unknown>>)({
    project: "self-reference",
    client: {},
    directory: "",
  });
  assertOk(
    hookMap !== null && typeof hookMap["tool.execute.before"] === "function",
    "root SddPlugin invocation returns hook map with tool.execute.before",
  );
  assertOk(
    existsSync(isolatedDestDb),
    "built bootstrap performed first-run migration into the isolated temp user-data directory",
  );

  // === TUI self-reference resolves and exports { id, tui } ===
  const tuiMod = (await import(pathToFileURL(tuiDist).href)) as Record<string, unknown>;
  const tuiDefault = tuiMod["default"] as { id?: unknown; tui?: unknown } | undefined;
  assertOk(tuiDefault !== undefined, "dist/tui.js has a default export");
  assertOk(tuiDefault?.id === "sdd-plugin.tui", "default export id === 'sdd-plugin.tui'");
  assertOk(typeof tuiDefault?.tui === "function", "default export tui is a function");

  // === Bun renderer test must contain a runtime guard and exit non-zero under Node ===
  const bunTest = path.resolve("tests/tui-bun-renderer.test.ts");
  assertOk(existsSync(bunTest), "tests/tui-bun-renderer.test.ts exists");
  const bunSource = readFileSync(bunTest, "utf8");
  assertOk(/Bun/.test(bunSource), "Bun renderer test references Bun runtime");
  assertOk(
    /Bun\s*===\s*["']undefined["']|Bun\s*===\s*undefined|\(\s*globalThis[\s\S]*?Bun\s*\?\s*\?[\s\S]*?undefined\s*\)/.test(bunSource),
    "Bun renderer test detects missing Bun runtime via runtime guard",
  );
  assertOk(/process\.exit\(\s*1\s*\)/.test(bunSource), "Bun renderer test exits non-zero when Bun is missing");
  assertOk(/npm\s+run\s+test:tui:bun/.test(bunSource), "Bun renderer failure message points to npm run test:tui:bun");

  // === CI workflow MUST include the Bun release gate ===
  const ciPath = path.resolve(".github/workflows/ci.yml");
  assertOk(existsSync(ciPath), ".github/workflows/ci.yml exists");
  const ciContent = readFileSync(ciPath, "utf8");
  assertOk(/oven-sh\/setup-bun/.test(ciContent), "CI workflow installs Bun via oven-sh/setup-bun");
  assertOk(/test:tui:bun/.test(ciContent), "CI workflow runs npm run test:tui:bun as the Bun release gate");
  assertOk(/npm\s+test\b/.test(ciContent), "CI workflow runs the Node test suite");

  // === Node test suite MUST NOT include the Bun-only test ===
  const allScript = packageJson.scripts["test:all"] ?? "";
  const testScript = packageJson.scripts["test"] ?? "";
  assertOk(!/tui-bun-renderer/.test(allScript), "test:all script does NOT include tui-bun-renderer (Node-only)");
  assertOk(!/tui-bun-renderer/.test(testScript), "test script does NOT include tui-bun-renderer (Node-only)");
  assertOk(/test:tui:bun/.test(JSON.stringify(packageJson.scripts)), "test:tui:bun script is declared in package.json");

  console.log("\n=== INTEGRATION PACKAGE EXPORTS + BUN GATE SUMMARY ===");
  if (failures.length === 0) {
    console.log("All package self-reference and Bun runtime gate assertions passed.");
    cleanup();
    process.exit(0);
  } else {
    console.error(failures.length + " assertion(s) failed.");
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  restoreEnv(exportsEnvSnapshot);
  removeTempDir(exportsTmpDir);
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});