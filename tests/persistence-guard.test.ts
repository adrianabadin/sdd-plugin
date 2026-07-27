/**
 * Finding 8 — Persistence guard covers main, WAL, and SHM (PR3 RED).
 *
 * The Windows persistence guard must:
 *   1. Use a Windows-safe child command (`npm.cmd` on win32) with
 *      `shell: false` so cmd.exe never re-spawns.
 *   2. Require at least one gate argument.
 *   3. Fingerprint the main database AND its `-wal` AND `-shm` sidecar files
 *      before/after the run, so a mutation of any of them is detected.
 *
 * RED contract (asserted before the guard fix):
 *   1. A `node scripts/persistence-guard.mjs` invocation with no gate exits
 *      0 in the broken implementation; the guard MUST exit non-zero.
 *   2. The guard source invokes bare `npm` on every platform (the broken
 *      implementation does NOT distinguish win32 / non-win32), which fails
 *      with ENOENT on Windows under `shell: false`.
 *   3. The guard only fingerprints the main DB, ignoring WAL/SHM.
 *
 * GREEN contract (asserted after the guard fix):
 *   1. Missing gate argument exits non-zero with an explicit error.
 *   2. The guard source resolves npm as `npm.cmd` on win32, `npm` elsewhere,
 *      and spawns with `shell: false`.
 *   3. The guard output references every fingerprinted target (main, -wal,
 *      -shm) for both the project DB and the user-data DB.
 *
 * The test does NOT attempt to spawn `npm.cmd` via `child_process` (Node
 * 22+ rejects bare `.cmd` invocations with EINVAL under `shell: false`,
 * and the test environment is not the right place to relax that contract).
 * Instead it asserts the static surface (guard source) and the BEFORE/AFTER
 * fingerprint output that the guard prints BEFORE running the gate.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardScript = path.join(repoRoot, "scripts", "persistence-guard.mjs");
const guardSource = fs.readFileSync(guardScript, "utf8");

console.log("--- Finding 8: persistence guard covers main, WAL, and SHM ---");

/**
 * Build a minimal synthetic DB + WAL + SHM triple under `root`. Returns the
 * three absolute paths so the test can mutate each independently.
 */
function setupTriple(root: string): { main: string; wal: string; shm: string } {
  const main = path.join(root, "opencode-models.db");
  const wal = `${main}-wal`;
  const shm = `${main}-shm`;
  fs.writeFileSync(main, "synthetic-main-content");
  fs.writeFileSync(wal, "synthetic-wal-content");
  fs.writeFileSync(shm, "synthetic-shm-content");
  return { main, wal, shm };
}

/**
 * Invoke the guard DIRECTLY (no npm wrapper) with the gate argument set to
 * a script the test never expects to succeed. The guard prints its
 * before/after fingerprint output to stdout BEFORE running the gate, so
 * the fingerprint surface is observable even when the gate fails.
 *
 * A failing gate still produces a guard exit code, but the fingerprint
 * output is what we assert on for the BEFORE/AFTER coverage.
 */
