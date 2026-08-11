/**
 * C-N1 remediation (part A2) + C-R1 resolution (Option B) — filesystem-backed
 * skillResolver for `composePhasePrompt` (`ComposePhasePromptOptions.skillResolver`,
 * PC-5/PC-6).
 *
 * Registry provenance (C-R1): the registry is searched in order —
 *   1. `<projectRoot>/.atl/skill-registry.md` — machine-local, written by the
 *      external `gentle-ai skill-registry refresh` binary; authoritative when
 *      present (that binary overwrites this file, never the committed one).
 *   2. `config/sdd/default-skill-registry.md` — the committed default shipped
 *      with the plugin, so a fresh clone / CI runner / any machine without
 *      gentle-ai still has a declared registry contract. Located relative to
 *      this module so it resolves identically from `src/` (tsx) and `dist/`.
 *
 * The file is read fresh on every call (rather than cached): the registry is
 * small, mapped skill names per phase are few (at most two today), and a
 * registry refresh should not require a plugin restart to take effect.
 *
 * Failure semantics (W-N3 — the three cases are distinguishable):
 *   - NO candidate readable -> throws SkillRegistryUnavailableError naming
 *     every searched path and per-path reason ("missing" vs "unreadable").
 *   - A registry was read but the name is absent -> returns null, and
 *     `composePhasePrompt` turns that into `UnresolvableSkillError` (PC-6).
 *   - Never returns a fabricated path.
 * The returned resolver also exposes `searchedRegistries()` so the tool
 * boundary can fold the search diagnostics into the UnresolvableSkillError
 * the caller sees.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSkillPathFromRegistry } from "../../domain/sdd/skill-registry.js";

export interface SkillRegistrySearchEntry {
  readonly path: string;
  readonly status: "ok" | "missing" | "unreadable";
  readonly error?: string;
}

export class SkillRegistryUnavailableError extends Error {
  readonly code = "SKILL_REGISTRY_UNAVAILABLE";
  readonly search: readonly SkillRegistrySearchEntry[];

  constructor(search: readonly SkillRegistrySearchEntry[]) {
    super(
      `SKILL_REGISTRY_UNAVAILABLE: no readable skill registry. Searched: ${search
        .map((entry) => `${entry.path} (${entry.status}${entry.error !== undefined ? `: ${entry.error}` : ""})`)
        .join("; ")}`,
    );
    this.name = "SkillRegistryUnavailableError";
    this.search = search;
  }
}

export type SkillResolver = ((skillName: string) => string | null) & {
  readonly searchedRegistries: () => readonly SkillRegistrySearchEntry[];
};

export interface SkillRegistryResolverOptions {
  /** Overrides the committed-default candidate; exists for tests. */
  readonly defaultRegistryPath?: string;
}

/**
 * Absolute path of the committed default registry. Three levels up from this
 * module lands on the repo/plugin root from both `src/infrastructure/skills/`
 * and `dist/infrastructure/skills/`.
 */
export function defaultSkillRegistryPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "../../../config/sdd/default-skill-registry.md");
}

export function createSkillRegistryResolver(
  projectRoot: string,
  options?: SkillRegistryResolverOptions,
): SkillResolver {
  const candidates = [
    path.join(projectRoot, ".atl", "skill-registry.md"),
    options?.defaultRegistryPath ?? defaultSkillRegistryPath(),
  ];
  let lastSearch: readonly SkillRegistrySearchEntry[] = [];
  return Object.assign(
    (skillName: string): string | null => {
      const search: SkillRegistrySearchEntry[] = [];
      for (const candidate of candidates) {
        let registryMarkdown: string;
        try {
          registryMarkdown = readFileSync(candidate, "utf8");
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          search.push({
            path: candidate,
            status: code === "ENOENT" ? "missing" : "unreadable",
            ...(code !== undefined ? { error: code } : {}),
          });
          continue;
        }
        search.push({ path: candidate, status: "ok" });
        lastSearch = search;
        return resolveSkillPathFromRegistry(registryMarkdown, skillName);
      }
      lastSearch = search;
      throw new SkillRegistryUnavailableError(search);
    },
    { searchedRegistries: () => lastSearch },
  );
}
