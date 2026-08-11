/**
 * PR3 Phase 3 — TUI Quarantine overlay (pure / Node) tests.
 *
 * The Bun renderer tests for the same scope live in
 * `tests/tui-quarantine-overlay.bun.test.ts` (keymap + openTUI testRender).
 * This file proves the pure contracts that the screen, the overlay
 * state, and the use-case dispatch rely on:
 *
 *   1. `deriveQuarantineView` exposes the trimmed reason on each item
 *      without changing the active/expired sort or the level precedence
 *      (provider > model > modelProvider).
 *   2. The overlay state factories produce a well-formed QuarantineDraft
 *      and route text buffers through the shared typed field accept/parse
 *      contract so the active capture layer does not have to special-case
 *      per-field logic.
 *   3. Building a QuarantineDraft from an overlay state fails fast on
 *      blank reason / invalid TTL so the PR2 readback gate is the only
 *      failure path that can reach `setQuarantineUseCase.submitDraft`.
 *   4. The `submitDraft` and `releaseFromTarget` convenience methods on
 *      the PR2 use cases dispatch through the constructor verifier and
 *      honor the readback gate end-to-end.
 */
import assert from "node:assert/strict";
import {
  deriveQuarantineView,
  type QuarantineItemView,
} from "../src/tui/quarantine-view.js";
import {
  type QuarantineOverlayState,
  type QuarantineOverlayFocus,
  createQuarantineOverlay,
  buildQuarantineDraft,
  buildQuarantineDraftFromCandidate,
  buildQuarantineTarget,
  validateQuarantineOverlayBuffers,
  updateQuarantineOverlayBuffer,
  updateQuarantineOverlayFilter,
  setQuarantineOverlayFocus,
  setQuarantineOverlayLevel,
  cycleQuarantineOverlayLevel,
  resolveQuarantineCandidates,
  isCandidateShadowed,
} from "../src/tui/quarantine-overlay.js";
import { resolveQuarantinePrecedence, type QuarantineEntry, type QuarantineTarget, type QuarantineDraft } from "../src/domain/model/quarantine.js";
import {
  SetQuarantineUseCase,
  ReleaseQuarantineUseCase,
} from "../src/application/quarantine/index.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../src/ports/quarantine-write.port.js";
import type { QuarantineQueryPort, PersistedQuarantine } from "../src/ports/quarantine-query.port.js";
import { QuarantineStoreImpl } from "../src/infrastructure/runtime/quarantine-store.js";

console.log("--- PR3 Phase 3: TUI Quarantine overlay (pure) tests ---");

function testDeriveQuarantineViewReason(): void {
  console.log("\n--- deriveQuarantineView surfaces the trimmed reason ---");
  const baseDate = new Date("2026-07-21T12:00:00.000Z");
  const futureDate = new Date("2026-07-21T12:30:00.000Z");
  const entries: QuarantineEntry[] = [
    {
      level: "provider",
      providerId: "anthropic",
      type: "permanent",
      reason: "  vendor incident  ",
    },
    {
      level: "model",
      modelId: "claude-3-5-sonnet",
      type: "ttl",
      until: futureDate,
      reason: "rate limit",
    },
    {
      level: "modelProvider",
      providerId: "openai",
      modelId: "gpt-4o",
      type: "ttl",
      until: futureDate,
      reason: null,
    },
  ];

  const view = deriveQuarantineView(entries, baseDate);

  // Reason is surfaced for every item that has one (trimmed, non-empty).
  const provider = view.items.find((item) => item.level === "provider");
  const model = view.items.find((item) => item.level === "model");
  const connection = view.items.find((item) => item.level === "modelProvider");
  assert.ok(provider);
  assert.ok(model);
  assert.ok(connection);
  assert.equal(provider!.reasonLabel, "vendor incident", "provider reason is trimmed and surfaced");
  assert.equal(model!.reasonLabel, "rate limit", "model reason is surfaced");
  assert.equal(connection!.reasonLabel, null, "missing reason stays null (no fabricated text)");

  // Active/expired sort is preserved: active items first, then level precedence.
  const activeFirst = view.items.filter((item) => item.isActive);
  const inactiveLast = view.items.filter((item) => !item.isActive);
  assert.equal(
    view.items[0],
    activeFirst[0] ?? null,
    "active items are sorted before expired items",
  );

  // Provider > model > modelProvider precedence is unchanged.
  const levelOrder = view.items
    .filter((item) => item.isActive)
    .map((item) => item.level);
  assert.deepEqual(
    levelOrder,
    ["provider", "model", "modelProvider"],
    "active items are ordered provider, model, modelProvider",
  );
}

