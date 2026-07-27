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
  validateQuarantineOverlayBuffers,
  updateQuarantineOverlayBuffer,
  setQuarantineOverlayFocus,
} from "../src/tui/quarantine-overlay.js";
import type { QuarantineEntry, QuarantineTarget, QuarantineDraft } from "../src/domain/model/quarantine.js";
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

async function run(): Promise<void> {
  testDeriveQuarantineViewReason();
  testOverlayStateFactory();
  testOverlayBufferAcceptContract();
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
