/**
 * WU5 — SG-1..SG-6: the semantic-utility gateway (RED-first).
 * See docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md capability
 * `sdd-semantic-gateway`.
 *
 * No real network call anywhere in this suite: every scenario injects a
 * FakeHttpPort implementing SemanticGatewayHttpPort — this is the same
 * dependency-injection shape WU1 used for McpToolClientPort.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseSemanticGatewayConfig, type SemanticGatewayConfig } from "../src/domain/sdd/semantic-gateway-config.js";
import {
  callSemanticGateway,
  distillBatchNote,
  SemanticGatewayTimeoutError,
  SemanticGatewayTruncationError,
} from "../src/application/sdd/semantic-gateway.js";
import type {
  SemanticGatewayChatRequest,
  SemanticGatewayChatResponse,
  SemanticGatewayHttpPort,
} from "../src/ports/semantic-gateway-client.port.js";

const CONFIG_PATH = path.join(process.cwd(), "config", "sdd", "semantic-gateway.json");

class RecordingFakeHttpPort implements SemanticGatewayHttpPort {
  readonly calls: SemanticGatewayChatRequest[] = [];
  constructor(private readonly responses: SemanticGatewayChatResponse[]) {}
  async chatCompletion(request: SemanticGatewayChatRequest): Promise<SemanticGatewayChatResponse> {
    this.calls.push(request);
    const response = this.responses[this.calls.length - 1] ?? this.responses[this.responses.length - 1];
    return response;
  }
}

class HangingHttpPort implements SemanticGatewayHttpPort {
  async chatCompletion(): Promise<SemanticGatewayChatResponse> {
    return new Promise(() => {
      /* never resolves — simulates an unresponsive endpoint for SG-5 */
    });
  }
}

/**
 * SG-5b: captures the `AbortSignal` handed to the port so the test can
 * assert it actually transitions to `aborted` when the timeout fires — not
 * just that the call rejects. A `Promise.race`-only implementation (the
 * earlier, abandoning version) rejects on timeout too, so a bare
 * "rejects with SemanticGatewayTimeoutError" assertion cannot distinguish
 * a real abort from an abandoned request. This port never resolves either,
 * so the ONLY way the call can settle is via the timeout path.
 */
class SignalCapturingHangingHttpPort implements SemanticGatewayHttpPort {
  capturedSignal: AbortSignal | undefined;
  async chatCompletion(request: SemanticGatewayChatRequest): Promise<SemanticGatewayChatResponse> {
    this.capturedSignal = request.signal;
    return new Promise(() => {
      /* never resolves */
    });
  }
}

class RejectingHttpPort implements SemanticGatewayHttpPort {
  async chatCompletion(): Promise<SemanticGatewayChatResponse> {
    throw new Error("upstream 500");
  }
}

function testConfig(overrides: Partial<SemanticGatewayConfig> = {}): SemanticGatewayConfig {
  return {
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4.7-flash",
    apiKeyEnvVar: "SDD_TEST_SYNTHETIC_KEY_VAR",
    timeoutMs: 8000,
    maxTokens: 512,
    ...overrides,
  };
}