function testOverlayStateFactory(): void {
  console.log("\n--- QuarantineOverlayState factory defaults ---");
  const overlay = createQuarantineOverlay("create");
  assert.equal(overlay.mode, "create");
  assert.equal(overlay.level, "provider");
  assert.equal(overlay.providerIdBuffer, "");
  assert.equal(overlay.modelIdBuffer, "");
  assert.equal(overlay.reasonBuffer, "");
  assert.equal(overlay.durationKind, "permanent");
  assert.equal(overlay.ttlHoursBuffer, "");
  assert.equal(overlay.focus, "id");
  assert.equal(overlay.targetIndex, undefined, "create overlay has no target index");

  const modify = createQuarantineOverlay("modify", 2);
  assert.equal(modify.mode, "modify");
  assert.equal(modify.targetIndex, 2, "modify overlay carries the target index");

  const release = createQuarantineOverlay("release", 5);
  assert.equal(release.mode, "release");
  assert.equal(release.targetIndex, 5);
  assert.equal(release.reasonBuffer, "", "release overlay has no editable buffers");
  assert.equal(release.ttlHoursBuffer, "", "release overlay has no TTL buffer");
}

function testOverlayBufferAcceptContract(): void {
  console.log("\n--- overlay buffer accept/parse contract (shared typed editor) ---");
  const overlay = createQuarantineOverlay("create");

  // Reason field: text accept, blank rejected on parse.
  const reasonAccept = updateQuarantineOverlayBuffer(overlay, "reason", "X");
  assert.equal(reasonAccept.reasonBuffer, "X", "reason buffer accepts printable input");
  const blankReason = updateQuarantineOverlayBuffer(
    createQuarantineOverlay("create"),
    "reason",
    "   ",
  );
  assert.equal(
    blankReason.reasonBuffer,
    "   ",
    "reason buffer keeps the typed value (parse step rejects blanks, not accept)",
  );

  // TTL hours field: numeric buffer — digits + a single decimal.
  let numericOverlay = updateQuarantineOverlayBuffer(overlay, "ttlHours", "1");
  numericOverlay = updateQuarantineOverlayBuffer(numericOverlay, "ttlHours", "2");
  numericOverlay = updateQuarantineOverlayBuffer(numericOverlay, "ttlHours", ".");
  numericOverlay = updateQuarantineOverlayBuffer(numericOverlay, "ttlHours", ".");
  numericOverlay = updateQuarantineOverlayBuffer(numericOverlay, "ttlHours", "5");
  assert.equal(
    numericOverlay.ttlHoursBuffer,
    "12.5",
    "TTL hours buffer accepts digits + a single decimal (rejects the second decimal)",
  );

  // ID buffer: text accept, no auto-trim during typing.
  const idOverlay = updateQuarantineOverlayBuffer(overlay, "providerId", "  openai  ");
  assert.equal(
    idOverlay.providerIdBuffer,
    "  openai  ",
    "id buffer preserves the typed value verbatim (trim is the parse step's job)",
  );

  // Focus navigation moves between allowed focus slots.
  const focused = setQuarantineOverlayFocus(overlay, "duration");
  assert.equal(focused.focus, "duration");
  const focusedReason = setQuarantineOverlayFocus(focused, "reason");
  assert.equal(focusedReason.focus, "reason");

  // Validate the buffers honor the PR1 quarantine-draft contract: empty
  // reason is a validation failure (no DB write), invalid TTL is a
  // validation failure (no DB write).
  const blankReasonOverlay: QuarantineOverlayState = {
    ...overlay,
    providerIdBuffer: "openai",
    reasonBuffer: "",
  };
  const blankReasonDraft = buildQuarantineDraft(blankReasonOverlay);
  const invalidDraft = validateQuarantineOverlayBuffers(blankReasonDraft);
  assert.equal(invalidDraft.ok, false, "blank reason fails the buffer validation");
  assert.match(invalidDraft.error ?? "", /reason/i, "validation error names the reason field");

  const invalidTtlOverlay: QuarantineOverlayState = {
    ...overlay,
    providerIdBuffer: "openai",
    reasonBuffer: "incident",
    durationKind: "ttl",
    ttlHoursBuffer: "0",
  };
  const invalidTtl = validateQuarantineOverlayBuffers(buildQuarantineDraft(invalidTtlOverlay));
  assert.equal(invalidTtl.ok, false, "zero-hour TTL fails the buffer validation");

  const validOverlay: QuarantineOverlayState = {
    ...overlay,
    providerIdBuffer: "openai",
    reasonBuffer: "  vendor incident  ",
    durationKind: "ttl",
    ttlHoursBuffer: "2.5",
  };
  const validDraft = validateQuarantineOverlayBuffers(buildQuarantineDraft(validOverlay));
  assert.equal(validDraft.ok, true, "trimmed non-empty reason + positive finite TTL is valid");
  if (validDraft.ok) {
    assert.equal(validDraft.draft.reason, "vendor incident", "reason is trimmed by the builder");
    assert.equal(validDraft.draft.providerId, "openai");
    assert.equal(validDraft.draft.duration.kind, "ttl");
    if (validDraft.draft.duration.kind === "ttl") {
      assert.equal(validDraft.draft.duration.hours, 2.5, "TTL hours is parsed as a finite number");
    }
  }

  // buildQuarantineDraft must fail closed (no fabricated identifiers).
  const modelOverlay: QuarantineOverlayState = {
    ...overlay,
    level: "model",
    modelIdBuffer: "  gpt-4o  ",
    reasonBuffer: "deprecated",
  };
  const modelDraft = buildQuarantineDraft(modelOverlay);
  assert.equal(modelDraft.level, "model");
  assert.equal(modelDraft.modelId, "gpt-4o");
  assert.equal(modelDraft.reason, "deprecated");
}

