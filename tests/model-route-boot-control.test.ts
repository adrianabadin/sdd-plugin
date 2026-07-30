import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stopModelRouteSupervisor } from "../src/infrastructure/runtime/model-route-boot-control.js";
import { mapModelRouteStopResult } from "../src/cli/model-route-boot-stop-output.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const bootCli = path.join(repoRoot, "src", "cli", "model-route-boot.ts");

interface ControlPaths {
  readonly root: string;
  readonly attestationPath: string;
  readonly lockPath: string;
  readonly controlPath: string;
}

function seedControlFiles(pid: number): ControlPaths {
  const root = mkdtempSync(path.join(tmpdir(), "sdd-mr-stop-control-"));
  const routingDir = path.join(root, ".opencode", "sdd-model-routing");
  const attestationPath = path.join(routingDir, "attestation.json");
  const lockPath = path.join(routingDir, "generator.lock");
  const controlPath = path.join(routingDir, "boot-control.json");
  mkdirSync(routingDir, { recursive: true });
  writeFileSync(attestationPath, JSON.stringify({ bootIdentity: "boot-old" }));
  writeFileSync(lockPath, JSON.stringify({ pid, acquiredAt: 1, bootIdentity: "boot-old" }));
  writeFileSync(controlPath, JSON.stringify({ pid, bootIdentity: "boot-old", startedAt: 1 }));
  return { root, attestationPath, lockPath, controlPath };
}

