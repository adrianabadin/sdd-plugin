/**
 * Skill resolution contract — `createConfiguredSkillResolver` (design scenario 3).
 *
 * The previous incarnation of this file tested a markdown-table registry parser
 * (`.atl/skill-registry.md` + a committed default). That design made resolution
 * depend on a file format nobody declares and on a machine-local, gitignored
 * artifact. It is replaced here by DECLARED SOURCES: an in-process `injected`
 * map and a `configured` map lifted out of the project config under `configKey`.
 *
 * The contract this file pins down is the FAILURE DIAGNOSIS, because that is
 * what an operator actually needs when a compose call dies:
 *   - `name-absent`  — the source never mapped this skill name at all.
 *   - `missing`      — the source mapped it, but nothing exists at that path (ENOENT).
 *   - `unreadable`   — the source mapped it, but the path is not a readable file
 *                      (a directory, a relative path, an access failure).
 * `path` is present exactly when a source mapped the name, and absent otherwise —
 * so "we never had a path" and "we had a path and it was bad" are never conflated.
 *
 * Precedence: `injected` wins. If the injected entry EXISTS but fails validation
 * that is a hard stop — `configured` is not consulted — because a caller that
 * deliberately injected a path is stating intent, and silently falling through to
 * a different file would resolve the prompt against a skill the caller did not ask
 * for.
 *
 * Windows note: the "unreadable" conditions here are built portably (a directory
 * where a file is expected, and a relative path). No chmod/permission assumptions.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { UnresolvableSkillError } from "../src/domain/sdd/prompt-composition.js";
import type { SkillResolutionAttempt } from "../src/domain/sdd/skill-resolution.js";
import { createConfiguredSkillResolver } from "../src/infrastructure/skills/configured-skill-resolver.adapter.js";

const SKILL = "work-unit-commits";
const CONFIG_KEY = "skillPaths";

async function runTests(): Promise<void> {
  console.log("--- sdd-skill-resolution (design scenario 3, RED-first) ---");

  const tempDir = mkdtempSync(path.join(tmpdir(), "sdd-skill-resolution-"));
  const projectRoot = path.join(tempDir, "project");
  mkdirSync(projectRoot, { recursive: true });

  const realSkillPath = path.join(tempDir, "real-skill", "SKILL.md");
  mkdirSync(path.dirname(realSkillPath), { recursive: true });
  writeFileSync(realSkillPath, "# a real skill file\n", "utf8");

  try {
    // ---------------------------------------------------------------- test 1
    // Name absent from BOTH declared sources: every source is reported, each
    // with its own lookup key, and `path` is omitted (there never was one).
    {
      const resolver = createConfiguredSkillResolver({
        projectRoot,
        injected: {},
        configured: {},
        configKey: CONFIG_KEY,
      });

      assert.equal(resolver(SKILL), null, "an unmapped name resolves to null, never a fabricated path");

      const attempts = resolver.attempts(SKILL);
      assert.equal(attempts.length, 2, "both declared sources are reported");
      assert.deepEqual(
        attempts[0],
        { source: "injected", lookupKey: SKILL, reason: "name-absent" },
        "the injected attempt names its source and lookup key, and omits `path`",
      );
      assert.deepEqual(
        attempts[1],
        { source: "configured", lookupKey: `${CONFIG_KEY}.${SKILL}`, reason: "name-absent" },
        "the configured attempt's lookup key is qualified by the config key, and omits `path`",
      );
      console.log("  pass: name absent from both sources -> two `name-absent` attempts, no `path`");
    }

    // ---------------------------------------------------------------- test 2
    // Mapped, but nothing is there (ENOENT) -> `missing`, carrying the path.
    {
      const missingPath = path.join(tempDir, "no-such-dir", "SKILL.md");
      const resolver = createConfiguredSkillResolver({
        projectRoot,
        injected: {},
        configured: { [SKILL]: missingPath },
        configKey: CONFIG_KEY,
      });

      assert.equal(resolver(SKILL), null, "a mapped-but-absent file resolves to null");

      const attempts = resolver.attempts(SKILL);
      assert.equal(attempts.length, 2, "the absent injected source is still reported before the failure");
      assert.equal(attempts[0]?.reason, "name-absent", "injected had no entry");
      assert.equal(attempts[1]?.source, "configured");
      assert.equal(attempts[1]?.lookupKey, `${CONFIG_KEY}.${SKILL}`);
      assert.equal(attempts[1]?.reason, "missing", "ENOENT is `missing`, not `unreadable`");
      assert.equal(attempts[1]?.path, missingPath, "the failing attempt carries the exact mapped path");
      console.log("  pass: mapped path with ENOENT -> `missing` + exact path");
    }

    // ---------------------------------------------------------------- test 3
    // Mapped to something that is not a readable file -> `unreadable`, carrying
    // the path AND a populated detail. Also pins the injected-wins hard stop.
    {
      const directoryPath = path.join(tempDir, "a-directory");
      mkdirSync(directoryPath, { recursive: true });

      // Control: with injected absent, this configured entry DOES resolve — so
      // the short-circuit asserted below is a real short-circuit, not a resolver
      // that simply never resolves anything.
      const controlResolver = createConfiguredSkillResolver({
        projectRoot,
        injected: {},
        configured: { [SKILL]: realSkillPath },
        configKey: CONFIG_KEY,
      });
      assert.equal(controlResolver(SKILL), realSkillPath, "a valid configured entry resolves to its absolute path");

      const resolver = createConfiguredSkillResolver({
        projectRoot,
        injected: { [SKILL]: directoryPath },
        configured: { [SKILL]: realSkillPath },
        configKey: CONFIG_KEY,
      });

      assert.equal(
        resolver(SKILL),
        null,
        "an injected entry that fails validation is a hard stop — `configured` is never consulted",
      );

      const attempts = resolver.attempts(SKILL);
      assert.equal(attempts.length, 1, "resolution stopped at the failing injected source");
      assert.equal(attempts[0]?.source, "injected");
      assert.equal(attempts[0]?.lookupKey, SKILL);
      assert.equal(attempts[0]?.reason, "unreadable", "a directory where a file was expected is `unreadable`");
      assert.equal(attempts[0]?.path, directoryPath, "the failing attempt carries the exact mapped path");
      assert.ok((attempts[0]?.detail ?? "").length > 0, "`unreadable` populates `detail` with why it failed");

      // A relative path is likewise `unreadable`: resolution is never performed
      // relative to the project root.
      const relativeResolver = createConfiguredSkillResolver({
        projectRoot,
        injected: {},
        configured: { [SKILL]: path.join("relative", "SKILL.md") },
        configKey: CONFIG_KEY,
      });
      assert.equal(relativeResolver(SKILL), null, "a relative mapped path resolves to null");
      const relativeAttempts = relativeResolver.attempts(SKILL);
      assert.equal(relativeAttempts[1]?.reason, "unreadable", "a relative path is `unreadable`, not `missing`");
      assert.ok((relativeAttempts[1]?.detail ?? "").length > 0, "the relative-path failure explains itself");
      console.log("  pass: directory / relative path -> `unreadable` + exact path + detail (injected short-circuits)");
    }

    // ---------------------------------------------------------------- test 4
    // The error a caller actually reads must name EVERY source, its lookup key,
    // the path when present, and the reason.
    {
      const mappedPath = path.join(tempDir, "no-such-dir", "SKILL.md");
      const attempts: readonly SkillResolutionAttempt[] = [
        { source: "injected", lookupKey: SKILL, reason: "name-absent" },
        {
          source: "configured",
          lookupKey: `${CONFIG_KEY}.${SKILL}`,
          path: mappedPath,
          reason: "missing",
          detail: "ENOENT",
        },
      ];
      const error = new UnresolvableSkillError(SKILL, attempts);

      assert.equal(error.code, "UNRESOLVABLE_SKILL");
      assert.equal(error.skillName, SKILL);
      assert.deepEqual(error.attempts, attempts, "the error carries the attempts for programmatic inspection");

      const { message } = error;
      assert.ok(message.includes(SKILL), "the message names the skill");
      assert.ok(message.includes("injected"), "the message names the injected source");
      assert.ok(message.includes("configured"), "the message names the configured source");
      assert.ok(message.includes(`${CONFIG_KEY}.${SKILL}`), "the message carries the configured lookup key");
      assert.ok(message.includes(mappedPath), "the message carries the path of the source that had one");
      assert.ok(message.includes("name-absent"), "the message carries the name-absent reason");
      assert.ok(message.includes("missing"), "the message carries the missing reason");
      console.log("  pass: UnresolvableSkillError names every source, lookup key, path and reason");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log("All sdd-skill-resolution tests passed.");
}

runTests().catch((err) => { console.error("Test failed:", err); process.exit(1); });