function testSubmitDraftDispatchesThroughVerifier(): Promise<void> {
  console.log("\n--- SetQuarantineUseCase.submitDraft dispatches through the constructor verifier ---");
  const calls: SetQuarantineCommand[] = [];
  let verifierCalls = 0;

  class StubWritePort implements QuarantineWritePort {
    async setQuarantine(cmd: SetQuarantineCommand): Promise<QuarantineEntry> {
      calls.push(cmd);
      return {
        level: cmd.level,
        providerId: cmd.providerId,
        modelId: cmd.modelId,
        type: cmd.type,
        until: cmd.until ?? null,
        reason: cmd.reason ?? null,
      };
    }
    async releaseQuarantine(_target: QuarantineTarget): Promise<void> {}
    async listQuarantines(): Promise<QuarantineEntry[]> {
      return [];
    }
  }

  class StubVerifier implements QuarantineQueryPort {
    async findQuarantine(target: QuarantineTarget): Promise<PersistedQuarantine | null> {
      verifierCalls++;
      const persisted = calls.find(
        (cmd) =>
          cmd.level === target.level &&
          cmd.providerId === target.providerId &&
          cmd.modelId === target.modelId,
      );
      if (!persisted) return null;
      return {
        level: persisted.level,
        providerId: persisted.providerId,
        modelId: persisted.modelId,
        type: persisted.type,
        until: persisted.until ?? null,
        reason: persisted.reason ?? null,
      };
    }
  }

  const writePort = new StubWritePort();
  const verifier = new StubVerifier();
  const store = new QuarantineStoreImpl();
  const useCase = new SetQuarantineUseCase(writePort, verifier, store);

  const overlay = createQuarantineOverlay("create");
  const draft: QuarantineDraft = {
    level: "provider",
    providerId: "openai",
    reason: "rate limit",
    duration: { kind: "permanent" },
  };
  return useCase.submitDraft(draft).then((entry) => {
    assert.equal(calls.length, 1, "submitDraft performs exactly one write");
    assert.equal(verifierCalls, 1, "submitDraft performs exactly one verifier readback");
    assert.equal(entry.level, "provider");
    assert.equal(entry.reason, "rate limit", "submitted entry carries the trimmed reason");
    assert.equal(store.snapshot().length, 1, "store publish happens only after readback");
    void overlay;
  });
}