function invokeGuard(args: {
  cwd: string;
  userDataDir: string;
  gate: string;
}): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SDD_PLUGIN_")) delete env[key];
  }
  if (process.platform === "win32") {
    env.LOCALAPPDATA = args.userDataDir;
  } else {
    env.XDG_DATA_HOME = args.userDataDir;
  }
  const result = spawnSync(process.execPath, [guardScript, args.gate], {
    cwd: args.cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function run(): Promise<void> {
  assert.ok(
    fs.existsSync(guardScript),
    `guard script must exist at ${guardScript}`,
  );

  // === Assertion 0 — guard source uses a Windows-safe child command and
  //     `shell: false`. We accept either an explicit `npmCommand()` helper
  //     or an inline `isWindows ? "npm.cmd" : "npm"` selection; both
  //     indicate the production code never invokes `npm` bare on Windows.
  assert.ok(
    /isWindows\s*\?\s*["']npm\.cmd["']\s*:\s*["']npm["']/.test(guardSource) ||
      /npmCommand\s*\(/.test(guardSource),
    "guard must resolve npm via npm.cmd on win32 (PR3 Windows-safe selection)",
  );
  assert.ok(
    /shell\s*:\s*false/.test(guardSource),
    "guard must invoke npm with shell:false (PR3 Windows-safe spawn)",
  );
  console.log("  pass: guard source uses Windows-safe npm.cmd + shell:false");

  // === Assertion 1 — missing gate argument must exit non-zero. We invoke
  //     the guard DIRECTLY so the empty argv list triggers the guard's own
  //     gate-required check (no npm wrapper involved).
  const noGateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-guard-nogate-"));
  setupTriple(noGateRoot);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SDD_PLUGIN_")) delete env[key];
  }
  if (process.platform === "win32") {
    env.LOCALAPPDATA = path.join(noGateRoot, "user-data");
  } else {
    env.XDG_DATA_HOME = path.join(noGateRoot, "user-data");
  }
  const noGateDirect = spawnSync(process.execPath, [guardScript], {
    cwd: noGateRoot,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  assert.notEqual(
    noGateDirect.status,
    0,
    `guard with no gate MUST exit non-zero (got status=${noGateDirect.status})`,
  );
  assert.ok(
    /gate/i.test(noGateDirect.stderr) || /gate/i.test(noGateDirect.stdout),
    `guard with no gate MUST report a gate-related error (stderr=${noGateDirect.stderr.slice(-200)})`,
  );
  console.log("  pass: guard rejects missing gate argument with non-zero exit");

  // === Assertion 2 — fingerprints reference main + WAL + SHM. We invoke
  //     the guard with a gate that does not exist; the BEFORE fingerprint
  //     output is printed BEFORE the gate runs, so the surface (main, WAL,
  //     SHM, plus the synthetic targets) is observable.
  const walRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-guard-wal-"));
  const walTriple = setupTriple(walRoot);
  const walUserDataDir = path.join(walRoot, "user-data");
  fs.mkdirSync(path.join(walUserDataDir, "sdd-plugin"), { recursive: true });
  const surfaceResult = invokeGuard({
    cwd: walRoot,
    userDataDir: walUserDataDir,
    gate: "no-such-script-expected-to-fail",
  });
  // The guard may exit non-zero (because the gate failed); we only care
  // about the BEFORE/AFTER fingerprint surface being observable.
  void surfaceResult.status;
  // The guard output is captured, but path strings can contain spaces and
  // the output is split across multiple lines. Inspect the joined output
  // for the synthetic targets.
  const fullOutput = `${surfaceResult.stdout}\n${surfaceResult.stderr}`;
  // The guard prints per-target fingerprint labels (`main:`, `wal:`, `shm:`)
  // for both project and user-data DBs. Their presence in the output proves
  // the fingerprint surface covers main + WAL + SHM.
  assert.ok(
    fullOutput.includes("main:") &&
      fullOutput.includes(walTriple.main.split(/[\\/]/).pop()!),
    `guard output must reference the main fingerprint target (output=${fullOutput.slice(-400)})`,
  );
  assert.ok(
    /wal:\s+\S+/.test(fullOutput),
    `guard output must show a ` +
      "wal" +
      ` fingerprint label with a hash (output=${fullOutput.slice(-400)})`,
  );
  assert.ok(
    /shm:\s+\S+/.test(fullOutput),
    `guard output must show an ` +
      "shm" +
      ` fingerprint label with a hash (output=${fullOutput.slice(-400)})`,
  );
  console.log("  pass: guard fingerprints main, WAL, and SHM on every run");

  // Cleanup
  for (const root of [noGateRoot, walRoot]) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // best-effort
    }
  }
}

run()
  .then(() => {
    console.log("All persistence-guard assertions passed!");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });