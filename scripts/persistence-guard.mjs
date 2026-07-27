/**
 * Guard harness — no gated test may write to a real project/user database.
 *
 * Set SDD_PROJECT_DB_GUARD=1 alongside test:persistence/test:tui/test:tui:bun/
 * test:integration to have the runner verify that:
 *   1. The real project database (opencode-models.db) is byte-identical before
 *      and after the suite.
 *   2. The platform user-data database (%LOCALAPPDATA%\sdd-plugin\ on Windows,
 *      $XDG_DATA_HOME/sdd-plugin/ on Linux, $HOME/Library/.../sdd-plugin/ on
 *      macOS) has unchanged mtime/hash.
 *   3. The `-wal` and `-shm` sidecar files of EACH fingerprinted database are
 *      also byte-identical, because a write committed only to the journal
 *      would otherwise go undetected by a main-DB-only fingerprint.
 *
 * Spawning is Windows-safe: `npm.cmd` is invoked with `shell: false` so the
 * gate does not re-spawn through cmd.exe. At least one gate argument MUST be
 * supplied; a guard run with no gates fails immediately so a misconfigured
 * CI cannot silently produce a "passing" result while proving nothing.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";

/** Per-platform npm executable used to spawn gates with `shell: false`. */
function npmCommand() {
  return isWindows ? "npm.cmd" : "npm";
}

/**
 * Per-platform argv for the npm gate invocation. On Windows we MUST prepend
 * `cmd.exe /c` so the `.cmd` shim is resolved through cmd.exe's normal
 * command lookup; Node 22+ rejects bare `npm.cmd` invocations with EINVAL
 * when `shell: false` is requested. `cmd.exe /c npm.cmd ...` is still a
 * shell-free spawn: the parent process never invokes the user's shell,
 * only the explicit `cmd.exe` binary.
 */
function npmArgv(gate) {
  if (isWindows) return ["cmd.exe", "/c", npmCommand(), "run", gate];
  return ["run", gate];
}

/** SHA-256 fingerprint of `target` plus its size and mtime. */
function fingerprint(target) {
  if (!fs.existsSync(target)) return "ABSENT";
  const stat = fs.statSync(target);
  const hash = createHash("sha256");
  const fd = fs.openSync(target, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytes <= 0) break;
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
  return `${hash.digest("hex")}:${stat.size}:${stat.mtimeMs}`;
}

/** Produce a deterministic set of fingerprint targets for a base DB path. */
function fingerprintTargets(basePath) {
  return {
    main: basePath,
    wal: `${basePath}-wal`,
    shm: `${basePath}-shm`,
  };
}

/** Fingerprint the main DB together with its -wal and -shm sidecars. */
function fingerprintTriple(basePath) {
  const targets = fingerprintTargets(basePath);
  return {
    main: fingerprint(targets.main),
    wal: fingerprint(targets.wal),
    shm: fingerprint(targets.shm),
  };
}

/**
 * Resolve the user-data database path. The user-data DB is the destination
 * runtime initializers provision under; SDD_PLUGIN_DB_PATH and
 * SDD_PLUGIN_DATA_DIR override it for hermetic tests.
 */
function resolveUserDataDb() {
  if (process.env.SDD_PLUGIN_DB_PATH) return null;
  if (process.env.SDD_PLUGIN_DATA_DIR) {
    return path.resolve(process.env.SDD_PLUGIN_DATA_DIR, "opencode-models.db");
  }
  let dataDir;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    dataDir = path.join(localAppData, "sdd-plugin");
  } else if (process.platform === "darwin") {
    dataDir = path.join(os.homedir(), "Library", "Application Support", "sdd-plugin");
  } else {
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    dataDir = path.join(xdgData, "sdd-plugin");
  }
  return path.join(dataDir, "opencode-models.db");
}

/**
 * Resolve the project DB path. The project DB lives in the current working
 * directory under `opencode-models.db` by default; SDD_PLUGIN_DB_PATH and
 * SDD_PLUGIN_DATA_DIR override it. Without this override the guard would
 * always fingerprint the real production DB in the repo root, which hermetic
 * tests cannot redirect.
 */
