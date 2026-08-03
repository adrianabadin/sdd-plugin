/**
 * WU5 — SG-1..SG-6: the semantic-utility gateway (design §8.1; spec
 * capability `sdd-semantic-gateway`). `sdd_parse_request` (WU10) and
 * `batchNotes` distillation (WU9) both call through this module; neither is
 * implemented here — this is the shared config-driven client, truncation
 * detection, timeout handling, and the fail-tolerant `batchNotes` wrapper
 * they'll both use.
 *
 * Call-site code never talks to a provider directly (`SemanticGatewayHttpPort`
 * is the only thing this module calls), and the API key is read from
 * `process.env[apiKeyEnvVar]` at call time — never accepted as a config
 * field, never logged (SG-3, design §8.1 Hard Rule).
 *
 * SG-5: timeout is a REAL abort, not a `Promise.race`. Each call gets an
 * `AbortController` timed at `config.timeoutMs`; when it fires, the signal
 * aborts the in-flight HTTP request via the port's `signal` field. The
 * earlier `Promise.race` implementation left the request alive in the
 * background. `withAbortableTimeout` is exported so `sdd_parse_request`
 * (EF-4) can reuse the same primitive for its own timeout.
 */

import type { SemanticGatewayConfig } from "../../domain/sdd/semantic-gateway-config.js";
import type {
  SemanticGatewayChatRequest,
  SemanticGatewayHttpPort,
} from "../../ports/semantic-gateway-client.port.js";

export interface SemanticGatewayPort {
  distill(note: string): Promise<string>;
}


export class SemanticGatewayTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`SEMANTIC_GATEWAY_TIMEOUT: no response within ${timeoutMs}ms`);
    this.name = "SemanticGatewayTimeoutError";
  }
}

export class SemanticGatewayMissingApiKeyError extends Error {
  constructor(envVar: string) {
    // Deliberately names only the ENV VAR NAME, never a value (SG-3).
    super(`SEMANTIC_GATEWAY_MISSING_API_KEY: process.env.${envVar} is not set`);
    this.name = "SemanticGatewayMissingApiKeyError";
  }
}

export class SemanticGatewayTruncationError extends Error {
  constructor() {
    super("SEMANTIC_GATEWAY_TRUNCATED: content remained empty after retrying with a larger token budget");
    this.name = "SemanticGatewayTruncationError";
  }
}

/** SG-4: an empty `content` with non-empty `reasoning_content` is the reasoning-model truncation signature, not a valid empty answer. */
function isTruncated(response: { readonly content: string; readonly reasoningContent: string | null }): boolean {
  return response.content.length === 0 && (response.reasoningContent?.length ?? 0) > 0;
}

/**
 * SG-5: runs `work` bounded by a REAL abort on timeout. Creates an
 * `AbortController`, arms a `setTimeout` to abort it after `timeoutMs`, and
 * passes `signal` to `work` so a cooperative `work` can cancel its underlying
 * request in-flight. Because not every `work` honors the signal (e.g. a
 * third-party parse that ignores AbortSignal), this also RACES the timeout:
 * if the timer fires before `work` settles, this rejects with
 * `SemanticGatewayTimeoutError` immediately, without waiting for `work` to
 * finish. The earlier `Promise.race`-only version left the request alive;
 * this version aborts the signal AND races, so a hanging `work` is bounded
 * whether or not it cooperates with the signal.
 *
 * Exported because `sdd_parse_request` (EF-4) needs the same primitive to
 * bound a gateway parse call that may hang.
 */
export async function withAbortableTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SemanticGatewayTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // Aborting an already-aborted controller is a no-op; this ensures the
    // signal reflects "done" for any cooperative work that checks it.
    controller.abort();
  }
}

/**
 * SG-1/SG-2/SG-3/SG-4/SG-5: issues one gateway call against exactly the
 * configured endpoint and model, reading the key from the environment at
 * call time, aborting on timeout (SG-5), and retrying once with a doubled
 * token budget when the response looks truncated (SG-4) — never returning an
 * empty `content` as a success.
 */
export async function callSemanticGateway(
  port: SemanticGatewayHttpPort,
  config: SemanticGatewayConfig,
  prompt: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const apiKey = env[config.apiKeyEnvVar];
  if (!apiKey) {
    throw new SemanticGatewayMissingApiKeyError(config.apiKeyEnvVar);
  }

  const buildRequest = (maxTokens: number, signal: AbortSignal): SemanticGatewayChatRequest => ({
    endpoint: config.endpoint,
    model: config.model,
    apiKey,
    prompt,
    maxTokens,
    signal,
  });

  const first = await withAbortableTimeout(
    (signal) => port.chatCompletion(buildRequest(config.maxTokens, signal)),
    config.timeoutMs,
  );

  if (!isTruncated(first)) {
    return first.content;
  }

  // SG-4: retry once with a larger budget before giving up.
  const retried = await withAbortableTimeout(
    (signal) => port.chatCompletion(buildRequest(config.maxTokens * 2, signal)),
    config.timeoutMs,
  );

  // SG-4: if the retry is still truncated OR still empty, this is a genuine
  // truncation we cannot recover from — surface the error rather than
  // returning an empty string as if it were a valid answer.
  if (isTruncated(retried) || retried.content.length === 0) {
    throw new SemanticGatewayTruncationError();
  }

  return retried.content;
}

/**
 * SG-6: `batchNotes` is an optimization, never load-bearing for correctness
 * (design §4, §8.1). A failed or timed-out distillation yields an empty note
 * and the caller (WU9's checkpoint batch flow) proceeds unaffected — this
 * function itself never throws.
 */
export async function distillBatchNote(
  port: SemanticGatewayHttpPort,
  config: SemanticGatewayConfig,
  prompt: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  try {
    return await callSemanticGateway(port, config, prompt, env);
  } catch {
    return "";
  }
}
