/**
 * WU2 — SS-5, SS-6: the discovery shape (RED-first).
 * See docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md capability
 * `sdd-status-store`.
 */

import assert from "node:assert/strict";

import { assembleDiscoveryStatus } from "../src/application/sdd/compute-discovery-status.js";

const ALLOWED_DISCOVERY_NEXT_RECOMMENDED = ["init", "select-change", "sdd-new"];

async function runTests(): Promise<void> {
  console.log("--- sdd-discovery-status (RED-first) ---");

  // SS-6: an uninitialized project reports initialized:false and nextRecommended:init.
  {
    const result = assembleDiscoveryStatus("/repo/project", false, []);
    assert.equal(result.initialized, false, "SS-6 uninitialized project reports initialized:false");
    assert.equal(result.nextRecommended, "init", "SS-6 uninitialized project recommends init");
  }
  console.log("  pass: SS-6 an uninitialized project reports initialized:false and nextRecommended:init");

  // SS-5: discovery shape returns exactly {projectRoot, initialized, changes[], nextRecommended},
  // restricted to init | select-change | sdd-new.
  {
    const shape = ["projectRoot", "initialized", "changes", "nextRecommended"];

    const initializedNoChanges = assembleDiscoveryStatus("/repo/project", true, []);
    for (const field of shape) {
      assert.ok(field in initializedNoChanges, `SS-5 discovery shape includes '${field}'`);
    }
    assert.ok(
      ALLOWED_DISCOVERY_NEXT_RECOMMENDED.includes(initializedNoChanges.nextRecommended),
      "SS-5 nextRecommended is restricted to init|select-change|sdd-new",
    );
    assert.equal(
      initializedNoChanges.nextRecommended,
      "sdd-new",
      "SS-5 an initialized project with no changes recommends sdd-new",
    );

    const changes = [{ changeName: "add-widget", nextRecommended: "apply" as const }];
    const initializedWithChanges = assembleDiscoveryStatus("/repo/project", true, changes);
    assert.deepEqual(initializedWithChanges.changes, changes, "SS-5 changes[] is carried through unmodified");
    assert.equal(
      initializedWithChanges.nextRecommended,
      "select-change",
      "SS-5 an initialized project with existing changes recommends select-change",
    );
    assert.ok(
      ALLOWED_DISCOVERY_NEXT_RECOMMENDED.includes(initializedWithChanges.nextRecommended),
      "SS-5 nextRecommended stays restricted to init|select-change|sdd-new",
    );
  }
  console.log("  pass: SS-5 discovery shape returns the full restricted shape");

  console.log("All sdd-discovery-status tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
