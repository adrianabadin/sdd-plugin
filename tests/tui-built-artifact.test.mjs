/**
 * Built-artifact test for the TUI entrypoint.
 *
 * Asserts that the BUILT `dist/tui.js` (not the source) can be loaded by a
 * real Node ESM `import()` and that the default export is a TUI module
 * exposing a callable `tui` function. This is the release gate that proves
 * the emitted `dist/` matches the runtime resolution rules of Node — a
 * source-only test (or one that runs through tsx, which adds non-standard
 * resolution of `.jsx` for `.js` specifiers) cannot catch emission
 * mismatches such as `.tsx` being emitted as `.jsx` while internal imports
 * still point at `.js`.
 *
 * Pre-requisite: `npm run build` must be executed prior to running this
 * test. The test will fail with a clear diagnostic if the built artifact is
 * missing or unloadable.
 *
 * This is a pure Node ESM script: run with `node tests/tui-built-artifact.test.mjs`.
 * Do NOT invoke Bun — the test must exercise Node's strict ESM resolution,
 * since OpenCode's host runtime resolves external plugin imports the same
 * way and `.jsx` is not auto-discovered.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

console.log("--- TUI Built-Artifact Test (Real Node ESM Import of dist/tui.js) ---");

const failures = [];

function assertOk(condition, message) {
  if (condition) {
    console.log("  pass: " + message);
  } else {
    failures.push(message);
    console.error("  FAIL: " + message);
  }
}

async function run() {
  const tuiDist = path.resolve("dist/tui.js");
  assertOk(existsSync(tuiDist), "dist/tui.js exists after build");

  // Real Node ESM import of the BUILT artifact (NOT the source, NOT via tsx).
  // This is what catches the original TUI plugin failure where the build
  // emits `.jsx` while internal imports still point at `.js`. Node ESM does
  // not auto-resolve `.jsx` for `.js` specifiers and throws ERR_MODULE_NOT_FOUND.
  let tuiMod = null;
  try {
    tuiMod = await import(pathToFileURL(tuiDist).href);
  } catch (err) {
    assertOk(false, "import('dist/tui.js') did not throw: " + (err && err.message ? err.message : String(err)));
  }

  // The default export must be a TUI module object with a callable `tui`.
  const tuiDefault = tuiMod && tuiMod.default;
  assertOk(tuiDefault !== undefined, "dist/tui.js has a default export");
  assertOk(typeof (tuiDefault && tuiDefault.tui) === "function", "default export tui is a function");
  assertOk(tuiDefault && tuiDefault.id === "sdd-plugin.tui", "default export id === 'sdd-plugin.tui'");

  console.log("\n=== TUI BUILT-ARTIFACT TEST SUMMARY ===");
  if (failures.length === 0) {
    console.log("All built-artifact assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " assertion(s) failed.");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("TUI built-artifact test crashed:", err);
  process.exit(1);
});
