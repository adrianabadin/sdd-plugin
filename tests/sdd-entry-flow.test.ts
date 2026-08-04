/**
 * WU10 — EF-1 through EF-21: Entry flow unit tests.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-entry-flow`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§3, §8).
 */

import assert from "node:assert/strict";

import {
  sddParseRequest,
  deriveChangeName,
  resolveChangeName,
  runPreflightProbe,
  resolveModelPhraseAndFormatGrammar,
  runSddGo,
  GatewayTimeoutError,
} from "../src/application/sdd/entry-flow.js";
import type { ParsedRequest } from "../src/domain/sdd/entry-flow.js";
import { sddHealthKey } from "../src/domain/sdd/sdd-keys.js";
import type { CheckpointRecord, CheckpointWriteResult, SddArtifactStorePort } from "../src/ports/sdd-artifact-store.port.js";
import {
  RouteUnknownError,
  RouteAmbiguousError,
} from "../src/domain/model-routing/model-route-resolver.js";
import { QuarantinedModelError } from "../src/infrastructure/opencode/model-route-task-hook.js";

/** In-memory mock for SddArtifactStorePort */
class MockArtifactStore implements SddArtifactStorePort {
  public storage = new Map<string, string>();
  public writeCount = new Map<string, number>();
  public checkpoints = new Map<string, { content: unknown; version: number }>();
  private nextVersion = 1;

  async writeArtifact(key: string, content: string): Promise<void> {
    this.storage.set(key, content);
    this.writeCount.set(key, (this.writeCount.get(key) ?? 0) + 1);
  }

  async readArtifact(key: string): Promise<string | null> {
    return this.storage.get(key) ?? null;
  }

  async writeCheckpoint(key: string, content: unknown): Promise<CheckpointWriteResult> {
    const version = this.nextVersion++;
    this.checkpoints.set(key, { content, version });
    return { version };
  }

  async readCheckpoint(key: string): Promise<CheckpointRecord | null> {
    const val = this.checkpoints.get(key);
    return val ? { content: val.content, version: val.version } : null;
  }
  /** Final-review finding #3 — stub for the atomic persist seam. */
  async persistArtifactWithOwnership(): Promise<never> {
    throw new Error("MockArtifactStore.persistArtifactWithOwnership is not exercised by these tests");
  }
}

/** Mock for store that fails readback */
class FailingReadbackStore implements SddArtifactStorePort {
  async writeArtifact(_key: string, _content: string): Promise<void> {
    // Write succeeds silently or drops
  }

  async readArtifact(_key: string): Promise<string | null> {
    // Returns corrupt/mismatched content
    return "corrupt-content";
  }

  async writeCheckpoint(_key: string, _content: unknown): Promise<CheckpointWriteResult> {
    return { version: 1 };
  }

  async readCheckpoint(_key: string): Promise<CheckpointRecord | null> {
    // Returns corrupt/mismatched content
    return { content: "corrupt-content", version: 1 };
  }
  /** Final-review finding #3 — stub for the atomic persist seam. */
  async persistArtifactWithOwnership(): Promise<never> {
    throw new Error("FailingReadbackStore.persistArtifactWithOwnership is not exercised by these tests");
  }
}