function testReleaseFromTargetUsesVerifier(): Promise<void> {
  console.log("\n--- ReleaseQuarantineUseCase.releaseFromTarget uses the constructor verifier ---");
  let writeCalls = 0;
  let verifierCalls = 0;

  class StubWritePort implements QuarantineWritePort {
    async setQuarantine(): Promise<QuarantineEntry> {
      throw new Error("not used");
    }
    async releaseQuarantine(_target: QuarantineTarget): Promise<void> {
      writeCalls++;
    }
    async listQuarantines(): Promise<QuarantineEntry[]> {
      return [];
    }
  }

  class StubVerifier implements QuarantineQueryPort {
    async findQuarantine(): Promise<PersistedQuarantine | null> {
      verifierCalls++;
      return null;
    }
  }

  const writePort = new StubWritePort();
  const verifier = new StubVerifier();
  const store = new QuarantineStoreImpl();
  store.publish({
    level: "provider",
    providerId: "openai",
    type: "permanent",
    until: null,
    reason: "to be released",
  });
  const useCase = new ReleaseQuarantineUseCase(writePort, verifier, store);

  return useCase
    .releaseFromTarget({ level: "provider", providerId: "openai" })
    .then(() => {
      assert.equal(writeCalls, 1, "releaseFromTarget performs exactly one write");
      assert.equal(verifierCalls, 1, "releaseFromTarget performs exactly one verifier readback");
      assert.equal(store.snapshot().length, 0, "store release happens only after readback confirms absence");
    });
}

function testResolveCandidatesFromSnapshot(): void {
  console.log("\n--- T1: create overlay candidate set is the catalog snapshot only ---");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    },
    {
      providerId: "anthropic",
      modelId: "claude-3-5-sonnet",
      modelName: "Claude 3.5 Sonnet",
      provider: { isBlocked: false },
    },
  ] as unknown as Parameters<typeof resolveQuarantineCandidates>[1];

  const overlayProvider = createQuarantineOverlay("create"); // default level: "provider"
  const candidatesProvider = resolveQuarantineCandidates(overlayProvider, models);
  assert.equal(candidatesProvider.length, 2, "returns candidates for connected providers");
  assert.equal(candidatesProvider[0]?.kind, "provider");
  assert.equal(candidatesProvider[0]?.providerId, "anthropic"); // sorted ascending
  assert.equal(candidatesProvider[1]?.providerId, "openai");

  const overlayModel = { ...overlayProvider, level: "modelProvider" as const };
  const candidatesModel = resolveQuarantineCandidates(overlayModel, models);
  assert.equal(candidatesModel.length, 2, "returns candidates for connected models");
  assert.equal(candidatesModel[0]?.kind, "modelProvider");
}

function testDisconnectedProviderExcluded(): void {
  console.log("\n--- T2: disconnected provider is not selectable ---");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    },
  ] as unknown as Parameters<typeof resolveQuarantineCandidates>[1];

  const overlayProvider = createQuarantineOverlay("create");
  const candidatesProvider = resolveQuarantineCandidates(overlayProvider, models);
  assert.equal(candidatesProvider.length, 1);
  assert.equal(candidatesProvider.find((c) => c.providerId === "anthropic"), undefined, "disconnected provider anthropic is not present in candidates");
}

