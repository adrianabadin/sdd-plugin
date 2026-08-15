/**
 * WU7 — PC-1 through PC-9: Prompt composition application layer.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-prompt-composition`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§5, §6, §9, §9.1).
 */

import {
  buildSubagentType,
  PHASE_PROMPT_TEMPLATES,
  PromptBudgetExceededError,
  SHARED_EXECUTOR_CONTRACT,
  STATIC_PHASE_SKILLS_MAP,
  UnresolvableSkillError,
} from "../../domain/sdd/prompt-composition.js";
import type { SkillResolutionAttempt } from "../../domain/sdd/skill-resolution.js";
import { isPhaseMutating } from "../../domain/sdd/worktree-fingerprint.js";
import { acquireDispatchLock } from "./dispatch-lock.js";

export interface ComposePhasePromptOptions {
  readonly phase: string;
  readonly modelReference: string;
  readonly upstreamArtifacts?: Record<string, string>;
  readonly projectConfig?: {
    readonly testingSkill?: string | null;
    readonly [key: string]: unknown;
  } | null;
  /**
   * Resolves a mapped skill name to a readable absolute path, or null (PC-6).
   * `attempts` is optional so plain function resolvers stay valid; when the
   * injected resolver provides it, the failure the caller sees names every
   * source that was consulted instead of just the skill name.
   */
  readonly skillResolver?: ((skillName: string) => string | null) & {
    readonly attempts?: (skillName: string) => readonly SkillResolutionAttempt[];
  };
  readonly budgetLimitChars?: number;
  readonly currentInFlightPhase?: string | null;
}

/**
 * PC-6 default: resolves nothing, so a caller that injects no resolver fails
 * loudly on any mapped skill. Typed as the option itself (rather than left as
 * an inline `() => null`) so the resolver stays a single type at the use site.
 */
const NO_SKILL_RESOLVER: NonNullable<ComposePhasePromptOptions["skillResolver"]> = () => null;

export interface ComposePhasePromptResult {
  readonly subagentType: string;
  readonly prompt: string;
  readonly inFlightPhase: string;
  readonly mutating: boolean;
}

export function composePhasePrompt(options: ComposePhasePromptOptions): ComposePhasePromptResult {
  const {
    phase,
    modelReference,
    upstreamArtifacts = {},
    projectConfig = null,
    // PC-6: the default resolver returns null so that a caller that does NOT
    // inject a real resolver hits `UnresolvableSkillError` for any mapped
    // skill. The earlier default fabricated `/skills/${name}`, which made the
    // throw branch unreachable in production — a missing skill silently
    // produced a bogus path baked into the prompt instead of failing loud.
    skillResolver = NO_SKILL_RESOLVER,
    budgetLimitChars = 100_000,
    currentInFlightPhase = null,
  } = options;

  // 1. Acquire dispatch lock (DL-1..DL-3)
  const inFlightPhase = acquireDispatchLock(currentInFlightPhase, phase);

  // 2. PC-3: Complete grammar string
  const subagentType = buildSubagentType(modelReference);

  // 3. PC-2: Budget check on upstream artifacts
  for (const [artName, content] of Object.entries(upstreamArtifacts)) {
    if (content.length > budgetLimitChars) {
      throw new PromptBudgetExceededError(artName, content.length, budgetLimitChars);
    }
  }

  const totalArtifactsSize = Object.values(upstreamArtifacts).reduce((sum, c) => sum + c.length, 0);
  if (totalArtifactsSize > budgetLimitChars) {
    const largest = Object.entries(upstreamArtifacts).reduce(
      (max, curr) => (curr[1].length > max[1].length ? curr : max),
      ["combined", ""],
    );
    throw new PromptBudgetExceededError(largest[0], largest[1].length, budgetLimitChars);
  }

  // 4. Mapped skills resolution (PC-5, PC-6, PC-7, PC-8)
  const staticSkills = STATIC_PHASE_SKILLS_MAP[phase] ?? [];
  const skillNames: string[] = [...staticSkills];

  if ((phase === "sdd-apply" || phase === "sdd-verify") && projectConfig?.testingSkill != null) {
    skillNames.push(projectConfig.testingSkill);
  }

  const resolvedSkills: string[] = [];
  for (const skillName of skillNames) {
    if (!skillName) continue;
    const resolved = skillResolver(skillName);
    if (!resolved) {
      // Carry the resolver's own diagnosis so the failure names which sources
      // were consulted and why each one did not produce a readable path.
      throw new UnresolvableSkillError(skillName, skillResolver.attempts?.(skillName) ?? []);
    }
    resolvedSkills.push(resolved);
  }

  // 5. Construct Prompt Body
  // PC-9: Shared executor contract appears exactly once, ahead of phase content and inlined artifacts
  const parts: string[] = [SHARED_EXECUTOR_CONTRACT];

  // PC-5 / PC-7: Mandatory skills heading if non-empty
  if (resolvedSkills.length > 0) {
    parts.push(`## Skills to load before work\n` + resolvedSkills.map((path) => `- ${path}`).join("\n"));
  }

  // Phase specific template
  const template = PHASE_PROMPT_TEMPLATES[phase];
  if (template) {
    parts.push(`## Phase Instructions\n${template}`);
  }

  // PC-1: Upstream artifacts inlined in full
  const artifactEntries = Object.entries(upstreamArtifacts);
  if (artifactEntries.length > 0) {
    const artifactsSection =
      `## Upstream Artifacts\n\n` +
      artifactEntries.map(([name, content]) => `### Artifact: ${name}\n${content}`).join("\n\n");
    parts.push(artifactsSection);
  }

  // Join parts with double newline
  const prompt = parts.join("\n\n");

  // PC-4: Prompt body carries no model trigger phrase (model reference travels only in subagentType)

  return {
    subagentType,
    prompt,
    inFlightPhase,
    mutating: isPhaseMutating(phase),
  };
}