async function runTests(): Promise<void> {
  console.log("--- sdd-entry-flow (WU10 tasks EF-1 to EF-21) ---");

  // EF-1: A request naming a model yields all three parse fields
  {
    const req = "Quiero crear un Hello world en java usando sdd y el modelo gemini flash 3.6 tiered";
    const res = await sddParseRequest(req);
    assert.equal(res.explicitSddMention, true, "EF-1 explicitSddMention is true");
    assert.equal(res.modelPhrase, "gemini flash 3.6 tiered", "EF-1 modelPhrase extracted as written");
    assert.equal(res.taskDescription, "Hello world en java", "EF-1 taskDescription extracted without boilerplate");
  }
  console.log("  pass: EF-1 request naming model yields taskDescription, modelPhrase, and explicitSddMention=true");

  // EF-2: A request naming no model yields modelPhrase: null
  {
    const req = "Quiero crear un Hello world en java usando sdd";
    const res = await sddParseRequest(req);
    assert.equal(res.explicitSddMention, true, "EF-2 explicitSddMention is true");
    assert.equal(res.modelPhrase, null, "EF-2 modelPhrase is null when omitted");
    assert.equal(res.taskDescription, "Hello world en java", "EF-2 taskDescription extracted");
  }
  console.log("  pass: EF-2 request naming no model yields modelPhrase: null");

  // EF-3: A request with no SDD mention yields explicitSddMention: false
  {
    const req = "Quiero crear un Hello world en java";
    const res = await sddParseRequest(req);
    assert.equal(res.explicitSddMention, false, "EF-3 explicitSddMention is false");
  }
  console.log("  pass: EF-3 request with no SDD mention yields explicitSddMention: false");

  // EF-4: A gateway call that HANGS (never resolves) is bounded by `timeoutMs`
  // and fails loud with GatewayTimeoutError, with no secondary provider
  // attempted. The earlier test passed a service whose `parse` THREW
  // synchronously — that never exercised the timeout: `sddParseRequest` only
  // caught the throw and re-wrapped it, and `timeoutMs` was accepted but never
  // read. A real hang must be cut off by the timeout, not by a throw.
  {
    let parseStarted = false;
    const hangingService = {
      parse(): Promise<ParsedRequest> {
        parseStarted = true;
        // Never resolves, never rejects — simulates a genuinely hung gateway.
        return new Promise<ParsedRequest>(() => {});
      },
    };

    const start = Date.now();
    await assert.rejects(
      async () => {
        await sddParseRequest("crear app con sdd", { service: hangingService, timeoutMs: 80 });
      },
      (err: unknown) => err instanceof GatewayTimeoutError,
      "EF-4 a hanging gateway call rejects with GatewayTimeoutError",
    );
    const elapsed = Date.now() - start;
    assert.ok(parseStarted, "EF-4 the gateway parse was actually invoked");
    assert.ok(elapsed < 1000, `EF-4 the timeout fired within the bound (elapsed=${elapsed}ms), not after a long hang`);
  }
  console.log("  pass: EF-4 a hanging gateway call is cut off by timeoutMs and fails loud (no secondary provider)");

  // EF-5: changeName is a deterministic slug of taskDescription
  {
    const slug1 = deriveChangeName("Hello world en java");
    const slug2 = deriveChangeName("Hello world en java");
    assert.equal(slug1, "hello-world-java", "EF-5 slug derived cleanly");
    assert.equal(slug1, slug2, "EF-5 deterministic output for same input");
  }
  console.log("  pass: EF-5 changeName is a deterministic slug of taskDescription");

  // EF-6: An unambiguous existing change name is reused
  {
    const existing = [{ changeName: "hello-world-java" }, { changeName: "other-change" }];
    const res = resolveChangeName("hello-world-java", existing);
    assert.equal(res.reused, true, "EF-6 unambiguous change reused");
    assert.equal(res.changeName, "hello-world-java", "EF-6 returns matching existing changeName");
  }
  console.log("  pass: EF-6 unambiguous existing change name is reused");

  // EF-7: An ambiguous collision asks rather than guessing
  {
    const existing = [
      { changeName: "hello-world-java" },
      { changeName: "hello-world-java-2" },
      { changeName: "hello-world-java" },
    ];
    const res = resolveChangeName("hello-world-java", existing);
    assert.equal(res.askUser, true, "EF-7 asks user on ambiguous collision");
    assert.ok(res.candidates && res.candidates.length >= 2, "EF-7 surfaces candidates list");
  }
  console.log("  pass: EF-7 ambiguous collision asks user rather than guessing");

  // EF-8: explicitSddMention: false refuses the run
  {
    const res = await runSddGo({
      requestText: "crear una api rest en python", // No SDD mention
      projectRoot: "/projects/my-app",
      projectRootHash: "hash123",
      store: new MockArtifactStore(),
      initialized: true,
    });
    assert.equal(res.action, "refused", "EF-8 run refused");
    assert.equal(res.reason, "No explicit SDD mention", "EF-8 refusal reason specified");
  }
  console.log("  pass: EF-8 explicitSddMention: false refuses the run");

  // EF-9: Gates evaluate in order and the first failure stops the run with no later side effects
  {
    const store = new MockArtifactStore();
    const evaluationTrace: string[] = [];

    const res = await runSddGo({
      requestText: "crear app", // Gate 1 fails: no SDD mention
      projectRoot: "/projects/my-app",
      projectRootHash: "hash123",
      store,
      initialized: false, // Would fail Gate 2, but Gate 1 fails first
      onGateEvaluated: (gateName) => evaluationTrace.push(gateName),
    });

    assert.equal(res.action, "refused", "EF-9 stopped on first gate failure");
    assert.deepEqual(evaluationTrace, ["explicitSddMention"], "EF-9 evaluated only first gate before stopping");
    assert.equal(store.storage.size, 0, "EF-9 no side effects performed after early exit");
  }
  console.log("  pass: EF-9 gates evaluate in order and first failure stops run with no later side effects");

  // EF-10: /sdd-go only routes; it never edits or implements
  {
    const store = new MockArtifactStore();
    const res = await runSddGo({
      requestText: "crear app usando sdd",
      projectRoot: "/projects/my-app",
      projectRootHash: "hash123",
      store,
      initialized: true,
      defaultModel: "claude-3-5-sonnet",
    });

    assert.equal(res.action, "route", "EF-10 returns routing action");
    assert.ok(res.subagentType, "EF-10 specifies subagentType for routing");
    assert.equal(res.editedFiles, undefined, "EF-10 performs no file edits");
  }
  console.log("  pass: EF-10 /sdd-go only routes, never edits or implements");

  // EF-11: A resolvable alias produces a canonical reference and dispatches
  {
    const mockResolver = {
      async resolve(phrase: string) {
        if (phrase === "gemini flash 3.6 tiered") return { providerId: "google", modelId: "gemini-2.5-flash" };
        throw new RouteUnknownError(phrase);
      },
    };

    const res = await resolveModelPhraseAndFormatGrammar("gemini flash 3.6 tiered", mockResolver, "default-model");
    assert.equal(res.canonicalRef, "google/gemini-2.5-flash", "EF-11 canonical ref produced");
    assert.equal(res.subagentType, "model-route:v1|sdd-mr-base|google/gemini-2.5-flash", "EF-11 grammar formatted");
  }
  console.log("  pass: EF-11 resolvable alias produces canonical reference and dispatches");

  // EF-12: RouteUnknownError becomes a blockedOn question, not an abort
  {
    const mockResolver = {
      async resolve(phrase: string) {
        throw new RouteUnknownError(phrase);
      },
    };

    const res = await resolveModelPhraseAndFormatGrammar("gemini 3.6", mockResolver, "default-model");
    assert.ok("blockedOn" in res, "EF-12 enters blockedOn state");
    assert.ok(res.blockedOn, "EF-12 blockedOn is present");
    assert.ok(res.blockedOn.question.includes("gemini 3.6"), "EF-12 question names unknown model phrase");
  }
  console.log("  pass: EF-12 RouteUnknownError becomes a blockedOn question");

  // EF-13: RouteAmbiguousError surfaces the resolver's candidate list
  {
    const mockResolver = {
      async resolve(phrase: string) {
        throw new RouteAmbiguousError(phrase, [
          { providerId: "google", modelId: "gemini-1.5-flash", modelName: "Flash 1.5" },
          { providerId: "google", modelId: "gemini-2.5-flash", modelName: "Flash 2.5" },
        ]);
      },
    };

    const res = await resolveModelPhraseAndFormatGrammar("gemini flash", mockResolver, "default-model");
    assert.ok("blockedOn" in res, "EF-13 enters blockedOn state");
    assert.ok(res.blockedOn, "EF-13 blockedOn is present");
    assert.ok(res.blockedOn.question.includes("gemini-1.5-flash"), "EF-13 surfaces candidate 1");
    assert.ok(res.blockedOn.question.includes("gemini-2.5-flash"), "EF-13 surfaces candidate 2");
  }
  console.log("  pass: EF-13 RouteAmbiguousError surfaces candidate list");

  // EF-14: QuarantinedModelError takes the same blockedOn path
  {
    const mockResolver = {
      async resolve(phrase: string) {
        throw new QuarantinedModelError(`Model ${phrase} is quarantined`);
      },
    };

    const res = await resolveModelPhraseAndFormatGrammar("quarantined-model", mockResolver, "default-model");
    assert.ok("blockedOn" in res, "EF-14 enters blockedOn state");
    assert.ok(res.blockedOn, "EF-14 blockedOn is present");
    assert.ok(res.blockedOn.question.includes("quarantined"), "EF-14 question mentions quarantine");
  }
  console.log("  pass: EF-14 QuarantinedModelError takes blockedOn path");

  // EF-15: An unnamed model still dispatches through grammar with configured default inside it
  {
    const mockResolver = {
      async resolve() {
        throw new Error("Resolver should not be called for null phrase");
      },
    };

    const res = await resolveModelPhraseAndFormatGrammar(null, mockResolver, "anthropic/claude-3-5-sonnet");
    assert.equal(res.subagentType, "model-route:v1|sdd-mr-base|anthropic/claude-3-5-sonnet", "EF-15 uses explicit grammar with default model");
    assert.notEqual(res.subagentType, "sdd-mr-base", "EF-15 never emits bare subagent_type");
  }
  console.log("  pass: EF-15 unnamed model dispatches through explicit grammar with configured default");

  // EF-16: An unbootstrapped project is refused with the exact command named, never auto-bootstrapped
  {
    const store = new MockArtifactStore();
    const res = await runPreflightProbe("/projects/unbootstrapped", "hash_unboot", store, { initialized: false });
    assert.equal(res.refused, true, "EF-16 unbootstrapped project refused");
    assert.ok(res.reason, "EF-16 refusal carries a reason");
    assert.ok(
      res.reason.includes("pmc init") || res.reason.includes("map-project"),
      "EF-16 names exact command to run (pmc init / map-project)",
    );
  }
  console.log("  pass: EF-16 unbootstrapped project refused with exact command named");

  // EF-17: A failed store probe refuses the run
  {
    const failingStore = new FailingReadbackStore();
    const res = await runPreflightProbe("/projects/app", "hash_app", failingStore, { initialized: true });
    assert.equal(res.refused, true, "EF-17 failed store probe refuses run");
    assert.ok(res.reason, "EF-17 refusal carries a reason");
    assert.ok(res.reason.includes("store"), "EF-17 names store probe failure");
  }
  console.log("  pass: EF-17 failed store probe refuses the run");

  // EF-18: An unreachable gateway degrades (direct questions, batchNotes disabled)
  {
    const store = new MockArtifactStore();
    const res = await runPreflightProbe("/projects/app", "hash_app", store, {
      initialized: true,
      gatewayReachable: false,
    });
    assert.equal(res.refused, false, "EF-18 does not refuse run");
    assert.equal(res.degradedGateway, true, "EF-18 marks degraded gateway");
    assert.equal(res.batchNotesDisabled, true, "EF-18 disables batchNotes");
    assert.equal(res.directQuestions, true, "EF-18 enables direct questions");
  }
  console.log("  pass: EF-18 unreachable gateway degrades run instead of refusing");

  // EF-19: Unavailable pmc_get_context degrades to plain reads
  {
    const store = new MockArtifactStore();
    const res = await runPreflightProbe("/projects/app", "hash_app", store, {
      initialized: true,
      pmcContextAvailable: false,
    });
    assert.equal(res.refused, false, "EF-19 does not refuse run");
    assert.equal(res.degradedPmcContext, true, "EF-19 marks degraded PMC context");
    assert.equal(res.plainReads, true, "EF-19 sets plainReads mode");
  }
  console.log("  pass: EF-19 unavailable pmc_get_context degrades to plain reads");

  // EF-20: The health probe performs a write-then-read-back, declaring healthy only on content match
  {
    const store = new MockArtifactStore();
    const hash = "hash_probe_20";
    const res = await runPreflightProbe("/projects/app", hash, store, { initialized: true });

    assert.equal(res.healthy, true, "EF-20 probe declares healthy on content match");
    const writtenKey = sddHealthKey(hash);
    const storedVal = await store.readArtifact(writtenKey);
    assert.ok(storedVal !== null && storedVal.length > 0, "EF-20 record was written and read back");
  }
  console.log("  pass: EF-20 health probe performs write-then-read-back and requires content match");

  // EF-21: The health probe overwrites one fixed key rather than accumulating
  {
    const store = new MockArtifactStore();
    const hash = "hash_probe_21";
    const healthKey = sddHealthKey(hash);

    await runPreflightProbe("/projects/app", hash, store, { initialized: true });
    await runPreflightProbe("/projects/app", hash, store, { initialized: true });
    await runPreflightProbe("/projects/app", hash, store, { initialized: true });

    assert.equal(store.writeCount.get(healthKey), 3, "EF-21 wrote 3 times to same key");
    let totalHealthKeys = 0;
    for (const key of store.storage.keys()) {
      if (key.startsWith("sdd-health/")) totalHealthKeys++;
    }
    assert.equal(totalHealthKeys, 1, "EF-21 only 1 health key exists in storage");
  }
  console.log("  pass: EF-21 health probe overwrites single fixed key without accumulating");
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