async function runTests(): Promise<void> {
  console.log("--- sdd-semantic-gateway (RED-first) ---");

  // SG-1: the gateway issues requests against exactly the configured endpoint and model.
  {
    const config = testConfig({ endpoint: "https://example.invalid/chat", model: "some-model-x" });
    const port = new RecordingFakeHttpPort([{ content: "ok", reasoningContent: null }]);
    const env = { SDD_TEST_SYNTHETIC_KEY_VAR: "synthetic-key-1" };

    const result = await callSemanticGateway(port, config, "hello", env);

    assert.equal(result, "ok", "SG-1 returns the response content");
    assert.equal(port.calls.length, 1, "SG-1 issues exactly one request for a non-truncated response");
    assert.equal(port.calls[0]!.endpoint, "https://example.invalid/chat", "SG-1 endpoint matches config exactly");
    assert.equal(port.calls[0]!.model, "some-model-x", "SG-1 model matches config exactly");
  }
  console.log("  pass: SG-1 the gateway issues requests against exactly the configured endpoint and model");

  // SG-2: shipped defaults are the verified ones.
  {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const config = parseSemanticGatewayConfig(raw);

    assert.equal(config.endpoint, "https://open.bigmodel.cn/api/paas/v4/chat/completions", "SG-2 default endpoint");
    assert.equal(config.model, "glm-4.7-flash", "SG-2 default model");
    assert.equal(config.apiKeyEnvVar, "BIGMODEL_API_KEY", "SG-2 default apiKeyEnvVar");
    assert.equal(config.timeoutMs, 8000, "SG-2 default timeoutMs");
    assert.equal(config.maxTokens, 512, "SG-2 default maxTokens");
  }
  console.log("  pass: SG-2 shipped defaults are the verified ones");

  // SG-3: the API key is read from process.env[apiKeyEnvVar] at call time and
  // never appears in config, logs, or any persisted record.
  {
    const rawConfigFile = readFileSync(CONFIG_PATH, "utf8");
    const SYNTHETIC_KEY = "sk-synthetic-do-not-leak-8f2c91";
    assert.doesNotMatch(
      rawConfigFile,
      new RegExp(SYNTHETIC_KEY),
      "SG-3 the shipped config file never contains a key value (only apiKeyEnvVar, the name)",
    );
    assert.doesNotMatch(rawConfigFile, /apiKey"\s*:/, "SG-3 the config file has no apiKey field at all, only apiKeyEnvVar");

    const config = testConfig({ apiKeyEnvVar: "SDD_TEST_SYNTHETIC_KEY_VAR" });
    const port = new RecordingFakeHttpPort([{ content: "answer", reasoningContent: null }]);
    const env = { SDD_TEST_SYNTHETIC_KEY_VAR: SYNTHETIC_KEY };

    const originalLog = console.log;
    const originalError = console.error;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    let result: string;
    try {
      result = await callSemanticGateway(port, config, "hello", env);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    assert.equal(
      port.calls[0]!.apiKey,
      SYNTHETIC_KEY,
      "SG-3 the key actually used at call time is read from process.env[apiKeyEnvVar]",
    );
    const emittedText = captured.join("\n");
    assert.doesNotMatch(emittedText, new RegExp(SYNTHETIC_KEY), "SG-3 no console output from the gateway call contains the key value");
    assert.doesNotMatch(
      JSON.stringify({ config, result }),
      new RegExp(SYNTHETIC_KEY),
      "SG-3 no returned/persistable record (config or result) contains the key value",
    );
  }
  console.log("  pass: SG-3 the API key is read from process.env at call time and never appears in config, logs, or persisted records");

  // SG-4: an empty content with non-empty reasoning_content is treated as
  // truncation and retried with a larger budget, never returned as a valid
  // empty result.
  {
    const config = testConfig({ maxTokens: 5 });
    const port = new RecordingFakeHttpPort([
      { content: "", reasoningContent: "thinking really hard about this..." },
      { content: "the real answer", reasoningContent: "..." },
    ]);
    const env = { SDD_TEST_SYNTHETIC_KEY_VAR: "synthetic-key-2" };

    const result = await callSemanticGateway(port, config, "hello", env);

    assert.equal(result, "the real answer", "SG-4 the retried non-empty content is returned, never the truncated empty one");
    assert.equal(port.calls.length, 2, "SG-4 a truncated first response triggers exactly one retry");
    assert.ok(
      port.calls[1]!.maxTokens > port.calls[0]!.maxTokens,
      "SG-4 the retry uses a larger token budget than the first attempt",
    );
  }
  console.log("  pass: SG-4 an empty content with non-empty reasoning_content is treated as truncation and retried with a larger budget");

  // SG-4b: when the retry is STILL truncated (or empty), the gateway throws
  // SemanticGatewayTruncationError — never returning an empty content as a
  // valid answer. The earlier suite only exercised the retry-then-succeed
  // path; the throw branch (the load-bearing half of "never return empty as
  // valid") had no test and no constructed error anywhere.
  {
    const config = testConfig({ maxTokens: 5 });
    const port = new RecordingFakeHttpPort([
      { content: "", reasoningContent: "thinking..." },
      { content: "", reasoningContent: "still thinking, still truncated..." },
    ]);
    const env = { SDD_TEST_SYNTHETIC_KEY_VAR: "synthetic-key-2b" };

    await assert.rejects(
      () => callSemanticGateway(port, config, "hello", env),
      SemanticGatewayTruncationError,
      "SG-4b a retry that is still truncated throws SemanticGatewayTruncationError",
    );
    assert.equal(port.calls.length, 2, "SG-4b exactly one retry before giving up");
  }
  console.log("  pass: SG-4b a retry that remains truncated throws SemanticGatewayTruncationError");

  // SG-5: a timeout aborts and reports rather than hanging.
  {
    const config = testConfig({ timeoutMs: 30 });
    const port = new HangingHttpPort();
    const env = { SDD_TEST_SYNTHETIC_KEY_VAR: "synthetic-key-3" };

    await assert.rejects(
      () => callSemanticGateway(port, config, "hello", env),
      SemanticGatewayTimeoutError,
      "SG-5 a call that never resolves rejects with SemanticGatewayTimeoutError instead of hanging forever",
    );
  }
  console.log("  pass: SG-5 a timeout aborts and reports rather than hanging");

  // SG-5b: the port actually receives an AbortSignal that transitions to
  // `aborted` when the timeout fires — a real abort, not just a race that
  // abandons the in-flight request while it keeps running in the background.
  {
    const config = testConfig({ timeoutMs: 30 });
    const port = new SignalCapturingHangingHttpPort();
    const env = { SDD_TEST_SYNTHETIC_KEY_VAR: "synthetic-key-3b" };

    await assert.rejects(
      () => callSemanticGateway(port, config, "hello", env),
      SemanticGatewayTimeoutError,
      "SG-5b a hanging call still rejects with SemanticGatewayTimeoutError",
    );

    assert.ok(port.capturedSignal !== undefined, "SG-5b the port received a signal on the request");
    assert.equal(port.capturedSignal!.aborted, true, "SG-5b the signal transitions to aborted when the timeout fires");
  }
  console.log("  pass: SG-5b the port receives a signal that transitions to aborted when the timeout fires");

  // SG-6: a failed batchNotes distillation yields an empty note and the
  // batch proceeds (the wrapper never throws).
  {
    const config = testConfig();
    const port = new RejectingHttpPort();
    const env = { SDD_TEST_SYNTHETIC_KEY_VAR: "synthetic-key-4" };

    const note = await distillBatchNote(port, config, "summarize this batch", env);

    assert.equal(note, "", "SG-6 a failed distillation call yields an empty note rather than throwing");
  }
  console.log("  pass: SG-6 a failed batchNotes distillation yields an empty note and the batch proceeds");

  console.log("All sdd-semantic-gateway tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