function testBuildDraftFromProviderCandidate(): void {
  console.log("\n--- T3: Operator selects provider mode and confirms ---");
  const overlay = {
    ...createQuarantineOverlay("create"),
    reasonBuffer: "  high error rate  ",
    durationKind: "permanent" as const,
  };
  const candidate = {
    kind: "provider" as const,
    providerId: "openai",
    modelCount: 3,
  };

  const draft = buildQuarantineDraftFromCandidate(overlay, candidate);
  assert.equal(draft.level, "provider");
  assert.equal(draft.providerId, "openai");
  assert.equal(draft.reason, "high error rate");
  assert.equal(draft.duration.kind, "permanent");

  const validated = validateQuarantineOverlayBuffers(draft);
  assert.equal(validated.ok, true);
}

function testBuildDraftFromModelProviderCandidate(): void {
  console.log("\n--- T4: Operator selects provider-model mode and confirms ---");
  const overlay = {
    ...createQuarantineOverlay("create"),
    level: "modelProvider" as const,
    reasonBuffer: "  model specific issue  ",
    durationKind: "permanent" as const,
  };
  const candidate = {
    kind: "modelProvider" as const,
    providerId: "openai",
    modelId: "gpt-4o",
    modelName: "GPT-4o",
  };

  const draft = buildQuarantineDraftFromCandidate(overlay, candidate);
  assert.equal(draft.level, "modelProvider");
  assert.equal(draft.providerId, "openai");
  assert.equal(draft.modelId, "gpt-4o");
  assert.equal(draft.reason, "model specific issue");
  assert.equal(draft.duration.kind, "permanent");

  const validated = validateQuarantineOverlayBuffers(draft);
  assert.equal(validated.ok, true);

  // Also test modify overlay with modelProvider level in buildQuarantineDraft
  const modifyOverlay: QuarantineOverlayState = {
    ...createQuarantineOverlay("modify", 0),
    level: "modelProvider",
    providerIdBuffer: "openai",
    modelIdBuffer: "gpt-4o",
    reasonBuffer: "modify reason",
  };
  const modifyDraft = buildQuarantineDraft(modifyOverlay);
  assert.equal(modifyDraft.level, "modelProvider");
  assert.equal(modifyDraft.providerId, "openai");
  assert.equal(modifyDraft.modelId, "gpt-4o");
}

function testProviderModelNotGlobalModelRule(): void {
  console.log("\n--- T5: Provider-model mode is not a global model rule ---");
  const candidate = {
    kind: "modelProvider" as const,
    providerId: "openai",
    modelId: "gpt-4o",
    modelName: "GPT-4o",
  };
  const overlay = {
    ...createQuarantineOverlay("create"),
    level: "modelProvider" as const,
    reasonBuffer: "model specific",
  };
  const draft = buildQuarantineDraftFromCandidate(overlay, candidate);
  assert.equal(draft.level, "modelProvider");
  assert.equal(draft.providerId, "openai");
  assert.equal(draft.modelId, "gpt-4o");

  const entryModelProvider: QuarantineEntry = {
    level: "modelProvider",
    providerId: draft.providerId,
    modelId: draft.modelId,
    type: "permanent",
    reason: draft.reason,
  };
  const entryGlobalModel: QuarantineEntry = {
    level: "model",
    modelId: "gpt-4o",
    type: "permanent",
    reason: "global model block",
  };
  const entryProvider: QuarantineEntry = {
    level: "provider",
    providerId: "openai",
    type: "permanent",
    reason: "provider block",
  };

  const resolved = resolveQuarantinePrecedence([entryModelProvider, entryGlobalModel, entryProvider], "openai", "gpt-4o");
  assert.equal(resolved?.level, "provider", "provider block takes precedence over model and modelProvider");

  // Check candidate shadowing
  const shadowedByProvider = isCandidateShadowed(candidate, [entryProvider]);
  assert.equal(shadowedByProvider, true, "candidate is shadowed by provider rule");

  const shadowedByModel = isCandidateShadowed(candidate, [entryGlobalModel]);
  assert.equal(shadowedByModel, true, "candidate is shadowed by global model rule");

  const shadowedBySelf = isCandidateShadowed(candidate, [entryModelProvider]);
  assert.equal(shadowedBySelf, false, "candidate is not shadowed by its own level");
}

