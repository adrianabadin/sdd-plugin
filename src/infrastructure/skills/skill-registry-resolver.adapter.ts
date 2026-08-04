/**
 * C-N1 remediation (part A2) — filesystem-backed skillResolver for
 * `composePhasePrompt` (`ComposePhasePromptOptions.skillResolver`, PC-5/PC-6).
 *
 * Reads `<projectRoot>/.atl/skill-registry.md` fresh on every call and
 * delegates parsing to the pure domain function. Re-reading on every call
 * (rather than caching) trades a per-call fs read for always-fresh
 * resolution without cache-invalidation logic — the registry is a small
 * file, mapped skill names per phase are few (at most two today), and a
 * registry refresh (`gentle-ai skill-registry refresh`) should not require
 * a plugin restart to take effect.
 *
 * Returns null — never throws — both when the skill name is absent from
 * the table AND when the registry file itself cannot be read (missing,
 * unreadable, or malformed). Both cases are genuinely "unresolvable" per
 * PC-6; `composePhasePrompt` is responsible for turning that into
 * `UnresolvableSkillError` rather than fabricating a path.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveSkillPathFromRegistry } from "../../domain/sdd/skill-registry.js";

export function createSkillRegistryResolver(projectRoot: string): (skillName: string) => string | null {
  const registryPath = path.join(projectRoot, ".atl", "skill-registry.md");
  return (skillName: string): string | null => {
    let registryMarkdown: string;
    try {
      registryMarkdown = readFileSync(registryPath, "utf8");
    } catch {
      return null;
    }
    return resolveSkillPathFromRegistry(registryMarkdown, skillName);
  };
}
