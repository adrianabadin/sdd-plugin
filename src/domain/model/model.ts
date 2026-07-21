import type { BenchmarkScores } from "../benchmark/benchmark-scores.js";
import type { QuarantineType } from "./quarantine.js";

/**
 * Canonical representation of a Model in the domain.
 *
 * Benchmarks live with the model (independent of provider) so a GPT-4o
 * score is the same regardless of whether it comes from OpenAI or Azure.
 */
export interface ModelData {
  readonly id: string;
  readonly name: string;
  readonly benchmarks?: BenchmarkScores | undefined;
  readonly quarantineType?: QuarantineType | null | undefined;
  readonly quarantineUntil?: Date | null | undefined;
}
