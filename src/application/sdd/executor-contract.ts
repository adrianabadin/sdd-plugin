/**
 * WU11 — PE-1 through PE-16: Executor contract application layer.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-phase-execution`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§1, §5, §6, §9).
 */

export {
  InvalidSkillResolutionError,
  InvalidExecutorOutputError,
  ExecutorPersistenceViolationError,
  ArtifactStoreQueryViolationError,
  InteractiveToolViolationError,
  InvalidBlockedOnStateError,
  validateSkillResolution,
  parseExecutorFinalOutput,
  extractSddArtifact,
  validateExecutorToolCalls,
  validateBlockedPhaseOutput,
  evaluateGatekeeperResult,
  getGatekeeperValidatorDispatch,
  inlineResumeProgressSummary,
  relayBlockedQuestion,
  isToolAllowedForExecutor,
} from "../../domain/sdd/executor-contract.js";

export type {
  SkillResolutionValue,
  ParsedExecutorOutput,
  BlockedOnInput,
  GatekeeperEvaluationInput,
  GatekeeperEvaluationResult,
} from "../../domain/sdd/executor-contract.js";
