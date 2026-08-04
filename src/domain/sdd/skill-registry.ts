/**
 * C-N1 remediation (part A2) — pure parser for the project's skill-registry
 * markdown table.
 *
 * Design §5.1 (docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md,
 * lines 417-418): mapped skill names are "resolved to absolute paths against
 * the project's skill registry at compose time." Neither the design nor the
 * SPEC pins down the registry's file location or exact table format —
 * ambiguity flagged, not silently resolved. This parser implements the
 * NARROWEST reading that satisfies PC-6 (docs/superpowers/specs/2026-08-02-sdd-phase-agents-TASKS.md:177,
 * "an unresolvable mapped skill fails composition"): it reads the markdown
 * table shape this repository's own `.atl/skill-registry.md` actually uses
 * (documented by that file's own "Loading protocol" section):
 *
 *   | Skill | Trigger / description | Scope | Path |
 *   | --- | --- | --- | --- |
 *   | `skill-name` | description text | user\|project | `C:\absolute\path\SKILL.md` |
 *
 * Only the first cell (backtick-quoted skill name) and the last cell
 * (backtick-quoted path) are used; description and scope are ignored here.
 * Returns null — never a fabricated path — for any name not present as a
 * table row, which is what keeps `UnresolvableSkillError` reachable in
 * `composePhasePrompt` (the defect the prior default resolver had:
 * `src/application/sdd/prompt-composition.ts` PC-6 comment).
 */
export function resolveSkillPathFromRegistry(registryMarkdown: string, skillName: string): string | null {
  for (const line of registryMarkdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const nameCell = cells[0] ?? "";
    const pathCell = cells[cells.length - 1] ?? "";
    const nameMatch = /^`([^`]+)`$/.exec(nameCell);
    const pathMatch = /^`([^`]+)`$/.exec(pathCell);
    if (!nameMatch || !pathMatch) continue;
    if (nameMatch[1] === skillName) return pathMatch[1] ?? null;
  }
  return null;
}
