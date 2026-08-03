/**
 * WU1 — SS-11, SS-12: PMC key-namespace shapes (RED-first).
 * See docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md
 * capability `sdd-status-store` ("PMC keys follow the declared namespace shapes").
 */

import assert from "node:assert/strict";

import { changeArtifactKey, consolidatedSpecKey } from "../src/domain/sdd/sdd-keys.js";

async function runTests(): Promise<void> {
  console.log("--- sdd-keys (RED-first) ---");

  // SS-11: change artifacts are namespaced by project and change.
  assert.equal(
    changeArtifactKey("abc123", "add-widget", "spec"),
    "sdd/abc123/add-widget/spec",
    "SS-11 change artifact key shape",
  );
  console.log("  pass: SS-11 change artifacts keyed sdd/{projectRootHash}/{changeName}/{artifact}");

  // SS-12: consolidated specs are namespaced by capability.
  assert.equal(
    consolidatedSpecKey("abc123", "sdd-project-identity"),
    "sdd/abc123/specs/sdd-project-identity",
    "SS-12 consolidated spec key shape",
  );
  console.log("  pass: SS-12 consolidated specs keyed sdd/{projectRootHash}/specs/{capability}");

  console.log("All sdd-keys tests passed.");
}

runTests().catch((err) => { console.error("Test failed:", err); process.exit(1); });
