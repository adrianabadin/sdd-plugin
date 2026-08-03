/**
 * WU1 — PI-1..PI-4: project-root canonicalization (RED-first).
 * See docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md
 * capability `sdd-project-identity`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalizeProjectRoot } from "../src/domain/sdd/project-identity.js";
import { registerProjectRoot, readProjectRecord } from "../src/application/sdd/project-record.js";
import type { CheckpointRecord, CheckpointWriteResult, SddArtifactStorePort } from "../src/ports/sdd-artifact-store.port.js";

/** In-memory fake store — PI-4 targets the write/read-back behavior itself. */
class FakeStore implements SddArtifactStorePort {
  private artifacts = new Map<string, string>();
  async writeArtifact(key: string, content: string): Promise<void> {
    this.artifacts.set(key, content);
  }
  async readArtifact(key: string): Promise<string | null> {
    return this.artifacts.get(key) ?? null;
  }
  async writeCheckpoint(_key: string, _content: unknown): Promise<CheckpointWriteResult> {
    return { version: 1 };
  }
  async readCheckpoint(_key: string): Promise<CheckpointRecord | null> {
    return null;
  }
}

async function runTests(): Promise<void> {
  console.log("--- sdd-project-identity (RED-first) ---");

  // PI-1: a relative path is canonicalized to an absolute realpath.
  {
    const base = mkdtempSync(path.join(tmpdir(), "sdd-pi1-"));
    const target = path.join(base, "project");
    mkdirSync(target);
    const cwdBefore = process.cwd();
    process.chdir(base);
    try {
      const relative = "project";
      const result = canonicalizeProjectRoot(relative);
      assert.ok(path.isAbsolute(result.canonicalPath), "canonicalPath is absolute");
      assert.equal(result.canonicalPath.toLowerCase(), target.toLowerCase(), "resolves to the real target dir");
    } finally {
      process.chdir(cwdBefore);
    }
    console.log("  pass: PI-1 relative path canonicalizes to absolute realpath");
  }

  // PI-2: Windows path variants (8.3 short name, drive case, mixed case)
  // collapse to one identical projectRootHash.
  if (process.platform === "win32") {
    const base = mkdtempSync(path.join(tmpdir(), "sdd-pi2-"));
    const target = path.join(base, "ProjectDir");
    mkdirSync(target);

    const longNameHash = canonicalizeProjectRoot(target).projectRootHash;

    // Uppercase / lowercase drive letter variants.
    const drive = target.slice(0, 1);
    const upperDrive = drive.toUpperCase() + target.slice(1);
    const lowerDrive = drive.toLowerCase() + target.slice(1);
    assert.equal(canonicalizeProjectRoot(upperDrive).projectRootHash, longNameHash, "uppercase drive letter collapses");
    assert.equal(canonicalizeProjectRoot(lowerDrive).projectRootHash, longNameHash, "lowercase drive letter collapses");

    // Mixed case of the directory name itself.
    const mixedCase = path.join(base, "pRoJeCtDiR");
    assert.equal(canonicalizeProjectRoot(mixedCase).projectRootHash, longNameHash, "mixed-case dirname collapses");

    // 8.3 short name, obtained via `cmd /c for %I in ("path") do @echo %~sI`.
    let shortName: string | null = null;
    try {
      const rawOutput = execFileSync(
        "cmd.exe",
        ["/c", `for %I in (${target}) do @echo %~sI`],
        { encoding: "utf8" },
      ).trim();
      const output = rawOutput.replace(/^"(.*)"$/, "$1");
      if (output && output.toLowerCase() !== target.toLowerCase()) {
        shortName = output;
      }
    } catch {
      shortName = null;
    }
    if (shortName !== null) {
      assert.equal(canonicalizeProjectRoot(shortName).projectRootHash, longNameHash, "8.3 short name collapses");
      console.log("  pass: PI-2 Windows path variants (incl. 8.3 short name) collapse to one hash");
    } else {
      console.log("  pass: PI-2 Windows path variants (drive case, mixed case) collapse to one hash (8.3 short name unavailable on this fs)");
    }
  } else {
    console.log("  skip: PI-2 is Windows-specific and this platform is not win32");
  }

  // PI-3: a symlinked project root hashes to its target, not the link.
  {
    const base = mkdtempSync(path.join(tmpdir(), "sdd-pi3-"));
    const target = path.join(base, "real-target");
    mkdirSync(target);
    const link = path.join(base, "link-to-target");
    let symlinkAvailable = true;
    try {
      symlinkSync(target, link, "junction");
    } catch {
      symlinkAvailable = false;
    }
    if (symlinkAvailable) {
      const targetIdentity = canonicalizeProjectRoot(target);
      const linkIdentity = canonicalizeProjectRoot(link);
      assert.equal(linkIdentity.projectRootHash, targetIdentity.projectRootHash, "symlink hashes to target's hash");
      assert.equal(linkIdentity.canonicalPath.toLowerCase(), targetIdentity.canonicalPath.toLowerCase(), "symlink canonicalPath is the target, not the link");
      console.log("  pass: PI-3 symlinked project root hashes to its target");
    } else {
      console.log("  skip: PI-3 symlink/junction creation unavailable in this environment");
    }
  }

  // PI-4 (shape): canonicalizeProjectRoot's own output carries both fields.
  {
    const base = mkdtempSync(path.join(tmpdir(), "sdd-pi4-"));
    const result = canonicalizeProjectRoot(base);
    assert.equal(typeof result.canonicalPath, "string", "canonicalPath is present as readable text");
    assert.ok(result.canonicalPath.length > 0, "canonicalPath is non-empty");
    assert.equal(typeof result.projectRootHash, "string", "projectRootHash is present");
    assert.match(result.projectRootHash, /^[0-9a-f]{64}$/, "projectRootHash is a sha256 hex digest");
    console.log("  pass: PI-4 (shape) canonicalizeProjectRoot's own output carries both fields");
  }

  // PI-4 (round trip): a record written under hash(canonicalPath) is
  // findable after "the project moves" — reading it back by hash alone
  // still yields the readable canonical path, not just the hash.
  {
    const base = mkdtempSync(path.join(tmpdir(), "sdd-pi4-roundtrip-"));
    const canonical = canonicalizeProjectRoot(base);
    const store = new FakeStore();

    // Nothing was ever written for this hash yet.
    const before = await readProjectRecord(store, canonical.projectRootHash);
    assert.equal(before, null, "PI-4 round trip precondition: no record exists yet for this hash");

    await registerProjectRoot(store, canonical);
    // Simulate "the project moves": look the record up by hash ALONE, the
    // way a caller who only has `sdd/{hash}/...` keys and no live
    // `projectRoot` on disk anymore would.
    const after = await readProjectRecord(store, canonical.projectRootHash);

    assert.ok(after !== null, "PI-4 round trip: a record is found by hash after write");
    assert.equal(
      after?.canonicalPath,
      canonical.canonicalPath,
      "PI-4 round trip: the record read back by hash also contains the canonical path as readable text",
    );
    assert.equal(after?.projectRootHash, canonical.projectRootHash, "PI-4 round trip: the hash itself round-trips too");
    console.log("  pass: PI-4 (round trip) a record written under hash(canonicalPath) is findable by hash and carries the readable path back");
  }

  console.log("All sdd-project-identity tests passed.");
}

runTests().catch((err) => { console.error("Test failed:", err); process.exit(1); });