function testFilterNarrowsCandidates(): void {
  console.log("\n--- T6: Typing narrows the candidate list ---");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    },
    {
      providerId: "anthropic",
      modelId: "claude-3-5-sonnet",
      modelName: "Claude 3.5 Sonnet",
      provider: { isBlocked: false },
    },
  ] as unknown as Parameters<typeof resolveQuarantineCandidates>[1];

  let overlay: QuarantineOverlayState = {
    ...createQuarantineOverlay("create"),
    level: "modelProvider",
    candidateIndex: 1,
  };

  overlay = updateQuarantineOverlayFilter(overlay, "c");
  overlay = updateQuarantineOverlayFilter(overlay, "l");
  assert.equal(overlay.filterQueryBuffer, "cl");
  assert.equal(overlay.candidateIndex, 0, "candidate index resets to 0 when filter changes");

  const candidates = resolveQuarantineCandidates(overlay, models);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.kind, "modelProvider");
  assert.equal(candidates[0]?.modelId, "claude-3-5-sonnet");
}

function testClearingFilterRestoresFullList(): void {
  console.log("\n--- T7: Clearing the filter restores the full list ---");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    },
    {
      providerId: "anthropic",
      modelId: "claude-3-5-sonnet",
      modelName: "Claude 3.5 Sonnet",
      provider: { isBlocked: false },
    },
  ] as unknown as Parameters<typeof resolveQuarantineCandidates>[1];

  let overlay: QuarantineOverlayState = {
    ...createQuarantineOverlay("create"),
    level: "modelProvider",
  };

  overlay = updateQuarantineOverlayFilter(overlay, "c");
  overlay = updateQuarantineOverlayFilter(overlay, "l");
  assert.equal(resolveQuarantineCandidates(overlay, models).length, 1);

  // Backspace twice
  overlay = updateQuarantineOverlayFilter(overlay, "<backspace>");
  overlay = updateQuarantineOverlayFilter(overlay, "<backspace>");
  assert.equal(overlay.filterQueryBuffer, "");
  assert.equal(resolveQuarantineCandidates(overlay, models).length, 2, "clearing filter restores all candidates");
}

function testProviderModeHasNoFilterField(): void {
  console.log("\n--- T8: Provider mode has no filter field ---");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    },
    {
      providerId: "anthropic",
      modelId: "claude-3-5-sonnet",
      modelName: "Claude 3.5 Sonnet",
      provider: { isBlocked: false },
    },
  ] as unknown as Parameters<typeof resolveQuarantineCandidates>[1];

  let overlay = {
    ...createQuarantineOverlay("create"),
    level: "provider" as const,
  };

  // Attempting to filter in provider mode is a no-op
  const updated = updateQuarantineOverlayFilter(overlay, "c");
  assert.equal(updated, overlay, "updateQuarantineOverlayFilter returns overlay unchanged in provider mode");

  // Even if filterQueryBuffer had text, resolveQuarantineCandidates ignores it in provider mode
  const overlayWithFilter = { ...overlay, filterQueryBuffer: "nonmatching" };
  const candidates = resolveQuarantineCandidates(overlayWithFilter, models);
  assert.equal(candidates.length, 2, "provider mode candidate list ignores filterQueryBuffer");
}

