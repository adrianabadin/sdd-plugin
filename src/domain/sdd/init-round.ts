/**
 * Domain entities and functions for SDD Init Round (WU6 — IR-1 to IR-12).
 * Spec capability: `sdd-init-round`
 */

import path from "node:path";

import type { SkillPathMap } from "./skill-resolution.js";

export interface InitDetectionResult {
  readonly stack: string | null;
  readonly testingCommand: string | null;
  readonly strictTddSupport: boolean | null;
  readonly conventions: string | null;
  readonly testingSkill: string | null;
  readonly residuals: readonly string[];
}

export interface InitQuestion {
  readonly field: string;
  readonly question: string;
}

export interface InitQuestionsResult {
  readonly questions: readonly InitQuestion[];
}

export interface ProjectConfig {
  readonly stack: string | null;
  readonly testingCommand: string | null;
  readonly strictTddSupport: boolean | null;
  readonly conventions: string | null;
  readonly testingSkill: string | null;
  readonly model?: string | null;
  /**
   * `skill name -> absolute SKILL.md path`, the map the configured skill
   * resolver consults at compose time. Optional on the TYPE because configs
   * persisted before this field existed read back without it; `mergeConfig`
   * always writes at least `{}` going forward (migration contract).
   */
  readonly skillPaths?: SkillPathMap;
  readonly [key: string]: unknown;
}

/**
 * A `skillPaths` value was not a usable `skill name -> absolute path` map.
 *
 * Thrown from `mergeConfig`, which runs BEFORE the config is persisted, so a
 * malformed map never reaches the checkpoint. That ordering is the point: a
 * persisted bad map would turn every later compose into an
 * `UnresolvableSkillError` blaming a config value the operator never knowingly
 * saved, and the fix would be an edit to a file they never saw written.
 */
export class InvalidSkillPathMapError extends Error {
  readonly code = "INVALID_SKILL_PATH_MAP";
  constructor(readonly detail: string) {
    super(`INVALID_SKILL_PATH_MAP: ${detail}`);
    this.name = "InvalidSkillPathMapError";
  }
}

/**
 * Validates a candidate `skillPaths` value and returns it as a `SkillPathMap`.
 *
 * Absoluteness is checked with `path.isAbsolute` — the SAME predicate the
 * configured resolver uses to reject a mapped path
 * (`src/infrastructure/skills/configured-skill-resolver.adapter.ts`). Using a
 * different rule here would let a value pass validation and then be rejected
 * at resolution time, which is the worst of both: persisted AND unusable.
 */
function validateSkillPathMap(candidate: unknown): SkillPathMap {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new InvalidSkillPathMapError(`skillPaths must be an object mapping skill names to absolute paths, received ${Array.isArray(candidate) ? "an array" : typeof candidate}`);
  }
  const entries = Object.entries(candidate as Record<string, unknown>);
  for (const [name, value] of entries) {
    if (name.trim() === "") {
      throw new InvalidSkillPathMapError("skillPaths contains an empty skill name; a name that cannot be looked up can never resolve");
    }
    if (typeof value !== "string" || value === "") {
      throw new InvalidSkillPathMapError(`skillPaths["${name}"] must be a non-empty string path, received ${value === "" ? "an empty string" : typeof value}`);
    }
    if (!path.isAbsolute(value)) {
      throw new InvalidSkillPathMapError(`skillPaths["${name}"] must be an absolute path; "${value}" is relative and skill paths are never resolved against the project root`);
    }
  }
  return Object.fromEntries(entries) as SkillPathMap;
}

/**
 * IR-1, IR-2, IR-3: Detect project facts without side-effects or guesses.
 */