function assertAllArtifacts(paths: ControlPaths, expected: boolean): void {
  for (const artifactPath of [paths.attestationPath, paths.lockPath, paths.controlPath]) {
    assert.equal(existsSync(artifactPath), expected, artifactPath);
  }
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: synthetic process failure`), { code });
}

function runBootCli(workspaceRoot: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [tsxCli, bootCli, "stop", workspaceRoot],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { stdout, stderr: "", code: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      code: typeof result.status === "number" ? result.status : 1,
    };
  }
}

function run(): void {
  console.log("--- model route boot control ---");

  {
    const paths = seedControlFiles(41001);
    const operations: Array<[number, NodeJS.Signals | 0]> = [];
    try {
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        probeProcess: (pid) => { operations.push([pid, 0]); },
        signalProcess: (pid, signal) => { operations.push([pid, signal]); },
      });

      assert.deepEqual(operations, [[41001, 0], [41001, "SIGTERM"]]);
      assert.deepEqual(result, { status: "signaled", pid: 41001, bootIdentity: "boot-old" });
      assertAllArtifacts(paths, true);
      console.log("  pass: old lock with live pid is signaled and artifacts are retained");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(41002);
    try {
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        probeProcess: () => { throw errno("ESRCH"); },
        signalProcess: () => { assert.fail("dead process must not be signaled"); },
      });

      assert.deepEqual(result, { status: "cleaned", pid: 41002, bootIdentity: "boot-old" });
      assertAllArtifacts(paths, false);
      console.log("  pass: dead pid cleans attestation, lock, and control files");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(41003);
    try {
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        probeProcess: () => undefined,
        signalProcess: () => { throw errno("EPERM"); },
      });

      assert.deepEqual(result, {
        status: "stop-failed",
        operation: "signal",
        pid: 41003,
        bootIdentity: "boot-old",
        errorCode: "EPERM",
        errorMessage: "EPERM: synthetic process failure",
      });
      assertAllArtifacts(paths, true);
      console.log("  pass: EPERM signal failure retains all artifacts and fails closed");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(41004);
    try {
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        probeProcess: () => { throw errno("EPERM"); },
        signalProcess: () => { assert.fail("inaccessible process must not be signaled"); },
      });

      assert.deepEqual(result, {
        status: "stop-failed",
        operation: "probe",
        pid: 41004,
        bootIdentity: "boot-old",
        errorCode: "EPERM",
        errorMessage: "EPERM: synthetic process failure",
      });
      assertAllArtifacts(paths, true);
      console.log("  pass: EPERM probe failure retains all artifacts and fails closed");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(41005);
    try {
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        probeProcess: () => undefined,
        signalProcess: () => { throw errno("ESRCH"); },
      });

      assert.deepEqual(result, {
        status: "cleaned",
        pid: 41005,
        bootIdentity: "boot-old",
        signalError: "ESRCH: synthetic process failure",
      });
      assertAllArtifacts(paths, false);
      console.log("  pass: ESRCH signal race safely cleans all artifacts");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(41006);
    try {
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        probeProcess: () => { throw new Error("probe transport unavailable"); },
        signalProcess: () => { assert.fail("indeterminate process must not be signaled"); },
      });

      assert.deepEqual(result, {
        status: "stop-failed",
        operation: "probe",
        pid: 41006,
        bootIdentity: "boot-old",
        errorCode: null,
        errorMessage: "probe transport unavailable",
      });
      assertAllArtifacts(paths, true);
      console.log("  pass: unknown probe failure retains all artifacts and fails closed");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(41007);
    try {
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        probeProcess: () => undefined,
        signalProcess: () => { throw new Error("signal transport unavailable"); },
      });

      assert.deepEqual(result, {
        status: "stop-failed",
        operation: "signal",
        pid: 41007,
        bootIdentity: "boot-old",
        errorCode: null,
        errorMessage: "signal transport unavailable",
      });
      assertAllArtifacts(paths, true);
      console.log("  pass: unknown signal failure retains all artifacts and fails closed");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(41008);
    try {
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        readRecord: (recordPath) => {
          if (recordPath === paths.lockPath) throw errno("EACCES");
          return readFileSync(recordPath, "utf8");
        },
        probeProcess: () => { assert.fail("unreadable lock must not resolve a pid"); },
        signalProcess: () => { assert.fail("unreadable lock must not signal a pid"); },
      });

      assert.deepEqual(result, {
        status: "stop-failed",
        operation: "read-lock",
        pid: null,
        bootIdentity: "",
        errorCode: "EACCES",
        errorMessage: "EACCES: synthetic process failure",
      });
      assertAllArtifacts(paths, true);
      console.log("  pass: lock EACCES retains all artifacts and fails closed");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(41009);
    try {
      rmSync(paths.lockPath, { force: true });
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        readRecord: (recordPath) => {
          if (recordPath === paths.controlPath) throw errno("EIO");
          return readFileSync(recordPath, "utf8");
        },
        probeProcess: () => { assert.fail("unreadable control must not resolve a pid"); },
        signalProcess: () => { assert.fail("unreadable control must not signal a pid"); },
      });

      assert.deepEqual(result, {
        status: "stop-failed",
        operation: "read-control",
        pid: null,
        bootIdentity: "",
        errorCode: "EIO",
        errorMessage: "EIO: synthetic process failure",
      });
      assert.equal(existsSync(paths.attestationPath), true);
      assert.equal(existsSync(paths.controlPath), true);
      console.log("  pass: control EIO after absent lock retains artifacts and fails closed");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(42001);
    const probed: number[] = [];
    const readPaths: string[] = [];
    try {
      writeFileSync(paths.controlPath, JSON.stringify({ pid: 42002, bootIdentity: "boot-control" }));
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        readRecord: (recordPath) => {
          readPaths.push(recordPath);
          if (recordPath === paths.controlPath) throw errno("EIO");
          return readFileSync(recordPath, "utf8");
        },
        probeProcess: (pid) => { probed.push(pid); },
        signalProcess: () => undefined,
      });

      assert.deepEqual(readPaths, [paths.lockPath]);
      assert.deepEqual(probed, [42001]);
      assert.deepEqual(result, { status: "signaled", pid: 42001, bootIdentity: "boot-old" });
      assertAllArtifacts(paths, true);
      console.log("  pass: valid lock pid takes priority without reading failed control record");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  for (const lockState of ["absent", "malformed", "invalid"] as const) {
    const paths = seedControlFiles(43001);
    try {
      writeFileSync(paths.controlPath, JSON.stringify({ pid: 43002, bootIdentity: "boot-control" }));
      if (lockState === "absent") rmSync(paths.lockPath, { force: true });
      if (lockState === "malformed") writeFileSync(paths.lockPath, "{not-json");
      if (lockState === "invalid") writeFileSync(paths.lockPath, JSON.stringify({ pid: 0, bootIdentity: "boot-invalid" }));
      const operations: Array<[number, NodeJS.Signals | 0]> = [];
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        probeProcess: (pid) => { operations.push([pid, 0]); },
        signalProcess: (pid, signal) => { operations.push([pid, signal]); },
      });

      assert.deepEqual(operations, [[43002, 0], [43002, "SIGTERM"]]);
      assert.deepEqual(result, { status: "signaled", pid: 43002, bootIdentity: "boot-control" });
      assert.equal(existsSync(paths.attestationPath), true);
      assert.equal(existsSync(paths.controlPath), true);
      console.log(`  pass: control-record pid is used when lock is ${lockState}`);
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(0);
    try {
      writeFileSync(paths.controlPath, JSON.stringify({ pid: -1, bootIdentity: "boot-invalid" }));
      const removed: string[] = [];
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        probeProcess: () => { assert.fail("invalid pid must not be probed"); },
        signalProcess: () => { assert.fail("invalid pid must not be signaled"); },
        removeArtifact: (artifactPath) => {
          removed.push(artifactPath);
          rmSync(artifactPath, { force: true });
        },
      });

      assert.deepEqual(removed, [paths.attestationPath, paths.lockPath, paths.controlPath]);
      assert.deepEqual(result, { status: "cleaned", pid: null, bootIdentity: "" });
      assertAllArtifacts(paths, false);
      console.log("  pass: invalid lock and control pids clean all three artifacts");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const paths = seedControlFiles(44001);
    try {
      const result = stopModelRouteSupervisor({
        ...paths,
        currentPid: 999,
        probeProcess: () => { throw errno("ESRCH"); },
        signalProcess: () => { assert.fail("dead process must not be signaled"); },
        removeArtifact: (artifactPath) => {
          if (artifactPath === paths.lockPath) throw new Error("EACCES: lock retained");
          rmSync(artifactPath, { force: true });
        },
      });

      assert.deepEqual(result, {
        status: "cleanup-failed",
        pid: 44001,
        bootIdentity: "boot-old",
        remainingPaths: [paths.lockPath],
        cleanupErrors: [`${paths.lockPath}: EACCES: lock retained`],
      });
      assert.equal(existsSync(paths.attestationPath), false);
      assert.equal(existsSync(paths.lockPath), true);
      assert.equal(existsSync(paths.controlPath), false);
      console.log("  pass: cleanup failure is observable and identifies the retained artifact");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }

  {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const focusedCommand = /(?:^|\s)npx tsx tests\/model-route-boot-control\.test\.ts(?:\s|$)/;
    assert.match(
      packageJson.scripts?.["test:model-routes"] ?? "",
      focusedCommand,
      "test:model-routes must execute the stop-control regression test",
    );
    assert.match(
      packageJson.scripts?.["test:all"] ?? "",
      focusedCommand,
      "test:all must directly execute the stop-control regression test",
    );
    assert.equal(packageJson.scripts?.["test"], "npm run test:all", "npm test must delegate to test:all");
    console.log("  pass: test:model-routes and npm test require the stop-control regression test");
  }

  {
    const output = mapModelRouteStopResult({
      status: "stop-failed",
      operation: "read-control",
      pid: null,
      bootIdentity: "",
      errorCode: "EIO",
      errorMessage: "EIO: control record unavailable",
    });

    assert.equal(output.code, 1);
    assert.equal(output.stdout, "", "stop-failed mapping never prints cleaned success");
    assert.match(output.stderr, /stop failed during read-control/i);
    assert.match(output.stderr, /EIO.*control record unavailable/i);
    assert.match(output.stderr, /artifacts retained/i);
    console.log("  pass: production CLI mapper reports stop-failed with exit 1 and no false success");
  }

  {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "sdd-mr-stop-cli-"));
    const routingDir = path.join(workspaceRoot, ".opencode", "sdd-model-routing");
    const attestationPath = path.join(routingDir, "attestation.json");
    try {
      mkdirSync(attestationPath, { recursive: true });
      writeFileSync(path.join(routingDir, "generator.lock"), JSON.stringify({ pid: 0 }));
      writeFileSync(path.join(routingDir, "boot-control.json"), JSON.stringify({ pid: -1 }));

      const result = runBootCli(workspaceRoot);

      assert.equal(result.code, 1, `CLI cleanup failure exits 1 (stderr=${result.stderr})`);
      assert.match(result.stderr, /boot: cleanup failed/i, "CLI reports cleanup failure");
      assert.ok(result.stderr.includes(attestationPath), "CLI identifies the retained artifact path");
      assert.match(
        result.stderr,
        /EISDIR|EPERM|is a directory|operation not permitted/i,
        "CLI reports the underlying filesystem reason",
      );
      assert.doesNotMatch(result.stdout, /state=idle.*cleaned stale/i, "CLI does not print false cleanup success");
      console.log("  pass: real stop CLI reports cleanup failure and exits 1");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "sdd-mr-stop-read-cli-"));
    const routingDir = path.join(workspaceRoot, ".opencode", "sdd-model-routing");
    const attestationPath = path.join(routingDir, "attestation.json");
    const lockPath = path.join(routingDir, "generator.lock");
    const controlPath = path.join(routingDir, "boot-control.json");
    try {
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(attestationPath, JSON.stringify({ bootIdentity: "boot-read-failure" }));
      writeFileSync(controlPath, JSON.stringify({ pid: 45001, bootIdentity: "boot-read-failure" }));

      const result = runBootCli(workspaceRoot);

      assert.equal(result.code, 1, `CLI record-read failure exits 1 (stderr=${result.stderr})`);
      assert.match(result.stderr, /stop failed during read-lock/i);
      assert.match(result.stderr, /EISDIR|EPERM|is a directory|operation not permitted/i);
      assert.match(result.stderr, /artifacts retained/i);
      assert.doesNotMatch(result.stdout, /state=idle.*cleaned stale/i);
      assert.equal(existsSync(attestationPath), true);
      assert.equal(existsSync(lockPath), true);
      assert.equal(existsSync(controlPath), true);
      console.log("  pass: real stop CLI retains artifacts on operational record-read failure");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  console.log("All model-route boot-control assertions passed!");
}

run();
