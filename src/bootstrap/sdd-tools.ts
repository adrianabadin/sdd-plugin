/**
 * The SDD MCP tool surface: the seven tools the SDD phase-agent system
 * exposes to the LLM (`sdd_status`, `sdd_compose_phase_prompt`,
 * `sdd_save_artifact`, `sdd_parse_request`, `sdd_init_questions`,
 * `sdd_save_config`, `sdd_checkpoint`).
 *
 * This module is the bridge between the OpenCode plugin SDK's `tool()`
 * builder and the pure application-layer functions in `src/application/sdd/`.
 * Each tool is a thin adapter: parse zod args → call the application function
 * → return a `ToolResult`. No business logic lives here.
 *
 * The earlier system shipped 131 tasks / 132 tests against a library NOBODY
 * called — the application layer existed but no MCP wiring registered these
 * tools with OpenCode. This module is that wiring (closes the structural
 * CRITICAL from the verify report). It is constructed once in the bootstrap
 * (`src/bootstrap/index.ts`) with its persistence/gateway dependencies and
 * the resulting `tool` map is returned alongside the existing
 * `tool.execute.before` hook.
 */

import { tool } from "@opencode-ai/plugin/tool";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";

import { assembleStatus } from "../application/sdd/compute-status.js";
import { composePhasePrompt } from "../application/sdd/prompt-composition.js";
import { saveArtifact } from "../application/sdd/save-artifact.js";
import { sddParseRequest } from "../application/sdd/entry-flow.js";
import {
  detectProjectFacts,
  getInitQuestions,
  saveInitConfig,
} from "../application/sdd/init-round.js";
import {
  declareBatch,
  recordCompletion,
  blockMidBatch,
  resumeBatch,
  readCheckpointData,
} from "../application/sdd/checkpoint.js";
import { canonicalizeProjectRoot } from "../domain/sdd/project-identity.js";
import { changeArtifactKey } from "../domain/sdd/sdd-keys.js";
import type { SddArtifactStorePort } from "../ports/sdd-artifact-store.port.js";

export interface SddToolsDeps {
  readonly store: SddArtifactStorePort;
  /** Resolves skill names to readable paths; null means "unresolvable" (PC-6). */
  readonly skillResolver?: (skillName: string) => string | null;
  /** The default model reference for phases that don't name one (EF-15). */
  readonly defaultModel?: string;
}

/**
 * Builds the seven SDD tools, each closing over the injected dependencies.
 * `projectRoot` arrives per-call from the tool's `context.directory` so each
 * invocation is namespaced by the session's actual project, not a startup-time
 * capture.
 */
export function buildSddTools(deps: SddToolsDeps): Record<string, ToolDefinition> {
  const defaultModel = deps.defaultModel ?? "claude-3-5-sonnet";

  const resolveProjectHash = (projectRoot: string): string =>
    canonicalizeProjectRoot(projectRoot).projectRootHash;

  const sddStatus: ToolDefinition = tool({
    description:
      "Compute the unified SDD status for a named change: artifacts present/missing, dependency-graph readiness per phase, blockedReasons, nextRecommended, and checkpoint progress. Read-only.",
    args: {
      projectRoot: tool.schema.string().describe("Absolute path to the project root."),
      changeName: tool.schema.string().describe("The change slug to report status for."),
      allIds: tool.schema.array(tool.schema.string()).describe("All scenario ids for the change (from tasks.md)."),
      verifyReportHasUnresolvedCritical: tool.schema
        .boolean()
        .optional()
        .describe("Whether the verify report carries an unresolved CRITICAL finding."),
    },
    async execute(args) {
      const projectRootHash = resolveProjectHash(args.projectRoot);
      const data = await readCheckpointData(deps.store, projectRootHash, args.changeName);
      const read = async (artifact: string): Promise<string | null> => {
        const key = changeArtifactKey(projectRootHash, args.changeName, artifact);
        return deps.store.readArtifact(key);
      };
      const [explore, proposal, spec, design, tasks, verifyReport, archiveReport] = await Promise.all([
        read("explore"),
        read("proposal"),
        read("spec"),
        read("design"),
        read("tasks"),
        read("verifyReport"),
        read("archiveReport"),
      ]);
      const status = assembleStatus({
        changeName: args.changeName,
        projectRoot: args.projectRoot,
        artifactContents: { explore, proposal, spec, design, tasks, verifyReport, archiveReport },
        allIds: args.allIds,
        checkpoints: data.checkpoints,
        inFlightPhase: null,
        blockedReasons: [],
        ...(args.verifyReportHasUnresolvedCritical !== undefined
          ? { verifyReportHasUnresolvedCritical: args.verifyReportHasUnresolvedCritical }
          : {}),
      });
      return { output: JSON.stringify(status, null, 2) };
    },
  });

  const sddComposePhasePrompt: ToolDefinition = tool({
    description:
      "Compose the prompt for a single SDD phase, acquiring the dispatch lock. Returns the subagentType grammar string and the composed prompt body.",
    args: {
      phase: tool.schema.string().describe("The phase name, e.g. sdd-explore, sdd-apply, sdd-verify."),
      modelReference: tool.schema.string().describe("Canonical model reference (provider/model)."),
      upstreamArtifacts: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .optional()
        .describe("Map of artifact name → content to inline."),
      projectConfig: tool.schema
        .record(tool.schema.string(), tool.schema.unknown())
        .optional()
        .describe("Merged project config (testingSkill, etc.)."),
      currentInFlightPhase: tool.schema.string().nullable().optional().describe("Current in-flight phase (for lock acquire)."),
    },
    async execute(args) {
      const result = composePhasePrompt({
        phase: args.phase,
        modelReference: args.modelReference,
        upstreamArtifacts: args.upstreamArtifacts ?? {},
        projectConfig: (args.projectConfig ?? null) as Exclude<
          Parameters<typeof composePhasePrompt>[0]["projectConfig"],
          undefined
        >,
        // Spread conditionally: under exactOptionalPropertyTypes an explicit
        // `undefined` is not assignable to an optional property.
        ...(deps.skillResolver !== undefined ? { skillResolver: deps.skillResolver } : {}),
        currentInFlightPhase: args.currentInFlightPhase ?? null,
      });
      return {
        output: JSON.stringify(
          { subagentType: result.subagentType, prompt: result.prompt, inFlightPhase: result.inFlightPhase, mutating: result.mutating },
          null,
          2,
        ),
      };
    },
  });

  const sddSaveArtifact: ToolDefinition = tool({
    description:
      "Persist an SDD artifact with write-then-read-back durability (SS-9) and release the dispatch lock. Returns ok:true/false and inFlightPhase:null.",
    args: {
      projectRoot: tool.schema.string().describe("Absolute path to the project root."),
      changeName: tool.schema.string().describe("The change slug."),
      artifact: tool.schema.string().describe("Artifact name (explore, proposal, spec, design, tasks, verifyReport, archiveReport)."),
      content: tool.schema.string().describe("The artifact content."),
      phase: tool.schema.string().optional().describe("Phase that produced this artifact (for mutating detection)."),
      currentInFlightPhase: tool.schema.string().nullable().optional().describe("Current in-flight phase to release."),
    },
    async execute(args) {
      const projectRootHash = resolveProjectHash(args.projectRoot);
      const key = changeArtifactKey(projectRootHash, args.changeName, args.artifact);
      const result = await saveArtifact(
        deps.store,
        key,
        args.content,
        args.currentInFlightPhase ?? null,
        args.phase !== undefined ? { phase: args.phase } : undefined,
      );
      return { output: JSON.stringify(result, null, 2) };
    },
  });

  // Named `...Tool` so it does not shadow the imported `sddParseRequest` use
  // case that its own `execute` calls.
  const sddParseRequestTool: ToolDefinition = tool({
    description:
      "Parse a free-text request for explicit SDD mention, task description, and model phrase. Returns { taskDescription, modelPhrase, explicitSddMention }.",
    args: {
      text: tool.schema.string().describe("The raw request text."),
    },
    async execute(args) {
      const parsed = await sddParseRequest(args.text);
      return { output: JSON.stringify(parsed, null, 2) };
    },
  });

  const sddInitQuestions: ToolDefinition = tool({
    description:
      "Run project-fact detection and return only the residual questions the user must answer (never asks about storage backend). IR-4/IR-5.",
    args: {
      files: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .describe("Map of filename → file content for detection (package.json, tsconfig.json, etc.)."),
    },
    async execute(args) {
      const detection = detectProjectFacts(args.files as Record<string, string>);
      const result = getInitQuestions(detection);
      return { output: JSON.stringify({ detection, questions: result.questions }, null, 2) };
    },
  });

  const sddSaveConfig: ToolDefinition = tool({
    description:
      "Merge detected facts with user answers (user answers win) and persist the project config at sdd-init/{projectRootHash}. IR-6/IR-12.",
    args: {
      projectRoot: tool.schema.string().describe("Absolute path to the project root."),
      detection: tool.schema.unknown().describe("The InitDetectionResult from sdd_init_questions."),
      userAnswers: tool.schema
        .record(tool.schema.string(), tool.schema.unknown())
        .optional()
        .describe("User answers (win over detection on conflict)."),
    },
    async execute(args) {
      const projectRootHash = resolveProjectHash(args.projectRoot);
      const saved = await saveInitConfig(
        deps.store,
        projectRootHash,
        args.detection as Parameters<typeof saveInitConfig>[2],
        (args.userAnswers ?? {}) as Parameters<typeof saveInitConfig>[3],
      );
      return { output: JSON.stringify(saved, null, 2) };
    },
  });

  const sddCheckpoint: ToolDefinition = tool({
    description:
      "Checkpoint operations for mid-phase resumability. Action 'declare' sets totalIds; 'complete' records a done id; 'block' pauses for user input; 'resume' continues with an answer.",
    args: {
      projectRoot: tool.schema.string().describe("Absolute path to the project root."),
      changeName: tool.schema.string().describe("The change slug."),
      phase: tool.schema.enum(["apply", "verify"]).describe("The mutating phase."),
      action: tool.schema
        .enum(["declare", "complete", "block", "resume"])
        .describe("The checkpoint operation."),
      totalIds: tool.schema.array(tool.schema.string()).optional().describe("For 'declare': all scenario ids in the batch."),
      batchId: tool.schema.string().optional().describe("For 'declare': optional batch id."),
      completedId: tool.schema.string().optional().describe("For 'complete': the id just completed."),
      note: tool.schema.string().optional().describe("For 'complete': optional executor note to distill."),
      question: tool.schema.string().optional().describe("For 'block': the blocking question."),
      progressSummary: tool.schema.string().optional().describe("For 'block': progress summary for resume."),
      blockedItemId: tool.schema.string().optional().describe("For 'block': the item id that was mid-work."),
      answer: tool.schema.string().optional().describe("For 'resume': the user's answer."),
    },
    async execute(args) {
      const projectRootHash = resolveProjectHash(args.projectRoot);
      const base = { store: deps.store, projectRootHash, changeName: args.changeName, phase: args.phase };

      switch (args.action) {
        case "declare": {
          const result = await declareBatch({
            ...base,
            totalIds: args.totalIds ?? [],
            ...(args.batchId !== undefined ? { batchId: args.batchId } : {}),
          });
          return { output: JSON.stringify(result, null, 2) };
        }
        case "complete": {
          const result = await recordCompletion({
            ...base,
            completedId: args.completedId ?? "",
            ...(args.note !== undefined ? { note: args.note } : {}),
          });
          return { output: JSON.stringify(result, null, 2) };
        }
        case "block": {
          const result = await blockMidBatch({
            ...base,
            question: args.question ?? "",
            progressSummary: args.progressSummary ?? "",
            ...(args.blockedItemId !== undefined ? { blockedItemId: args.blockedItemId } : {}),
          });
          return { output: JSON.stringify(result, null, 2) };
        }
        case "resume": {
          const result = await resumeBatch({ ...base, answer: args.answer ?? "" });
          return { output: JSON.stringify(result, null, 2) };
        }
        default:
          return { output: JSON.stringify({ error: `Unknown checkpoint action: ${String(args.action)}` }) };
      }
    },
  });

  return {
    sdd_status: sddStatus,
    sdd_compose_phase_prompt: sddComposePhasePrompt,
    sdd_save_artifact: sddSaveArtifact,
    sdd_parse_request: sddParseRequestTool,
    sdd_init_questions: sddInitQuestions,
    sdd_save_config: sddSaveConfig,
    sdd_checkpoint: sddCheckpoint,
  };
}