export function detectProjectFacts(files: Record<string, string>): InitDetectionResult {
  const fileKeys = Object.keys(files);
  const residuals: string[] = [];

  // IR-1: Stack slot
  let stack: string | null = null;
  if (files["package.json"] || fileKeys.some((f) => f.endsWith(".ts") || f.endsWith(".js"))) {
    stack = files["tsconfig.json"] || fileKeys.some((f) => f.endsWith(".ts"))
      ? "typescript"
      : "javascript";
  } else if (files["go.mod"] || fileKeys.some((f) => f.endsWith(".go"))) {
    stack = "go";
  } else if (files["Cargo.toml"] || fileKeys.some((f) => f.endsWith(".rs"))) {
    stack = "rust";
  } else if (files["requirements.txt"] || files["pyproject.toml"] || fileKeys.some((f) => f.endsWith(".py"))) {
    stack = "python";
  }

  if (!stack) {
    stack = null;
    residuals.push("stack");
  }

  // IR-1, IR-2: Testing command slot (IR-2: never guess, report unknown).
  // Only a manifest that DECLARES the test command counts (package.json
  // scripts.test). Earlier versions fabricated "go test ./..." and
  // "cargo test" from manifest presence alone — that is a guess: nothing in a
  // go.mod/Cargo.toml proves the project actually uses those exact commands
  // (Makefile, CI workflows, and custom scripts all override them). For
  // go/rust we report `unknown` and surface a residual question instead.
  let testingCommand: string | null = null;
  if (files["package.json"]) {
    try {
      const pkg = JSON.parse(files["package.json"]);
      if (pkg.scripts && typeof pkg.scripts.test === "string" && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        testingCommand = pkg.scripts.test;
      }
    } catch {
      // JSON parse error
    }
  }

  if (!testingCommand) {
    testingCommand = "unknown";
    residuals.push("testingCommand");
  }

  // IR-1: Strict TDD support slot
  let strictTddSupport: boolean | null = null;
  const tddConfigContent = files["openspec/config.yaml"] ?? files["sdd.config.json"];
  if (tddConfigContent !== undefined) {
    if (tddConfigContent.includes("strict_tdd: true")) {
      strictTddSupport = true;
    } else if (tddConfigContent.includes("strict_tdd: false")) {
      strictTddSupport = false;
    }
  }
  if (strictTddSupport === null) {
    if (testingCommand !== "unknown") {
      strictTddSupport = true;
    } else {
      strictTddSupport = null;
      residuals.push("strictTddSupport");
    }
  }

  // IR-1: Conventions slot
  let conventions: string | null = null;
  if (files[".eslintrc"] || files[".eslintrc.json"] || files["eslint.config.js"] || files["eslint.config.mjs"]) {
    conventions = "eslint";
  } else if (files[".prettierrc"] || files[".prettierrc.json"]) {
    conventions = "prettier";
  }
  if (!conventions) {
    conventions = null;
    residuals.push("conventions");
  }

  // IR-7, IR-8: Testing skill detection
  let testingSkill: string | null = null;
  if (files["package.json"]) {
    const pkgStr = files["package.json"];
    if (pkgStr.includes("vitest")) {
      testingSkill = "vitest-skill";
    } else if (pkgStr.includes("jest")) {
      testingSkill = "jest-skill";
    }
  }
  if (!testingSkill) {
    testingSkill = null; // IR-8: explicit null for unregistered skill
  }

  return {
    stack,
    testingCommand,
    strictTddSupport,
    conventions,
    testingSkill,
    residuals,
  };
}

/**
 * IR-4, IR-5: Returns residual questions only.
 * Inferred facts produce no questions. Storage backend is NEVER asked.
 */
export function getInitQuestions(detection: InitDetectionResult): InitQuestionsResult {
  const questions: InitQuestion[] = [];

  for (const field of detection.residuals) {
    if (field === "artifactStore" || field === "storageBackend") {
      continue; // IR-5: no storage-backend question ever
    }
    if (field === "stack") {
      questions.push({ field: "stack", question: "What language/framework stack is this project using?" });
    } else if (field === "testingCommand") {
      questions.push({ field: "testingCommand", question: "What command is used to run tests in this project?" });
    } else if (field === "strictTddSupport") {
      questions.push({ field: "strictTddSupport", question: "Does this project enforce strict TDD?" });
    } else if (field === "conventions") {
      questions.push({ field: "conventions", question: "What coding conventions or linters are used?" });
    }
  }

  return { questions };
}

/**
 * IR-6, IR-7, IR-8: Merges detected facts with user answers (user answers win on conflict).
 * Persists testingSkill as explicit null if unregistered.
 */
export function mergeConfig(
  detected: InitDetectionResult,
  userAnswers: Partial<ProjectConfig> = {},
): ProjectConfig {
  // Validate FIRST, before a single merged field is computed. `saveInitConfig`
  // calls this before `writeCheckpoint`, so throwing here is what guarantees a
  // malformed map never reaches the store (design scenario 5).
  const mergedSkillPaths = userAnswers.skillPaths !== undefined
    ? validateSkillPathMap(userAnswers.skillPaths)
    : {};

  const mergedTestingSkill = userAnswers.testingSkill !== undefined
    ? userAnswers.testingSkill
    : (detected.testingSkill ?? null);

  return {
    stack: userAnswers.stack !== undefined ? userAnswers.stack : detected.stack,
    testingCommand: userAnswers.testingCommand !== undefined ? userAnswers.testingCommand : detected.testingCommand,
    strictTddSupport: userAnswers.strictTddSupport !== undefined ? userAnswers.strictTddSupport : detected.strictTddSupport,
    conventions: userAnswers.conventions !== undefined ? userAnswers.conventions : detected.conventions,
    testingSkill: mergedTestingSkill,
    // Always written — an absent map persists as `{}` so a config read back by
    // the resolver is never missing the key it looks up (migration contract).
    skillPaths: mergedSkillPaths,
    ...(userAnswers.model !== undefined ? { model: userAnswers.model } : {}),
  };
}

/**
 * IR-11: Checks whether a request conflicts with stored config and re-opens the field.
 */
export function shouldReopenConfig(
  storedConfig: ProjectConfig,
  requestParams: { model?: string },
): { reOpen: boolean; reOpenFields: string[] } {
  const reOpenFields: string[] = [];

  if (requestParams.model !== undefined && storedConfig.model !== undefined && requestParams.model !== storedConfig.model) {
    reOpenFields.push("model");
  }

  return {
    reOpen: reOpenFields.length > 0,
    reOpenFields,
  };
}
