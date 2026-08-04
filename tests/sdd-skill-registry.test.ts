/**
 * C-N1 remediation (part A2) — real skillResolver wiring for
 * `composePhasePrompt`.
 *
 * Design §5.1 (docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md,
 * lines 417-418): mapped skill names are "resolved to absolute paths against
 * the project's skill registry at compose time." Neither the design nor the
 * SPEC pins down the registry's file location or exact table format — the
 * NARROWEST reading that satisfies PC-6 (an unresolvable mapped skill fails
 * composition, see docs/superpowers/specs/2026-08-02-sdd-phase-agents-TASKS.md:177)
 * is implemented here: parse the `.atl/skill-registry.md` markdown table
 * convention this repository actually uses (see the registry's own "Loading
 * protocol" section), and return null — never fabricate a path — for any
 * name absent from the table, including when the whole file is missing.
 * This keeps `UnresolvableSkillError` reachable, which is the whole point
 * of PC-6.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveSkillPathFromRegistry } from "../src/domain/sdd/skill-registry.js";
import { createSkillRegistryResolver } from "../src/infrastructure/skills/skill-registry-resolver.adapter.js";

const SAMPLE_REGISTRY_MARKDOWN = `# Skill Registry — sample

## Skills

| Skill | Trigger / description | Scope | Path |
| --- | --- | --- | --- |
| \`work-unit-commits\` | Plan commits as reviewable work units. | user | \`C:\\Users\\aabad\\.config\\opencode\\skills\\work-unit-commits\\SKILL.md\` |
| \`chained-pr\` | Trigger: PRs over 400 lines, stacked PRs. | user | \`C:\\Users\\aabad\\.config\\opencode\\skills\\chained-pr\\SKILL.md\` |

## Loading protocol

1. Match task context against the Trigger / description column.
`;

async function runTests(): Promise<void> {
  console.log("--- sdd-skill-registry (C-N1 remediation, RED-first) ---");

  // Pure parser: resolves a known skill name to its Path cell.
  assert.equal(
    resolveSkillPathFromRegistry(SAMPLE_REGISTRY_MARKDOWN, "work-unit-commits"),
    "C:\\Users\\aabad\\.config\\opencode\\skills\\work-unit-commits\\SKILL.md",
    "resolves a mapped skill name to its registry Path cell",
  );
  console.log("  pass: resolves a known skill name from the registry table");

  assert.equal(
    resolveSkillPathFromRegistry(SAMPLE_REGISTRY_MARKDOWN, "chained-pr"),
    "C:\\Users\\aabad\\.config\\opencode\\skills\\chained-pr\\SKILL.md",
    "resolves the second mapped skill name",
  );
  console.log("  pass: resolves a second known skill name from the registry table");

  // PC-6 stays reachable: an unknown skill name resolves to null, never a
  // fabricated path.
  assert.equal(
    resolveSkillPathFromRegistry(SAMPLE_REGISTRY_MARKDOWN, "does-not-exist"),
    null,
    "an unmapped skill name resolves to null, not a guessed path",
  );
  console.log("  pass: an unmapped skill name resolves to null (PC-6 stays reachable)");

  // The header row and separator row must never be mistaken for skill rows.
  assert.equal(
    resolveSkillPathFromRegistry(SAMPLE_REGISTRY_MARKDOWN, "Skill"),
    null,
    "the header row's 'Skill' cell is never treated as a skill name",
  );
  console.log("  pass: the table header/separator rows are not misparsed as skill entries");

  // Infra adapter: reads a real file from disk and resolves through it.
  const tempDir = mkdtempSync(path.join(tmpdir(), "sdd-skill-registry-"));
  try {
    const registryDir = path.join(tempDir, "with-registry", ".atl");
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(path.join(registryDir, "skill-registry.md"), SAMPLE_REGISTRY_MARKDOWN, "utf8");

    const resolverWithRegistry = createSkillRegistryResolver(path.join(tempDir, "with-registry"));
    assert.equal(
      resolverWithRegistry("work-unit-commits"),
      "C:\\Users\\aabad\\.config\\opencode\\skills\\work-unit-commits\\SKILL.md",
      "the fs-backed resolver reads the real registry file and resolves a known name",
    );
    console.log("  pass: fs-backed resolver reads a real .atl/skill-registry.md and resolves a known name");

    assert.equal(
      resolverWithRegistry("does-not-exist"),
      null,
      "the fs-backed resolver returns null for an unmapped name",
    );
    console.log("  pass: fs-backed resolver returns null for an unmapped name");

    // No registry file at all (this worktree's actual state): every skill
    // name resolves to null rather than throwing or fabricating a path —
    // composePhasePrompt turns that into UnresolvableSkillError, which is
    // the correct fail-closed behavior for a worktree with no registry.
    const resolverWithoutRegistry = createSkillRegistryResolver(path.join(tempDir, "without-registry"));
    assert.equal(
      resolverWithoutRegistry("work-unit-commits"),
      null,
      "a missing registry file resolves every skill name to null, never throws",
    );
    console.log("  pass: a missing registry file resolves to null instead of throwing");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log("All sdd-skill-registry tests passed.");
}

runTests().catch((err) => { console.error("Test failed:", err); process.exit(1); });
