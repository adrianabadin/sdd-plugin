/**
 * Domain value object: the set of benchmark scores a Model may carry.
 *
 * Each score is independent and optional; a Model may have a subset populated.
 * The set is treated as a single conceptual unit (a value object) so the
 * domain does not leak benchmark field names into the use case.
 */
export interface BenchmarkScores {
  readonly mmlu?: number | null | undefined;
  readonly humaneval?: number | null | undefined;
  readonly sweBench?: number | null | undefined;
  readonly gpqa?: number | null | undefined;
  readonly math?: number | null | undefined;
  readonly bbh?: number | null | undefined;
  readonly mtBench?: number | null | undefined;
  readonly multineedle?: number | null | undefined;
}

/**
 * Canonical list of benchmark fields. Used by the SDK adapter to extract
 * known fields and by tests/serializers to iterate the value object.
 */
export const BENCHMARK_FIELDS: ReadonlyArray<keyof BenchmarkScores> = [
  "mmlu",
  "humaneval",
  "sweBench",
  "gpqa",
  "math",
  "bbh",
  "mtBench",
  "multineedle",
] as const;
