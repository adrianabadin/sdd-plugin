/**
 * WU7 — PC-1 through PC-9: Prompt composition domain primitives.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-prompt-composition`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§5, §6, §9, §9.1).
 */

export class UnresolvableSkillError extends Error {
  readonly code = "UNRESOLVABLE_SKILL";
  readonly skillName: string;

  constructor(skillName: string) {
    super(`UNRESOLVABLE_SKILL: mapped skill "${skillName}" could not be resolved to a readable path`);
    this.name = "UnresolvableSkillError";
    this.skillName = skillName;
  }
}

export class PromptBudgetExceededError extends Error {
  readonly code = "PROMPT_BUDGET_EXCEEDED";
  readonly artifactName: string;
  readonly artifactSize: number;
  readonly budgetLimit: number;

  constructor(artifactName: string, artifactSize: number, budgetLimit: number) {
    super(
      `PROMPT_BUDGET_EXCEEDED: artifact "${artifactName}" size (${artifactSize} chars) exceeds budget limit (${budgetLimit} chars)`,
    );
    this.name = "PromptBudgetExceededError";
    this.artifactName = artifactName;
    this.artifactSize = artifactSize;
    this.budgetLimit = budgetLimit;
  }
}

/**
 * Shared executor contract (design §5).
 * Prepended to every composed prompt exactly once.
 */
export const SHARED_EXECUTOR_CONTRACT = `You are the executor for this single SDD phase. Do not launch sub-agents, do not call task/delegate. Every SDD artifact you need (spec, design, tasks, prior progress) is already inlined below — do not query the SDD artifact store yourself, under any tool name. pmc_get_context for codebase navigation is available and encouraged where relevant (it's read-only over source structure, not the artifact store — same as the pmc get-context discipline every coding agent in this project already follows).

**Skills to load before work** (listed below by path): these are mandatory for this phase, not suggestions. Read every one of them before you start, and follow them. If a path does not resolve, do not proceed silently — say so in skill_resolution.

You do not save your own artifact: the orchestrator persists it for you via sdd_save_artifact. The single exception is sdd_checkpoint, which you MUST call yourself if this phase's instructions below tell you to — no other persistence tool is ever yours to call.

Your final output must be text, not a tool call, laid out in exactly this order:

1. the fenced SDD_ARTIFACT: block containing your artifact content;
2. then, as the last thing in the message, the Result Contract fields: status, executive_summary, artifacts, next_recommended, risks, skill_resolution.`;

/**
 * Static phase -> skills map (design §9.1).
 * Maps phase name to list of mandatory skill names.
 */
export const STATIC_PHASE_SKILLS_MAP: Record<string, string[]> = {
  "sdd-init": [],
  "sdd-explore": [],
  "sdd-propose": [],
  "sdd-spec": [],
  "sdd-design": [],
  "sdd-tasks": ["work-unit-commits", "chained-pr"],
  "sdd-apply": ["work-unit-commits"],
  "sdd-verify": [],
  "sdd-archive": [],
};

/**
 * Phase prompt templates (design §6).
 */
export const PHASE_PROMPT_TEMPLATES: Record<string, string> = {
  "sdd-init": `Detect stack, conventions, testing capability, and strict-TDD support from the actual project files (never guess). Report what you could detect, and list separately what genuinely could not be inferred — the orchestrator asks the user those (via sdd_init_questions) and persists the merged result; you never ask the user directly and never persist the config yourself. Your artifact is the detected half: stack, testing command, strict-TDD support, conventions. There is no artifactStore question — persistence is always PMC.`,
  "sdd-explore": `Investigate the codebase/idea and compare approaches. No edits. If the request scope spans multiple independent subsystems, say so and recommend decomposition instead of proceeding. Output: findings + open questions, no proposal yet.`,
  "sdd-propose": `Turn the exploration (if any) and the task description into proposal.md: intent, scope, approach, explicit non-goals. Ask the product/business clarifying questions (3–5) if the task description leaves real ambiguity; otherwise proceed.`,
  "sdd-spec": `Write delta requirements/scenarios (ADDED/MODIFIED/REMOVED/RENAMED) strictly within the proposal's scope. Do not invent requirements the proposal didn't imply.`,
  "sdd-design": `Architecture, data flow, concrete file changes, and rationale, answering the proposal directly. Flag any targeted pre-existing-code cleanup the change requires; no unrelated refactors. **Hard Rule:** for every scenario, specify its function signature, inputs/outputs, and error behavior precisely enough that an executor implementing it later — on any model, in any run — needs no additional context beyond this document.`,
  "sdd-tasks": `Break spec + design into an ordered, actionable task list. **Hard Rule:** each task must map to exactly one scenario from spec.md and must be independently RED→GREEN testable in isolation. Never split one scenario across multiple tasks; never bundle multiple independently-testable scenarios into one task. If a scenario is too coarse to implement as a single testable unit, that's a signal to revisit spec granularity, not to invent an ad-hoc task split. End with the Review Workload Forecast lines verbatim:\nDecision needed before apply: Yes|No\nChained PRs recommended: Yes|No\n1000-line budget risk: Low|Medium|High`,
  "sdd-apply": `Implement the next unimplemented scenarios, following spec/design exactly. Decide your own batch scope for this run and declare it via sdd_checkpoint (totalIds) before writing any code; call sdd_checkpoint again (completedId) immediately after each scenario's test goes green — never batch checkpoints up for the end. Follow strict TDD if the project's config says so.\n\nDo not try to edit tasks.md to tick items off: with PMC as the sole store there is no tasks.md on disk, checkbox state is derived from checkpoints.apply.completedIds, and section 5 forbids you calling any persistence tool other than sdd_checkpoint. Your checkpoints are the tick marks.`,
  "sdd-verify": `Independent verification: source inspection plus real test execution, scenario by scenario. Declare your batch via sdd_checkpoint before starting, and checkpoint after each scenario is verified — same discipline as apply. Report CRITICAL / WARNING / SUGGESTION against spec + tasks, not against your own implementation preferences. A contradiction escalates; do not start another fix loop yourself.`,
  "sdd-archive": `Produce the archive report: the change's delta spec reconciled into a consolidated statement of the capability's current behavior, plus a closing summary. Requires verify-report clean (no unresolved CRITICAL) and no unchecked tasks — no override.\n\nNote this phase authors, it does not write: with PMC as the only store there is no openspec/specs/ tree to edit, so "merging into the main spec record" means emitting the consolidated spec as this phase's artifact, which the orchestrator persists at sdd/{projectRootHash}/specs/{capability} via sdd_save_artifact. The phase never needs to touch the filesystem to do its job — so it is one of the non-mutating phases whose worktree fingerprint must not change.`,
};

/**
 * Complete grammar string for subagentType (PC-3).
 * `model-route:v1|sdd-mr-base|<modelReference>`
 */
export function buildSubagentType(modelReference: string): string {
  return `model-route:v1|sdd-mr-base|${modelReference}`;
}