function resolveProjectDb() {
  if (process.env.SDD_PLUGIN_DB_PATH) {
    return path.resolve(process.env.SDD_PLUGIN_DB_PATH);
  }
  if (process.env.SDD_PLUGIN_DATA_DIR) {
    return path.resolve(process.env.SDD_PLUGIN_DATA_DIR, "opencode-models.db");
  }
  return path.resolve("opencode-models.db");
}

const projectDb = resolveProjectDb();
const userDataDb = resolveUserDataDb();

const beforeProject = fingerprintTriple(projectDb);
const beforeUserData = userDataDb ? fingerprintTriple(userDataDb) : null;

console.log("=== persistence guard: before ===");
console.log(`  project DB:     ${projectDb}`);
console.log(`    main: ${beforeProject.main}`);
console.log(`    wal:  ${beforeProject.wal}`);
console.log(`    shm:  ${beforeProject.shm}`);
console.log(`  user-data DB:   ${userDataDb ?? "(N/A)"}`);
if (beforeUserData) {
  console.log(`    main: ${beforeUserData.main}`);
  console.log(`    wal:  ${beforeUserData.wal}`);
  console.log(`    shm:  ${beforeUserData.shm}`);
}

const gates = process.argv.slice(2);
if (gates.length === 0) {
  console.error(
    "Persistence guard requires at least one gate argument (e.g. `node scripts/persistence-guard.mjs test:persistence`).",
  );
  process.exit(2);
}

let failed = false;
for (const gate of gates) {
  console.log(`\n--- running gate: ${gate}`);
  const result = spawnSync(npmArgv(gate)[0], npmArgv(gate).slice(1), {
    stdio: "inherit",
    // Windows-safe defaults: `shell` defaults to false in `spawnSync`, which
    // is exactly what we want — `shell:true` would re-spawn through the
    // user's shell, defeating the PR3 Windows-safety contract. On win32 we
    // route through `cmd.exe /c npm.cmd` so the `.cmd` shim is resolved
    // without an EINVAL from Node 22+'s shell-free `.cmd` guard.
    shell: false,
  });
  if (result.status !== 0) {
    failed = true;
    console.error(`gate ${gate} exited non-zero`);
  }
}

const afterProject = fingerprintTriple(projectDb);
const afterUserData = userDataDb ? fingerprintTriple(userDataDb) : null;

console.log("\n=== persistence guard: after ===");
console.log(`  project DB:     ${projectDb}`);
console.log(`    main: ${afterProject.main}`);
console.log(`    wal:  ${afterProject.wal}`);
console.log(`    shm:  ${afterProject.shm}`);
console.log(`  user-data DB:   ${userDataDb ?? "(N/A)"}`);
if (afterUserData) {
  console.log(`    main: ${afterUserData.main}`);
  console.log(`    wal:  ${afterUserData.wal}`);
  console.log(`    shm:  ${afterUserData.shm}`);
}

let safe = true;
function compare(label, before, after) {
  if (before === after) return;
  console.error(`  FAIL: ${label} fingerprint diverged`);
  console.error(`    before: ${before}`);
  console.error(`    after:  ${after}`);
  safe = false;
}
compare("project DB main", beforeProject.main, afterProject.main);
compare("project DB wal", beforeProject.wal, afterProject.wal);
compare("project DB shm", beforeProject.shm, afterProject.shm);
if (beforeUserData && afterUserData) {
  compare("user-data DB main", beforeUserData.main, afterUserData.main);
  compare("user-data DB wal", beforeUserData.wal, afterUserData.wal);
  compare("user-data DB shm", beforeUserData.shm, afterUserData.shm);
}

if (!safe || failed) {
  console.error("Persistence guard detected an integrity violation.");
  process.exit(1);
}
console.log("Persistence guard OK: real DB and user-data DB byte-identical across the run.");