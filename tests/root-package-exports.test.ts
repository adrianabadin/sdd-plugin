/**
 * Regression smoke test for root package exports and subpath exports.
 * Asserts that:
 * 1. The built root package export `dist/bootstrap/index.js` remains callable (exports default SddPlugin / SddPlugin function).
 * 2. The subpath export `./tui` (`dist/tui.js`) exports an object with `{ id, tui }` matching the TUI plugin module contract.
 * Note: `npm run build` must be executed prior to running this test.
 */
import RootPlugin, { SddPlugin } from "sdd-plugin2";
import TuiModule from "sdd-plugin2/tui";

const failures: string[] = [];

function assert(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error("  FAIL: " + message);
  } else {
    console.log("  pass: " + message);
  }
}

async function main(): Promise<void> {
  console.log("\n--- Root Package Exports Regression Smoke Test ---");

  // 1. Root Export Callable Check
  assert(typeof RootPlugin === "function", "Root default export (SddPlugin) is a function");
  assert(typeof SddPlugin === "function", "Root named export SddPlugin is a function");
  assert(RootPlugin === SddPlugin, "Root default and named SddPlugin export refer to the same function");

  // Verify calling root SddPlugin returns expected hook contract without throwing
  let dummyHookMap: Record<string, unknown> | null = null;
  try {
    dummyHookMap = await SddPlugin({ project: "test-smoke", directory: "/test" });
  } catch (err) {
    assert(false, "SddPlugin execution threw error: " + (err as Error).message);
  }
  assert(
    dummyHookMap !== null && typeof dummyHookMap["tool.execute.before"] === "function",
    "SddPlugin execution returns hook object containing 'tool.execute.before'"
  );
  assert(
    dummyHookMap !== null && !Object.hasOwn(dummyHookMap, "config"),
    "Built root export does not register disabled model-route config staging"
  );

  // 2. Subpath Export `./tui` Module Contract Check
  assert(TuiModule && typeof TuiModule === "object", "TUI module export is an object");
  assert(TuiModule.id === "sdd-plugin.tui", "TUI module exports id === 'sdd-plugin.tui'");
  assert(typeof TuiModule.tui === "function", "TUI module exports tui function");

  console.log("\n=== ROOT EXPORTS SMOKE TEST SUMMARY ===");
  if (failures.length === 0) {
    console.log("All root package export assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " assertion(s) failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
