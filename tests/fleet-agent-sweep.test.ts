import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  sweepOwnedFleetFiles,
  SweepIncompleteError,
} from "../src/infrastructure/opencode/disk-agent-generator.js";

const TEST_DIR = path.resolve("./scratch/test-fleet-sweep");

test("sweepOwnedFleetFiles removes owned files in agents and commands directories", () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  const agentsDir = path.join(TEST_DIR, ".opencode", "agents");
  const commandsDir = path.join(TEST_DIR, ".opencode", "commands");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(commandsDir, { recursive: true });

  const ownedAgent1 = path.join(agentsDir, "sdd-mr-v1-1234567890abcdef.md");
  const ownedAgent2 = path.join(agentsDir, "sdd-mr-v1-fedcba0987654321.md");
  const nonOwnedAgent = path.join(agentsDir, "custom-agent.md");
  const ownedCommand = path.join(commandsDir, "sdd-mr-canary-v1-1234567890abcdef.md");
  const nonOwnedCommand = path.join(commandsDir, "other-command.txt");

  writeFileSync(ownedAgent1, "# owned agent 1");
  writeFileSync(ownedAgent2, "# owned agent 2 (orphan)");
  writeFileSync(nonOwnedAgent, "# non owned agent");
  writeFileSync(ownedCommand, "# owned command");
  writeFileSync(nonOwnedCommand, "# non owned command");

  const res = sweepOwnedFleetFiles({ workspaceRoot: TEST_DIR });

  assert.equal(existsSync(ownedAgent1), false);
  assert.equal(existsSync(ownedAgent2), false);
  assert.equal(existsSync(ownedCommand), false);
  assert.equal(existsSync(nonOwnedAgent), true);
  assert.equal(existsSync(nonOwnedCommand), true);

  assert.equal(res.sweptRelativePaths.length, 3);
  assert.ok(res.sweptRelativePaths.includes(path.join(".opencode", "agents", "sdd-mr-v1-1234567890abcdef.md")));
  assert.ok(res.sweptRelativePaths.includes(path.join(".opencode", "agents", "sdd-mr-v1-fedcba0987654321.md")));
  assert.ok(res.sweptRelativePaths.includes(path.join(".opencode", "commands", "sdd-mr-canary-v1-1234567890abcdef.md")));
});

test("sweepOwnedFleetFiles propagates deterministic injected deletion failure", () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  const agentsDir = path.join(TEST_DIR, ".opencode", "agents");
  mkdirSync(agentsDir, { recursive: true });

  const ownedAgent = path.join(agentsDir, "sdd-mr-v1-fail.md");
  writeFileSync(ownedAgent, "# owned agent");

  const customRemove = (absPath: string) => {
    if (path.resolve(absPath).toLowerCase() === path.resolve(ownedAgent).toLowerCase()) {
      throw new Error("EPERM: permission denied");
    }
  };

  assert.throws(
    () => sweepOwnedFleetFiles({ workspaceRoot: TEST_DIR, removeFile: customRemove }),
    (err: unknown) => {
      assert.ok(err instanceof SweepIncompleteError);
      assert.equal(err.code, "SWEEP_INCOMPLETE");
      assert.equal(err.failedPath, path.join(".opencode", "agents", "sdd-mr-v1-fail.md"));
      return true;
    },
  );
});
