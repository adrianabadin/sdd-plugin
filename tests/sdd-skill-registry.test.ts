/**
 * C-N1 remediation (part A2) + C-R1 resolution (Option B) — real
 * skillResolver wiring for `composePhasePrompt`.
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
 * name absent from the table.
 *
 * C-R1 (Option B): the registry is no longer a single gitignored file that
 * only exists on the author's machine. The resolver searches, in order:
 *   1. `<projectRoot>/.atl/skill-registry.md` — machine-local, written by
 *      `gentle-ai skill-registry refresh`; authoritative when present.
 *   2. the committed default `config/sdd/default-skill-registry.md` shipped
 *      with the plugin (overridable in tests via options.defaultRegistryPath).
 * If NO candidate is readable, the resolver throws SkillRegistryUnavailableError
 * naming every searched path and why it failed (missing vs unreadable) —
 * "no registry at all" and "name absent from a readable registry" are
 * distinguishable failures (W-N3). If a registry was read but the name is
 * absent, the resolver returns null so composePhasePrompt raises
 * UnresolvableSkillError (PC-6 stays reachable).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveSkillPathFromRegistry } from "../src/domain/sdd/skill-registry.js";
import {
  createSkillRegistryResolver,
  defaultSkillRegistryPath,
  SkillRegistryUnavailableError,
} from "../src/infrastructure/skills/skill-registry-resolver.adapter.js";

const SAMPLE_REGISTRY_MARKDOWN = `# Skill Registry — sample

## Skills

| Skill | Trigger / description | Scope | Path |
| --- | --- | --- | --- |
| \`work-unit-commits\` | Plan commits as reviewable work units. | user | \`C:\\Users\\aabad\\.config\\opencode\\skills\\work-unit-commits\\SKILL.md\` |
| \`chained-pr\` | Trigger: PRs over 400 lines, stacked PRs. | user | \`C:\\Users\\aabad\\.config\\opencode\\skills\\chained-pr\\SKILL.md\` |

## Loading protocol

1. Match task context against the Trigger / description column.
`;

const DEFAULT_FALLBACK_MARKDOWN = `# Skill Registry — committed default fallback

## Skills

| Skill | Trigger / description | Scope | Path |
| --- | --- | --- | --- |
| \`work-unit-commits\` | Plan commits as reviewable work units. | user | \`D:\\committed-default\\work-unit-commits\\SKILL.md\` |
| \`chained-pr\` | Trigger: PRs over 400 lines, stacked PRs. | user | \`D:\\committed-default\\chained-pr\\SKILL.md\` |
`;

const EMPTY_TABLE_MARKDOWN = `# Skill Registry — empty

## Skills

| Skill | Trigger / description | Scope | Path |
| --- | --- | --- | --- |
`;

async function runTests(): Promise<void> {
  console.log("--- sdd-skill-registry (C-N1 remediation + C-R1 Option B, RED-first) ---");

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

  const tempDir = mkdtempSync(path.join(tmpdir(), "sdd-skill-registry-"));
  try {
    // Infra adapter: reads a real file from disk and resolves through it.
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

    // C-R1 Option B: the committed default fallback is used when the
    // machine-local .atl registry is absent.
    const fallbackPath = path.join(tempDir, "committed-default.md");
    writeFileSync(fallbackPath, DEFAULT_FALLBACK_MARKDOWN, "utf8");
    const fallbackResolver = createSkillRegistryResolver(path.join(tempDir, "without-registry"), {
      defaultRegistryPath: fallbackPath,
    });
    assert.equal(
      fallbackResolver("work-unit-commits"),
      "D:\\committed-default\\work-unit-commits\\SKILL.md",
      "a missing .atl registry falls back to the committed default registry",
    );
    console.log("  pass: missing .atl registry falls back to the committed default");

    const fallbackSearch = fallbackResolver.searchedRegistries();
    assert.equal(fallbackSearch.length, 2, "the search reports both candidates");
    assert.equal(fallbackSearch[0]?.status, "missing", "the .atl candidate is reported missing");
    assert.equal(fallbackSearch[1]?.status, "ok", "the default candidate is reported readable");
    console.log("  pass: searchedRegistries reports missing external + ok default");

    // The machine-local registry wins over the committed default when both exist.
    const externalWinsResolver = createSkillRegistryResolver(path.join(tempDir, "with-registry"), {
      defaultRegistryPath: fallbackPath,
    });
    assert.equal(
      externalWinsResolver("work-unit-commits"),
      "C:\\Users\\aabad\\.config\\opencode\\skills\\work-unit-commits\\SKILL.md",
      "the machine-local .atl registry is authoritative over the committed default",
    );
    console.log("  pass: machine-local .atl registry wins over the committed default");

    // W-N3: no readable registry at all is a distinct, diagnosable failure —
    // it throws, naming every searched path and the reason for each.
    const missingDefault = path.join(tempDir, "no-such-default.md");
    const unavailableResolver = createSkillRegistryResolver(path.join(tempDir, "without-registry"), {
      defaultRegistryPath: missingDefault,
    });
    assert.throws(
      () => unavailableResolver("work-unit-commits"),
      (err: unknown) => {
        assert.ok(err instanceof SkillRegistryUnavailableError, "throws SkillRegistryUnavailableError");
        assert.equal((err as SkillRegistryUnavailableError).code, "SKILL_REGISTRY_UNAVAILABLE");
        assert.match((err as Error).message, /without-registry/, "message names the .atl candidate path");
        assert.match((err as Error).message, /no-such-default\.md/, "message names the default candidate path");
        assert.match((err as Error).message, /missing/, "message reports the missing reason");
        return true;
      },
      "no readable registry throws a diagnosable SkillRegistryUnavailableError",
    );
    console.log("  pass: no readable registry throws with both paths and reasons");

    // W-N3: unreadable and missing are distinguishable to the caller.
    const unreadableRoot = path.join(tempDir, "unreadable-registry", ".atl", "skill-registry.md");
    mkdirSync(unreadableRoot, { recursive: true }); // a directory where the file should be
    const unreadableResolver = createSkillRegistryResolver(path.join(tempDir, "unreadable-registry"), {
      defaultRegistryPath: missingDefault,
    });
    assert.throws(
      () => unreadableResolver("work-unit-commits"),
      (err: unknown) => {
        assert.ok(err instanceof SkillRegistryUnavailableError);
        const search = (err as SkillRegistryUnavailableError).search;
        assert.equal(search[0]?.status, "unreadable", "a non-readable registry file is 'unreadable', not 'missing'");
        assert.equal(search[1]?.status, "missing", "the absent default is still 'missing'");
        return true;
      },
      "unreadable and missing registries are reported distinctly",
    );
    console.log("  pass: unreadable vs missing registry statuses are distinguishable");

    // Name absent from a READABLE registry is still null (PC-6), not a throw —
    // and the diagnostics show the registry itself was fine.
    const emptyRoot = path.join(tempDir, "empty-registry", ".atl");
    mkdirSync(emptyRoot, { recursive: true });
    writeFileSync(path.join(emptyRoot, "skill-registry.md"), EMPTY_TABLE_MARKDOWN, "utf8");
    const emptyResolver = createSkillRegistryResolver(path.join(tempDir, "empty-registry"), {
      defaultRegistryPath: missingDefault,
    });
    assert.equal(
      emptyResolver("work-unit-commits"),
      null,
      "a name absent from a readable registry resolves to null (PC-6), never throws",
    );
    assert.equal(emptyResolver.searchedRegistries()[0]?.status, "ok", "the readable registry is reported ok");
    console.log("  pass: name absent from a readable registry is null with ok diagnostics");

    // Declared, enforced registry contract (C-R1 fix requirement 3): the
    // committed default shipped with the plugin MUST exist and MUST map the
    // mandatory skills of the two phases that have them (sdd-tasks:
    // work-unit-commits + chained-pr; sdd-apply: work-unit-commits).
    const shippedDefault = defaultSkillRegistryPath();
    assert.match(shippedDefault, /config[\\/]sdd[\\/]default-skill-registry\.md$/, "the default lives under config/sdd");
    const shippedMarkdown = readFileSync(shippedDefault, "utf8");
    assert.ok(
      resolveSkillPathFromRegistry(shippedMarkdown, "work-unit-commits") !== null,
      "the committed default registry maps work-unit-commits",
    );
    assert.ok(
      resolveSkillPathFromRegistry(shippedMarkdown, "chained-pr") !== null,
      "the committed default registry maps chained-pr",
    );
    console.log("  pass: the committed default registry exists and maps both mandatory skills");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log("All sdd-skill-registry tests passed.");
}

runTests().catch((err) => { console.error("Test failed:", err); process.exit(1); });
