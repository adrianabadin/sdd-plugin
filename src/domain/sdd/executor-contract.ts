/**
 * WU11 — PE-1 through PE-16: Executor contract and Gatekeeper domain logic.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-phase-execution`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§1, §5, §6, §9).
 */

import { buildSubagentType } from "./prompt-composition.js";

export class InvalidSkillResolutionError extends Error {
  readonly code = "INVALID_SKILL_RESOLUTION";
  readonly value: string;

  constructor(value: string) {
    super(`INVALID_SKILL_RESOLUTION: skill_resolution must be "paths-injected" or "not-read", got "${value}"`);
    this.name = "InvalidSkillResolutionError";
    this.value = value;
  }
}

export class InvalidExecutorOutputError extends Error {
  readonly code = "INVALID_EXECUTOR_OUTPUT";

  constructor(reason: string) {
    super(`INVALID_EXECUTOR_OUTPUT: ${reason}`);
    this.name = "InvalidExecutorOutputError";
  }
}

export class ExecutorPersistenceViolationError extends Error {
  readonly code = "EXECUTOR_PERSISTENCE_VIOLATION";
  readonly toolName: string;

  constructor(toolName: string) {
    super(`EXECUTOR_PERSISTENCE_VIOLATION: executor is forbidden from calling persistence tool "${toolName}" (only sdd_checkpoint allowed)`);
    this.name = "ExecutorPersistenceViolationError";
    this.toolName = toolName;
  }
}

export class ArtifactStoreQueryViolationError extends Error {
  readonly code = "ARTIFACT_STORE_QUERY_VIOLATION";
  readonly toolName: string;

  constructor(toolName: string) {
    super(`ARTIFACT_STORE_QUERY_VIOLATION: executor is forbidden from querying SDD artifact store tool "${toolName}"`);
    this.name = "ArtifactStoreQueryViolationError";
    this.toolName = toolName;
  }
}

export class InteractiveToolViolationError extends Error {
  readonly code = "INTERACTIVE_TOOL_VIOLATION";
  readonly toolName: string;

  constructor(toolName: string) {
    super(`INTERACTIVE_TOOL_VIOLATION: executor is forbidden from calling interactive tool "${toolName}"`);
    this.name = "InteractiveToolViolationError";
    this.toolName = toolName;
  }
}

export class InvalidBlockedOnStateError extends Error {
  readonly code = "INVALID_BLOCKED_ON_STATE";

  constructor(reason: string) {
    super(`INVALID_BLOCKED_ON_STATE: ${reason}`);
    this.name = "InvalidBlockedOnStateError";
  }
}

export type SkillResolutionValue = "paths-injected" | "not-read";

export function validateSkillResolution(value: string): SkillResolutionValue {
  if (value === "paths-injected" || value === "not-read") {
    return value;
  }
  throw new InvalidSkillResolutionError(value);
}

export function extractSddArtifact(output: string): string | null {
  const match = output.match(/```SDD_ARTIFACT(?::[^\n]*)?\n([\s\S]*?)```/);
  return match ? match[1]! : null;
}

export interface ParsedExecutorOutput {
  readonly valid: boolean;
  readonly status: string;
  readonly executiveSummary: string;
  readonly artifacts: string;
  readonly nextRecommended: string;
  readonly risks: string;
  readonly skillResolution: SkillResolutionValue;
  readonly artifactContent: string | null;
}

export function parseExecutorFinalOutput(output: string): ParsedExecutorOutput {
  if (typeof output !== "string") {
    throw new InvalidExecutorOutputError("Output must be a string");
  }

  const artifactIdx = output.indexOf("```SDD_ARTIFACT");
  const statusIdx = output.search(/\bstatus\s*:/);

  if (artifactIdx === -1) {
    throw new InvalidExecutorOutputError("Missing SDD_ARTIFACT block");
  }

  if (statusIdx !== -1 && statusIdx < artifactIdx) {
    throw new InvalidExecutorOutputError("Result contract fields must appear after SDD_ARTIFACT block");
  }

  const statusMatch = output.match(/\bstatus\s*:\s*([^\n]+)/);
  const execSummaryMatch = output.match(/\bexecutive_summary\s*:\s*([^\n]+)/);
  const artifactsMatch = output.match(/\bartifacts\s*:\s*([^\n]+)/);
  const nextRecMatch = output.match(/\bnext_recommended\s*:\s*([^\n]+)/);
  const risksMatch = output.match(/\brisks\s*:\s*([^\n]+)/);
  const skillResMatch = output.match(/\bskill_resolution\s*:\s*([^\n]+)/);

  if (!statusMatch || !skillResMatch) {
    throw new InvalidExecutorOutputError("Missing required result contract fields");
  }

  const skillResValue = validateSkillResolution(skillResMatch[1]!.trim());

  return {
    valid: true,
    status: statusMatch[1]!.trim(),
    executiveSummary: execSummaryMatch ? execSummaryMatch[1]!.trim() : "",
    artifacts: artifactsMatch ? artifactsMatch[1]!.trim() : "",
    nextRecommended: nextRecMatch ? nextRecMatch[1]!.trim() : "",
    risks: risksMatch ? risksMatch[1]!.trim() : "",
    skillResolution: skillResValue,
    artifactContent: extractSddArtifact(output),
  };
}

