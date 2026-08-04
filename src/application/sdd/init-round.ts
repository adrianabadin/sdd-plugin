/**
 * Application functions for SDD Init Round (WU6 — IR-3, IR-6, IR-9, IR-10, IR-12).
 */

import { initConfigKey } from "../../domain/sdd/sdd-keys.js";
import { isDeepStrictEqual } from "node:util";
import {
  detectProjectFacts,
  getInitQuestions,
  mergeConfig,
  type InitDetectionResult,
  type InitQuestionsResult,
  type ProjectConfig,
} from "../../domain/sdd/init-round.js";
import type { SddArtifactStorePort } from "../../ports/sdd-artifact-store.port.js";

export class SaveConfigBeforeDetectionError extends Error {
  constructor() {
    super("Refused sdd_save_config: detection must run before saving config");
    this.name = "SaveConfigBeforeDetectionError";
  }
}

export class InitConfigReadbackMismatchError extends Error {
  constructor(readonly key: string) {
    super(`SDD_INIT_CONFIG_READBACK_MISMATCH: '${key}' did not read back the persisted config.`);
    this.name = "InitConfigReadbackMismatchError";
  }
}

/**
 * IR-9, IR-10: Checks if a project has already been initialized.
 */
export async function isProjectInitialized(
  store: SddArtifactStorePort,
  projectRootHash: string,
): Promise<boolean> {
  const key = initConfigKey(projectRootHash);
  const stored = await store.readCheckpoint(key);
  return stored !== null && stored !== undefined;
}

/**
 * IR-6, IR-7, IR-8, IR-12: Merges and saves project config.
 * Throws SaveConfigBeforeDetectionError if detection has not run.
 * Persists at sdd-init/{projectRootHash}.
 */
export async function saveInitConfig(
  store: SddArtifactStorePort,
  projectRootHash: string,
  detection: InitDetectionResult | null,
  userAnswers: Partial<ProjectConfig> = {},
): Promise<ProjectConfig> {
  // IR-12: sdd_save_config is refused before detection has run
  if (!detection) {
    throw new SaveConfigBeforeDetectionError();
  }

  const merged = mergeConfig(detection, userAnswers);
  const key = initConfigKey(projectRootHash);

  // IR-6: persisted at sdd-init/{projectRootHash}
  await store.writeCheckpoint(key, merged);
  const readBack = await store.readCheckpoint(key);
  if (!isDeepStrictEqual(readBack?.content, merged)) {
    throw new InitConfigReadbackMismatchError(key);
  }
  return merged;
}

export { detectProjectFacts, getInitQuestions, mergeConfig };
