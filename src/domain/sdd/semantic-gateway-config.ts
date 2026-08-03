/**
 * Semantic-utility gateway config shape (design §8.1; spec capability
 * `sdd-semantic-gateway`, "the provider is config-driven, the key is never in
 * config"). Pure parsing only — no filesystem or network I/O in this module.
 *
 * Hard Rule (design §8.1, non-negotiable): this shape holds `apiKeyEnvVar`,
 * the NAME of an environment variable, never the secret itself. Nothing in
 * this file, and nothing that round-trips through JSON.stringify of this
 * type, may carry the actual API key value.
 */

export interface SemanticGatewayConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyEnvVar: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
}

export class InvalidSemanticGatewayConfigError extends Error {
  constructor(reason: string) {
    super(`INVALID_SEMANTIC_GATEWAY_CONFIG: ${reason}`);
    this.name = "InvalidSemanticGatewayConfigError";
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidSemanticGatewayConfigError(`"${field}" must be a non-empty string`);
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new InvalidSemanticGatewayConfigError(`"${field}" must be a positive number`);
  }
  return value;
}

/** SG-1/SG-2: parses raw JSON text into a validated config. No defaults are invented here — the shipped file at `config/sdd/semantic-gateway.json` is the single source of defaults. */
export function parseSemanticGatewayConfig(raw: string): SemanticGatewayConfig {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidSemanticGatewayConfigError("root value must be an object");
  }
  const record = parsed as Record<string, unknown>;
  return {
    endpoint: requireString(record.endpoint, "endpoint"),
    model: requireString(record.model, "model"),
    apiKeyEnvVar: requireString(record.apiKeyEnvVar, "apiKeyEnvVar"),
    timeoutMs: requirePositiveInt(record.timeoutMs, "timeoutMs"),
    maxTokens: requirePositiveInt(record.maxTokens, "maxTokens"),
  };
}