const FORBIDDEN_PERSISTENCE_TOOLS = new Set([
  "sdd_save_artifact",
  "sdd_save_config",
  "mem_update",
  "mem_delete",
  "store",
  "store_batch",
  "update_memory_status",
]);

const FORBIDDEN_ARTIFACT_STORE_TOOLS = new Set([
  "mem_search",
  "mem_get_observation",
  "recall",
  "search",
  "find_related",
  "sdd_status",
]);

const FORBIDDEN_INTERACTIVE_TOOLS = new Set([
  "ask_user",
  "sdd_init_questions",
  "user_input",
  "prompt_user",
  "confirm_action",
]);

export function isToolAllowedForExecutor(toolName: string, _phase?: string): boolean {
  if (toolName === "pmc_get_context") return true;
  if (toolName === "sdd_checkpoint") return true;
  if (FORBIDDEN_PERSISTENCE_TOOLS.has(toolName)) return false;
  if (FORBIDDEN_ARTIFACT_STORE_TOOLS.has(toolName)) return false;
  if (FORBIDDEN_INTERACTIVE_TOOLS.has(toolName)) return false;
  return true;
}

export function validateExecutorToolCalls(toolCalls: string[], _phase?: string): void {
  for (const toolName of toolCalls) {
    if (FORBIDDEN_INTERACTIVE_TOOLS.has(toolName)) {
      throw new InteractiveToolViolationError(toolName);
    }
    if (FORBIDDEN_PERSISTENCE_TOOLS.has(toolName) && toolName !== "sdd_checkpoint") {
      throw new ExecutorPersistenceViolationError(toolName);
    }
    if (FORBIDDEN_ARTIFACT_STORE_TOOLS.has(toolName)) {
      throw new ArtifactStoreQueryViolationError(toolName);
    }
  }
}

export interface BlockedOnInput {
  readonly question?: string;
  readonly progressSummary?: string;
}

export function validateBlockedPhaseOutput(output: { status: string; blockedOn?: BlockedOnInput }): void {
  if (output.status === "blocked") {
    if (!output.blockedOn) {
      throw new InvalidBlockedOnStateError("blockedOn object is required when status is blocked");
    }
    if (!output.blockedOn.question || output.blockedOn.question.trim().length === 0) {
      throw new InvalidBlockedOnStateError("blockedOn.question must be non-empty when status is blocked");
    }
    if (!output.blockedOn.progressSummary || output.blockedOn.progressSummary.trim().length === 0) {
      throw new InvalidBlockedOnStateError("blockedOn.progressSummary must be non-empty when status is blocked");
    }
  }
}

export function inlineResumeProgressSummary(basePrompt: string, progressSummary: string): string {
  return `${basePrompt}\n\n## Resumed Dispatch Context\nProgress Summary: ${progressSummary}`;
}

export interface GatekeeperEvaluationInput {
  readonly skillResolution?: string;
  readonly unexpectedWrites?: boolean;
  readonly status?: string;
}

export interface GatekeeperEvaluationResult {
  readonly gatePassed: boolean;
  readonly escalate: boolean;
  readonly reason: string;
}

export function evaluateGatekeeperResult(input: GatekeeperEvaluationInput): GatekeeperEvaluationResult {
  if (input.skillResolution === "not-read") {
    return {
      gatePassed: false,
      escalate: false,
      reason: "Executor self-reported skill_resolution: not-read",
    };
  }

  if (input.unexpectedWrites) {
    return {
      gatePassed: false,
      escalate: true,
      reason: "Unexpected writes detected in non-mutating phase",
    };
  }

  return {
    gatePassed: true,
    escalate: false,
    reason: "Gatekeeper check passed",
  };
}

export function getGatekeeperValidatorDispatch(configuredDefaultModel: string): { subagentType: string } {
  return {
    subagentType: buildSubagentType(configuredDefaultModel),
  };
}

export function relayBlockedQuestion(blockedOn: { question: string }): { questionToRelay: string } {
  return {
    questionToRelay: blockedOn.question,
  };
}