function testCreateOverlayRejectsModelLevel(): void {
  console.log("\n--- T9: Create overlay cannot author a global model rule ---");
  const createOverlay = createQuarantineOverlay("create");
  assert.equal(createOverlay.level, "provider");

  // Explicit set to "model" in create mode is rejected (returns overlay unchanged)
  const rejectedSet = setQuarantineOverlayLevel(createOverlay, "model");
  assert.equal(rejectedSet.level, "provider", "setQuarantineOverlayLevel rejects level 'model' in create mode");

  // Cycling in create mode toggles provider <-> modelProvider, skipping "model"
  const cycled1 = cycleQuarantineOverlayLevel(createOverlay, "next");
  assert.equal(cycled1.level, "modelProvider");
  const cycled2 = cycleQuarantineOverlayLevel(cycled1, "next");
  assert.equal(cycled2.level, "provider");
}

function testModifyOverlayPreservesModelLevel(): void {
  console.log("\n--- T10: Modify overlay still accepts persisted model entries ---");
  const modifyOverlay = createQuarantineOverlay("modify", 0, {
    level: "model",
    modelId: "gpt-4o",
    reason: "persisted model rule",
  });
  assert.equal(modifyOverlay.mode, "modify");
  assert.equal(modifyOverlay.level, "model", "modify overlay preserves seed level 'model'");

  // setQuarantineOverlayLevel accepts 'model' in modify mode
  const setModel = setQuarantineOverlayLevel(modifyOverlay, "model");
  assert.equal(setModel.level, "model");

  // Cycle levels in modify mode
  const cycled1 = cycleQuarantineOverlayLevel(modifyOverlay, "next");
  assert.equal(cycled1.level, "modelProvider");
  const cycled2 = cycleQuarantineOverlayLevel(cycled1, "next");
  assert.equal(cycled2.level, "provider");
  const cycled3 = cycleQuarantineOverlayLevel(cycled2, "next");
  assert.equal(cycled3.level, "model");

  const draft = buildQuarantineDraft(modifyOverlay);
  assert.equal(draft.level, "model");
  assert.equal(draft.modelId, "gpt-4o");
  assert.equal(draft.reason, "persisted model rule");
}

function testReleaseOverlayPreservesModelLevel(): void {
  console.log("\n--- T11: Release overlay still accepts persisted model entries ---");
  const seed: QuarantineEntry = {
    level: "model",
    modelId: "gpt-4o",
    type: "permanent",
    reason: "release test",
  };
  const releaseOverlay = createQuarantineOverlay("release", 0, seed);
  assert.equal(releaseOverlay.mode, "release");
  assert.equal(releaseOverlay.level, "model");

  const target = buildQuarantineTarget(releaseOverlay, seed);
  assert.equal(target.level, "model");
  assert.equal(target.modelId, "gpt-4o");
  assert.equal(target.providerId, undefined);
}

async function run(): Promise<void> {
  testDeriveQuarantineViewReason();
  testOverlayStateFactory();
  testOverlayBufferAcceptContract();
  testResolveCandidatesFromSnapshot();
  testDisconnectedProviderExcluded();
  testBuildDraftFromProviderCandidate();
  testBuildDraftFromModelProviderCandidate();
  testProviderModelNotGlobalModelRule();
  testFilterNarrowsCandidates();
  testClearingFilterRestoresFullList();
  testProviderModeHasNoFilterField();
  testCreateOverlayRejectsModelLevel();
  testModifyOverlayPreservesModelLevel();
  testReleaseOverlayPreservesModelLevel();
  await testSubmitDraftDispatchesThroughVerifier();
  await testReleaseFromTargetUsesVerifier();
  console.log("\nAll PR3 TUI quarantine overlay pure assertions passed.");
}

run().catch((err) => {
  console.error("PR3 TUI quarantine overlay test failed:", err);
  process.exit(1);
});

void (null as unknown as QuarantineItemView | null);
void (null as unknown as QuarantineOverlayFocus | null);
void (null as unknown as QuarantineOverlayState | null);
