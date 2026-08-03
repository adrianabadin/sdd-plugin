/**
 * Outbound HTTP boundary for the semantic-utility gateway (design §8.1). Any
 * adapter behind this port talks to an OpenAI-compatible `/chat/completions`
 * endpoint; the application layer (`semantic-gateway.ts`) never calls
 * `fetch` directly, so tests can inject a fake and the suite never makes a
 * real network call (spec `sdd-semantic-gateway`).
 *
 * SG-5: `signal` lets the caller abort an in-flight request on timeout. The
 * application layer wraps each call in an `AbortController` timed at
 * `config.timeoutMs`; previously a `Promise.race` only RACED the timeout,
 * leaving the real request alive in the background. A real abort also lets
 * `sdd_parse_request` (WU10, EF-4) inherit timeout behavior through this
 * same port.
 */

export interface SemanticGatewayChatRequest {
  readonly endpoint: string;
  readonly model: string;
  /** Read from `process.env[apiKeyEnvVar]` by the caller, never persisted (SG-3). */
  readonly apiKey: string;
  readonly prompt: string;
  readonly maxTokens: number;
  /** SG-5: abort the in-flight HTTP request when this signal aborts. */
  readonly signal?: AbortSignal;
}

export interface SemanticGatewayChatResponse {
  readonly content: string;
  readonly reasoningContent: string | null;
}

export interface SemanticGatewayHttpPort {
  chatCompletion(request: SemanticGatewayChatRequest): Promise<SemanticGatewayChatResponse>;
}
