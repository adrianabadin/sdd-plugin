/**
 * WU11 — PE-1 through PE-16: Executor contract and Gatekeeper evaluation tests.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-phase-execution`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§1, §5, §6, §9).
 */

import assert from "node:assert/strict";

import {
  InvalidSkillResolutionError,
  InvalidExecutorOutputError,
  ExecutorPersistenceViolationError,
  ArtifactStoreQueryViolationError,
  InteractiveToolViolationError,
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
} from "../src/domain/sdd/executor-contract.js";
import {
  composePhasePrompt,
} from "../src/application/sdd/prompt-composition.js";

async function runTests(): Promise<void> {
  console.log("--- sdd-executor-contract (WU11 tasks PE-1 to PE-16) ---");

  // PE-1: Artifact emitted as fenced SDD_ARTIFACT block; executor calls no persistence tool but sdd_checkpoint
  {
    const sampleOutput = `Here is the completed artifact:

\`\`\`SDD_ARTIFACT:
# Explore Findings
Discovered 3 subsystems.
\`\`\`

status: ok
executive_summary: Exploration completed cleanly
artifacts: explore.md
next_recommended: sdd-propose
risks: none
skill_resolution: paths-injected`;

    const artifact = extractSddArtifact(sampleOutput);
    assert.equal(artifact?.trim(), "# Explore Findings\nDiscovered 3 subsystems.", "PE-1 extracts fenced SDD_ARTIFACT block");

    // Executor tool calls validation: sdd_checkpoint allowed, sdd_save_artifact forbidden
    assert.doesNotThrow(
      () => validateExecutorToolCalls(["sdd_checkpoint", "pmc_get_context"]),
      "PE-1 sdd_checkpoint and pmc_get_context allowed for executor",
    );

    assert.throws(
      () => validateExecutorToolCalls(["sdd_save_artifact"]),
      (err: unknown) => err instanceof ExecutorPersistenceViolationError,
      "PE-1 sdd_save_artifact forbidden for executor",
    );
  }
  console.log("  pass: PE-1 artifact returned in fenced block, persistence limited to sdd_checkpoint");

  // PE-2: Final output is text with SDD_ARTIFACT block first, contract fields last
  {
    const validOutput = `\`\`\`SDD_ARTIFACT:
# Proposal
Scope defined.
\`\`\`

status: ok
executive_summary: Proposal ready
artifacts: proposal.md
next_recommended: sdd-spec
risks: none
skill_resolution: paths-injected`;

    const parsed = parseExecutorFinalOutput(validOutput);
    assert.equal(parsed.valid, true, "PE-2 valid text output with artifact first and contract fields last");
    assert.equal(parsed.status, "ok", "PE-2 status parsed");
    assert.equal(parsed.skillResolution, "paths-injected", "PE-2 skill_resolution parsed");

    const invalidOrderOutput = `status: ok
executive_summary: Proposal ready
artifacts: proposal.md
next_recommended: sdd-spec
risks: none
skill_resolution: paths-injected

\`\`\`SDD_ARTIFACT:
# Proposal
\`\`\``;

    assert.throws(
      () => parseExecutorFinalOutput(invalidOrderOutput),
      (err: unknown) => err instanceof InvalidExecutorOutputError,
      "PE-2 throws when contract fields appear before SDD_ARTIFACT block",
    );
  }
  console.log("  pass: PE-2 final output text structure verified");

  // PE-3: Blocked phase populates non-empty blockedOn.question and progressSummary; resume inlines summary
  {
    assert.throws(
      () => validateBlockedPhaseOutput({ status: "blocked", blockedOn: { question: "What DB?", progressSummary: "" } }),
      "PE-3 throws if blockedOn.progressSummary is empty",
    );

    assert.throws(
      () => validateBlockedPhaseOutput({ status: "blocked", blockedOn: { question: "", progressSummary: "In progress" } }),
      "PE-3 throws if blockedOn.question is empty",
    );

    const validBlocked = {
      status: "blocked",
      blockedOn: {
        question: "Which database provider should be used?",
        progressSummary: "Analyzed existing models and routes. Waiting for DB selection.",
      },
    };
    assert.doesNotThrow(() => validateBlockedPhaseOutput(validBlocked), "PE-3 accepts valid blockedOn");

    const basePrompt = "## Phase Instructions\nImplement auth.";
    const resumedPrompt = inlineResumeProgressSummary(basePrompt, validBlocked.blockedOn.progressSummary);
    assert.ok(resumedPrompt.includes(validBlocked.blockedOn.progressSummary), "PE-3 resume inlines progressSummary into prompt");
  }
  console.log("  pass: PE-3 blocked phase blockedOn population and prompt inlining verified");

  // PE-4: skill_resolution carries only paths-injected or not-read
  {
    assert.equal(validateSkillResolution("paths-injected"), "paths-injected", "PE-4 paths-injected valid");
    assert.equal(validateSkillResolution("not-read"), "not-read", "PE-4 not-read valid");

    assert.throws(
      () => validateSkillResolution("fallback-registry"),
      (err: unknown) => err instanceof InvalidSkillResolutionError,
      "PE-4 fallback-registry rejected as contract violation",
    );
    assert.throws(
      () => validateSkillResolution("none"),
      (err: unknown) => err instanceof InvalidSkillResolutionError,
      "PE-4 none rejected as contract violation",
    );
  }
  console.log("  pass: PE-4 skill_resolution value constraints verified");

  // PE-5: skill_resolution: not-read is a Gatekeeper failure
  {
    const evalResult = evaluateGatekeeperResult({
      skillResolution: "not-read",
      unexpectedWrites: false,
    });
    assert.equal(evalResult.gatePassed, false, "PE-5 not-read triggers gate failure");
    assert.ok(evalResult.reason.includes("not-read"), "PE-5 reason specifies not-read");
  }
  console.log("  pass: PE-5 skill_resolution not-read triggers Gatekeeper failure");

  // PE-6: Recorded tool-call log contains no call to SDD artifact store
  {
    assert.doesNotThrow(
      () => validateExecutorToolCalls(["view_file", "pmc_get_context"]),
      "PE-6 standard tools allowed",
    );

    assert.throws(
      () => validateExecutorToolCalls(["mem_search"]),
      (err: unknown) => err instanceof ArtifactStoreQueryViolationError,
      "PE-6 mem_search forbidden for executor",
    );
    assert.throws(
      () => validateExecutorToolCalls(["mem_get_observation"]),
      (err: unknown) => err instanceof ArtifactStoreQueryViolationError,
      "PE-6 mem_get_observation forbidden for executor",
    );
  }
  console.log("  pass: PE-6 artifact store tool queries forbidden for executor");

  // PE-7: pmc_get_context is available to every phase
  {
    const phases = ["sdd-explore", "sdd-propose", "sdd-spec", "sdd-design", "sdd-tasks", "sdd-apply", "sdd-verify", "sdd-archive"];
    for (const phase of phases) {
      assert.equal(isToolAllowedForExecutor("pmc_get_context", phase), true, `PE-7 pmc_get_context allowed in ${phase}`);
    }
  }
  console.log("  pass: PE-7 pmc_get_context available to all phases");

  // PE-8: Executors never call an interactive tool; orchestrator relays question
  {
    assert.throws(
      () => validateExecutorToolCalls(["ask_user"]),
      (err: unknown) => err instanceof InteractiveToolViolationError,
      "PE-8 ask_user forbidden for executor",
    );
    assert.throws(
      () => validateExecutorToolCalls(["sdd_init_questions"]),
      (err: unknown) => err instanceof InteractiveToolViolationError,
      "PE-8 sdd_init_questions forbidden for executor",
    );

    const questionRelay = relayBlockedQuestion({ question: "Choose model provider: A or B?" });
    assert.equal(questionRelay.questionToRelay, "Choose model provider: A or B?", "PE-8 question relayed verbatim");
  }
  console.log("  pass: PE-8 interactive tools forbidden, blocked question relayed verbatim");

  // PE-9: Composed sdd-tasks prompt instructs forecast lines verbatim, including 1000-line budget risk
  {
    const result = composePhasePrompt({ phase: "sdd-tasks", modelReference: "glm-4.7-flash", skillResolver: () => "/skills/x" });
    assert.ok(result.prompt.includes("Decision needed before apply: Yes|No"), "PE-9 contains Decision needed line");
    assert.ok(result.prompt.includes("Chained PRs recommended: Yes|No"), "PE-9 contains Chained PRs line");
    assert.ok(result.prompt.includes("1000-line budget risk: Low|Medium|High"), "PE-9 contains 1000-line budget risk line");
  }
  console.log("  pass: PE-9 sdd-tasks prompt contains forecast lines verbatim");

  // PE-10: Composed sdd-tasks prompt carries one-task-per-scenario Hard Rule
  {
    const result = composePhasePrompt({ phase: "sdd-tasks", modelReference: "glm-4.7-flash", skillResolver: () => "/skills/x" });
    assert.ok(
      result.prompt.includes("each task must map to exactly one scenario from spec.md and must be independently RED→GREEN testable in isolation"),
      "PE-10 contains one-task-per-scenario Hard Rule",
    );
  }
  console.log("  pass: PE-10 sdd-tasks prompt carries one-task-per-scenario Hard Rule");

  // PE-11: Composed sdd-design prompt carries per-scenario signature Hard Rule
  {
    const result = composePhasePrompt({ phase: "sdd-design", modelReference: "glm-4.7-flash" });
    assert.ok(
      result.prompt.includes("for every scenario, specify its function signature, inputs/outputs, and error behavior precisely enough"),
      "PE-11 contains per-scenario signature Hard Rule",
    );
  }
  console.log("  pass: PE-11 sdd-design prompt carries per-scenario signature Hard Rule");

  // PE-12: Composed sdd-apply prompt says checkpoints are tick marks and forbids tasks.md edits
  {
    const result = composePhasePrompt({ phase: "sdd-apply", modelReference: "glm-4.7-flash", skillResolver: () => "/skills/x" });
    assert.ok(result.prompt.includes("Do not try to edit tasks.md to tick items off"), "PE-12 forbids editing tasks.md");
    assert.ok(result.prompt.includes("Your checkpoints are the tick marks"), "PE-12 states checkpoints are tick marks");
  }
  console.log("  pass: PE-12 sdd-apply prompt instructs checkpoint tick marks and forbids tasks.md edits");

  // PE-13: Composed sdd-explore prompt instructs decomposition on oversized scope
  {
    const result = composePhasePrompt({ phase: "sdd-explore", modelReference: "glm-4.7-flash" });
    assert.ok(
      result.prompt.includes("If the request scope spans multiple independent subsystems, say so and recommend decomposition instead of proceeding"),
      "PE-13 contains decomposition instruction",
    );
  }
  console.log("  pass: PE-13 sdd-explore prompt instructs decomposition on oversized scope");

  // PE-14: Composed sdd-propose prompt instructs 3–5 questions only on genuine ambiguity
  {
    const result = composePhasePrompt({ phase: "sdd-propose", modelReference: "glm-4.7-flash" });
    assert.ok(
      result.prompt.includes("Ask the product/business clarifying questions (3–5) if the task description leaves real ambiguity; otherwise proceed"),
      "PE-14 contains 3-5 clarifying questions instruction",
    );
  }
  console.log("  pass: PE-14 sdd-propose prompt instructs 3-5 questions only on genuine ambiguity");

  // PE-15: unexpectedWrites is treated as Gatekeeper failure entering escalate-don't-loop path
  {
    const evalResult = evaluateGatekeeperResult({
      unexpectedWrites: true,
      skillResolution: "paths-injected",
    });
    assert.equal(evalResult.gatePassed, false, "PE-15 unexpectedWrites causes gate failure");
    assert.equal(evalResult.escalate, true, "PE-15 unexpectedWrites sets escalate: true");
  }
  console.log("  pass: PE-15 unexpectedWrites triggers Gatekeeper failure and escalation");

  // PE-16: Gatekeeper validator dispatches on configured default model through explicit grammar
  {
    const defaultModel = "glm-4.7-flash";
    const dispatch = getGatekeeperValidatorDispatch(defaultModel);
    assert.equal(dispatch.subagentType, `model-route:v1|sdd-mr-base|${defaultModel}`, "PE-16 validator subagentType uses explicit grammar and default model");
  }
  console.log("  pass: PE-16 Gatekeeper validator dispatches on default model through explicit grammar");

  console.log("\nAll WU11 sdd-executor-contract tests passed!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
