/**
 * WU6 — IR-1 through IR-12: Init round implementation tests.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-init-round`).
 */

import assert from "node:assert/strict";

import {
  detectProjectFacts,
  getInitQuestions,
  mergeConfig,
  shouldReopenConfig,
  type InitDetectionResult,
} from "../src/domain/sdd/init-round.js";
import {
  isProjectInitialized,
  saveInitConfig,
  SaveConfigBeforeDetectionError,
} from "../src/application/sdd/init-round.js";
import { initConfigKey } from "../src/domain/sdd/sdd-keys.js";
import type { CheckpointRecord, CheckpointWriteResult, SddArtifactStorePort } from "../src/ports/sdd-artifact-store.port.js";

/** In-memory mock for SddArtifactStorePort */
class MockArtifactStore implements SddArtifactStorePort {
  private artifacts = new Map<string, string>();
  private checkpoints = new Map<string, { content: unknown; version: number }>();
  private nextVersion = 1;

  async writeArtifact(key: string, content: string): Promise<void> {
    this.artifacts.set(key, content);
  }

  async readArtifact(key: string): Promise<string | null> {
    return this.artifacts.get(key) ?? null;
  }

  async writeCheckpoint(key: string, content: unknown): Promise<CheckpointWriteResult> {
    const version = this.nextVersion++;
    this.checkpoints.set(key, { content, version });
    return { version };
  }

  async readCheckpoint(key: string): Promise<CheckpointRecord | null> {
    const val = this.checkpoints.get(key);
    return val ? { content: val.content, version: val.version } : null;
  }
  /** Final-review finding #3 — stub for the atomic persist seam. */
  async persistArtifactWithOwnership(): Promise<never> {
    throw new Error("MockArtifactStore.persistArtifactWithOwnership is not exercised by these tests");
  }
}

