/**
 * WU7 — PC-1 through PC-9: Prompt composition unit tests.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-prompt-composition`).
 */

import assert from "node:assert/strict";

import {
  SHARED_EXECUTOR_CONTRACT,
  STATIC_PHASE_SKILLS_MAP,
  UnresolvableSkillError,
  PromptBudgetExceededError,
  buildSubagentType,
} from "../src/domain/sdd/prompt-composition.js";
import {
  composePhasePrompt,
} from "../src/application/sdd/prompt-composition.js";

async function runTests(): Promise<void> {
  console.log("--- sdd-prompt-composition (WU7 tasks PC-1 to PC-9) ---");

  // PC-1: Every required upstream artifact appears whole, not as preview, id, or summary
  {
    const specContent = "# Capability Spec\n\nFeature scenario 1 details.\nFeature scenario 2 details.";
    const designContent = "# Architecture Design\n\nComponent layout and data structures.";

    const result = composePhasePrompt({
      phase: "sdd-tasks",
      modelReference: "glm-4.7-flash",
      upstreamArtifacts: {
        spec: specContent,
        design: designContent,
      },
      skillResolver: (name) => `/abs/skills/${name}.md`,
    });

    assert.ok(result.prompt.includes(specContent), "PC-1 spec content appears whole");
    assert.ok(result.prompt.includes(designContent), "PC-1 design content appears whole");
    assert.equal(result.prompt.includes("[Preview"), false, "PC-1 no preview placeholder");
    assert.equal(result.prompt.includes("[Summary"), false, "PC-1 no summary placeholder");
  }
  console.log("  pass: PC-1 upstream artifacts appear whole");

  // PC-2: Exceeding budget fails loud naming offending artifact; no truncated prompt produced
  {
    const hugeArtifact = "A".repeat(1200);

    assert.throws(
      () => {
        composePhasePrompt({
          phase: "sdd-tasks",
          modelReference: "glm-4.7-flash",
          upstreamArtifacts: {
            spec: hugeArtifact,
          },
          budgetLimitChars: 1000,
          skillResolver: (name) => `/abs/skills/${name}.md`,
        });
      },
      (err: unknown) => {
        if (err instanceof PromptBudgetExceededError) {
          assert.equal(err.artifactName, "spec", "PC-2 names offending artifact");
          assert.equal(err.artifactSize, 1200, "PC-2 includes artifact size");
          assert.equal(err.budgetLimit, 1000, "PC-2 includes budget limit");
          return true;
        }
        return false;
      },
      "PC-2 throws PromptBudgetExceededError naming offending artifact",
    );
  }
  console.log("  pass: PC-2 exceeding budget fails loud naming offending artifact");

  // PC-3: Returned subagentType is complete grammar string `model-route:v1|sdd-mr-base|<modelReference>`
  {
    const modelRef = "glm-4.7-flash";
    const expectedSubagentType = `model-route:v1|sdd-mr-base|${modelRef}`;

    assert.equal(buildSubagentType(modelRef), expectedSubagentType, "PC-3 domain buildSubagentType");

    const result = composePhasePrompt({
      phase: "sdd-explore",
      modelReference: modelRef,
    });
    assert.equal(result.subagentType, expectedSubagentType, "PC-3 subagentType returned verbatim in result");
  }
  console.log("  pass: PC-3 returned subagentType is complete grammar string");

  // PC-4: The prompt body carries no natural-language model trigger
  {
    const modelRef = "glm-4.7-flash";
    const result = composePhasePrompt({
      phase: "sdd-explore",
      modelReference: modelRef,
    });

    const triggerRegex = /\b(use|using|model:)\s+glm-4\.7-flash\b/i;
    assert.equal(triggerRegex.test(result.prompt), false, "PC-4 prompt body carries no natural-language model trigger");
  }
  console.log("  pass: PC-4 prompt body carries no model trigger");

  // PC-5: Mapped skills appear as absolute paths under mandatory heading, paths not contents
  {
    const result = composePhasePrompt({
      phase: "sdd-tasks",
      modelReference: "glm-4.7-flash",
      skillResolver: (name) => `/home/user/project/.skills/${name}.md`,
    });

    assert.ok(result.prompt.includes("## Skills to load before work"), "PC-5 skills heading present");
    assert.ok(
      result.prompt.includes("- /home/user/project/.skills/work-unit-commits.md"),
      "PC-5 absolute path 1 injected",
    );
    assert.ok(
      result.prompt.includes("- /home/user/project/.skills/chained-pr.md"),
      "PC-5 absolute path 2 injected",
    );
  }
  console.log("  pass: PC-5 mapped skills appear as absolute paths under mandatory heading");

  // PC-6: An unresolvable mapped skill fails composition
  {
    assert.throws(
      () => {
        composePhasePrompt({
          phase: "sdd-tasks",
          modelReference: "glm-4.7-flash",
          skillResolver: (name) => (name === "chained-pr" ? null : `/skills/${name}.md`),
        });
      },
      (err: unknown) => {
        if (err instanceof UnresolvableSkillError) {
          assert.equal(err.skillName, "chained-pr", "PC-6 names unresolvable skill");
          return true;
        }
        return false;
      },
      "PC-6 throws UnresolvableSkillError on unresolvable skill",
    );
  }
  console.log("  pass: PC-6 unresolvable mapped skill fails composition");

  // PC-6b: omitting skillResolver entirely (the production default) MUST throw
  // for a phase that has mapped skills. The earlier default fabricated
  // `/skills/${name}`, making this throw unreachable in production — a
  // missing skill silently produced a bogus path instead of failing loud.
  {
    assert.throws(
      () => {
        composePhasePrompt({ phase: "sdd-tasks", modelReference: "glm-4.7-flash" });
      },
      UnresolvableSkillError,
      "PC-6b no skillResolver injected -> UnresolvableSkillError (default no longer fabricates a path)",
    );
  }
  console.log("  pass: PC-6b omitting skillResolver throws (default no longer fabricates a path)");

  // PC-7: A phase with an empty map entry composes with no skills heading
  {
    const result = composePhasePrompt({
      phase: "sdd-explore",
      modelReference: "glm-4.7-flash",
    });

    assert.equal(result.prompt.includes("## Skills to load before work"), false, "PC-7 no skills heading when map is empty");
  }
  console.log("  pass: PC-7 empty skills map composes with no skills heading");

  // PC-8: testingSkill: null resolves to nothing and composition still succeeds
  {
    const result = composePhasePrompt({
      phase: "sdd-apply",
      modelReference: "glm-4.7-flash",
      projectConfig: {
        testingSkill: null,
      },
      skillResolver: (name) => `/skills/${name}.md`,
    });

    assert.ok(result.prompt.includes("- /skills/work-unit-commits.md"), "PC-8 static skills present");
    assert.equal(result.prompt.includes("null"), false, "PC-8 null not rendered");
  }
  console.log("  pass: PC-8 testingSkill: null resolves to nothing and succeeds");

  // PC-9: Shared executor contract appears exactly once, ahead of phase content and inlined artifacts
  {
    const specContent = "# Spec Content";
    const result = composePhasePrompt({
      phase: "sdd-spec",
      modelReference: "glm-4.7-flash",
      upstreamArtifacts: { spec: specContent },
    });

    const contractIndex = result.prompt.indexOf(SHARED_EXECUTOR_CONTRACT);
    assert.ok(contractIndex >= 0, "PC-9 contract exists in prompt");
    const lastContractIndex = result.prompt.lastIndexOf(SHARED_EXECUTOR_CONTRACT);
    assert.equal(contractIndex, lastContractIndex, "PC-9 contract appears exactly once");

    const instructionsIndex = result.prompt.indexOf("## Phase Instructions");
    const artifactsIndex = result.prompt.indexOf("## Upstream Artifacts");

    assert.ok(contractIndex < instructionsIndex, "PC-9 contract ahead of phase instructions");
    assert.ok(instructionsIndex < artifactsIndex, "PC-9 phase instructions ahead of inlined artifacts");
  }
  console.log("  pass: PC-9 shared contract appears once ahead of phase content and artifacts");

  console.log("\nAll 10 sdd-prompt-composition (WU7) tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