async function runTests(): Promise<void> {
  console.log("--- sdd-init-round (WU6 tasks IR-1 to IR-12) ---");

  // IR-1: Detection reports a slot for each of stack, testing command, strict-TDD support, conventions
  {
    const files = {
      "package.json": JSON.stringify({ scripts: { test: "npm test" }, dependencies: { vitest: "^1.0.0" } }),
      "tsconfig.json": "{}",
      ".eslintrc": "{}",
    };
    const detection = detectProjectFacts(files);
    assert.ok("stack" in detection, "IR-1 stack slot present");
    assert.ok("testingCommand" in detection, "IR-1 testingCommand slot present");
    assert.ok("strictTddSupport" in detection, "IR-1 strictTddSupport slot present");
    assert.ok("conventions" in detection, "IR-1 conventions slot present");
    assert.equal(detection.stack, "typescript");
    assert.equal(detection.testingCommand, "npm test");
    assert.equal(detection.conventions, "eslint");
  }
  console.log("  pass: IR-1 detection reports slots for stack, testing command, strict-TDD, conventions");

  // IR-2: Uninferable test command is recorded as unknown, never a defaulted guess, and appears among residuals
  {
    const files = { "custom.file": "hello" };
    const detection = detectProjectFacts(files);
    assert.equal(detection.testingCommand, "unknown", "IR-2 test command is unknown, not guessed");
    assert.ok(detection.residuals.includes("testingCommand"), "IR-2 testingCommand appears in residuals");
  }
  console.log("  pass: IR-2 uninferable test command recorded as unknown and in residuals");

  // IR-2b (never-guess remediation): a go.mod or Cargo.toml manifest does NOT
  // yield a fabricated "go test ./..." or "cargo test". Only a manifest that
  // DECLARES the test command (package.json scripts.test) counts; manifest
  // presence alone is a guess. The earlier version hardcoded both.
  {
    const goDetection = detectProjectFacts({ "go.mod": "module example\n" });
    assert.equal(goDetection.testingCommand, "unknown", "IR-2b go.mod does not fabricate 'go test ./...'");
    assert.ok(goDetection.residuals.includes("testingCommand"), "IR-2b go.mod surfaces a testingCommand residual");

    const cargoDetection = detectProjectFacts({ "Cargo.toml": "[package]\nname = \"x\"\n" });
    assert.equal(cargoDetection.testingCommand, "unknown", "IR-2b Cargo.toml does not fabricate 'cargo test'");
    assert.ok(cargoDetection.residuals.includes("testingCommand"), "IR-2b Cargo.toml surfaces a testingCommand residual");
  }
  console.log("  pass: IR-2b go.mod and Cargo.toml report testingCommand unknown (never guess)");

  // IR-3: The init phase neither prompts the user nor persists config itself
  {
    const files = {};
    const detection = detectProjectFacts(files);
    assert.ok(Array.isArray(detection.residuals), "IR-3 returns detection report object without persistence");
  }
  console.log("  pass: IR-3 init detection is pure and produces report without persisting");

  // IR-4: Inferred facts produce no question
  {
    const files = {
      "package.json": JSON.stringify({ scripts: { test: "npm test" }, dependencies: { vitest: "^1.0.0" } }),
      "tsconfig.json": "{}",
      ".eslintrc": "{}",
    };
    const detection = detectProjectFacts(files);
    const questionsResult = getInitQuestions(detection);
    assert.equal(questionsResult.questions.length, 0, "IR-4 no questions produced for fully inferred facts");
  }
  console.log("  pass: IR-4 inferred facts produce no questions");

  // IR-5: No storage-backend question is ever asked
  {
    const emptyDetection: InitDetectionResult = {
      stack: null,
      testingCommand: "unknown",
      strictTddSupport: null,
      conventions: null,
      testingSkill: null,
      residuals: ["stack", "testingCommand", "strictTddSupport", "conventions", "artifactStore", "storageBackend"],
    };
    const questionsResult = getInitQuestions(emptyDetection);
    const hasStorageQ = questionsResult.questions.some(
      (q) => q.field === "artifactStore" || q.field === "storageBackend" || q.question.toLowerCase().includes("storage"),
    );
    assert.equal(hasStorageQ, false, "IR-5 storage backend question is never asked");
  }
  console.log("  pass: IR-5 no storage-backend question ever asked");

  // IR-6: Config merges detected facts with user answers, user's answer winning on conflict, persisted at sdd-init/{projectRootHash}
  {
    const store = new MockArtifactStore();
    const hash = "abc123hash";
    const detection: InitDetectionResult = {
      stack: "typescript",
      testingCommand: "npm test",
      strictTddSupport: true,
      conventions: "eslint",
      testingSkill: null,
      residuals: [],
    };
    const userAnswers = { testingCommand: "vitest run --coverage" };
    const savedConfig = await saveInitConfig(store, hash, detection, userAnswers);

    assert.equal(savedConfig.stack, "typescript", "IR-6 stack preserved from detection");
    assert.equal(savedConfig.testingCommand, "vitest run --coverage", "IR-6 user answer wins over detection");

    const expectedKey = initConfigKey(hash);
    const storedRecord = await store.readCheckpoint(expectedKey);
    assert.deepEqual(storedRecord?.content, savedConfig, "IR-6 config persisted at sdd-init/{projectRootHash}");
  }
  console.log("  pass: IR-6 config merges facts with user answers winning, persisted at sdd-init/{hash}");

  // IR-7: The detected testing skill is persisted as a testingSkill config key
  {
    const files = {
      "package.json": JSON.stringify({ scripts: { test: "vitest" }, dependencies: { vitest: "^1.0.0" } }),
    };
    const detection = detectProjectFacts(files);
    assert.equal(detection.testingSkill, "vitest-skill", "IR-7 vitest skill detected");

    const merged = mergeConfig(detection);
    assert.equal(merged.testingSkill, "vitest-skill", "IR-7 testingSkill persisted in merged config");
  }
  console.log("  pass: IR-7 detected testing skill persisted as testingSkill config key");

  // IR-8: An unregistered testing skill persists as an explicit null, not an absent key
  {
    const files = { "package.json": JSON.stringify({ scripts: { test: "custom-runner" } }) };
    const detection = detectProjectFacts(files);
    assert.equal(detection.testingSkill, null, "IR-8 testingSkill is null for unregistered skill");

    const merged = mergeConfig(detection);
    assert.ok("testingSkill" in merged, "IR-8 testingSkill key is present in config object");
    assert.equal(merged.testingSkill, null, "IR-8 testingSkill is explicit null, not omitted");
  }
  console.log("  pass: IR-8 unregistered testing skill persists as explicit null");

  // IR-9: An already-initialized project skips the round
  {
    const store = new MockArtifactStore();
    const hash = "project-already-init";
    await store.writeCheckpoint(initConfigKey(hash), { stack: "typescript", testingSkill: null });

    const initialized = await isProjectInitialized(store, hash);
    assert.equal(initialized, true, "IR-9 returns true for already initialized project");
  }
  console.log("  pass: IR-9 already-initialized project detected as initialized");

  // IR-10: A first-time run executes the round in full before any other phase dispatches
  {
    const store = new MockArtifactStore();
    const hash = "first-time-project";

    let initialized = await isProjectInitialized(store, hash);
    assert.equal(initialized, false, "IR-10 initially uninitialized");

    // Full round execution
    const files = { "package.json": JSON.stringify({ scripts: { test: "npm test" } }) };
    const detection = detectProjectFacts(files);
    await saveInitConfig(store, hash, detection, {});

    initialized = await isProjectInitialized(store, hash);
    assert.equal(initialized, true, "IR-10 initialized after full round");
  }
  console.log("  pass: IR-10 first-time run uninitialized before, initialized after full round");

  // IR-11: A request conflicting with stored config re-opens that field
  {
    const storedConfig = {
      stack: "typescript",
      testingCommand: "npm test",
      strictTddSupport: true,
      conventions: "eslint",
      testingSkill: null,
      model: "glm-4.7-flash",
    };
    const request = { model: "claude-3-5-sonnet" };
    const result = shouldReopenConfig(storedConfig, request);

    assert.equal(result.reOpen, true, "IR-11 reOpen is true on model conflict");
    assert.deepEqual(result.reOpenFields, ["model"], "IR-11 reOpenFields contains model");
  }
  console.log("  pass: IR-11 request conflicting with stored config re-opens field");

  // IR-12: sdd_save_config is refused before detection has run
  {
    const store = new MockArtifactStore();
    const hash = "no-detection-hash";

    await assert.rejects(
      async () => {
        await saveInitConfig(store, hash, null, { stack: "typescript" });
      },
      SaveConfigBeforeDetectionError,
      "IR-12 saveInitConfig throws SaveConfigBeforeDetectionError when detection is null",
    );
  }
  console.log("  pass: IR-12 save config refused before detection has run");

  console.log("\nAll 13 sdd-init-round (WU6) tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
