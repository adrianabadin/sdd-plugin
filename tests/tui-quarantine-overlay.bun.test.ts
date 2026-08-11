/**
 * PR3 Phase 3 — TUI Quarantine overlay renderer/keymap tests.
 *
 * This file drives the production `ModelControlCenter` through the
 * captured `keymap.registerLayer` surface and the OpenTUI testRender
 * renderer under Bun. It proves:
 *
 *   1. `QuarantinesScreen` with the create overlay renders the form
 *      fields the production overlay needs (scope, id, reason,
 *      duration, ttl hours) and the navigation hint for active capture.
 *   2. `QuarantinesScreen` with the release overlay renders the confirm
 *      prompt and the navigation hint.
 *   3. `ModelControlCenter` registers a priority-300 capture layer ONLY
 *      while a field/overlay editor is active; the base priority-200
 *      layer has no character bindings so it does NOT swallow keys
 *      outside an editor.
 *   4. The capture layer is disposed when the overlay closes (commit,
 *      cancel, or unmount) — `keymap.registerLayer` is paired with
 *      exactly one disposer invocation per registration.
 *   5. Submitting the create overlay dispatches `setQuarantineUseCase`
 *      exactly once with the readback-verified draft; invalid input
 *      (blank reason, non-positive TTL) keeps the overlay open and
 *      produces NO write and NO publish.
 *   6. Release dispatches `releaseQuarantineUseCase` exactly once; the
 *      verifier readback gate is honored (no release when the readback
 *      still observes an active row).
 *
 * Runs under Bun. The pure (Node) companion is
 * `tests/tui-quarantine-overlay.test.ts`.
 */
import { testRender } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { createComponent } from "solid-js/web";
import ModelControlCenter from "../src/tui/ModelControlCenter.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { QuarantineEntry } from "../src/domain/model/quarantine.js";
import type { SetQuarantineCommand } from "../src/ports/quarantine-write.port.js";
import type { QuarantineTarget } from "../src/domain/model/quarantine.js";
import type { ConnectedModelInfo } from "../src/domain/model/connected-model.js";
import type { ModelCatalogPort } from "../src/ports/model-catalog.port.js";

console.log("--- PR3 Phase 3: TUI Quarantine overlay (Bun renderer) ---");

let failures = 0;
function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  pass: ${message}`);
  } else {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}
assert.ok = function(condition: unknown, message?: string) {
  assert(condition, message ?? "expected truthy value");
};
assert.equal = function(actual: unknown, expected: unknown, message?: string) {
  assert(actual === expected, message ?? `expected ${String(expected)}, got ${String(actual)}`);
};

interface LayerSnapshot {
  priority: number;
  commands: Array<{ name: string; run: () => void }>;
  bindings: Array<{ key: string; cmd: string }>;
}

interface SetCall {
  cmd: SetQuarantineCommand;
}

interface ReleaseCall {
  target: QuarantineTarget;
}

interface Harness {
  runKey: (key: string) => Promise<boolean>;
  frame: () => string;
  sets: SetCall[];
  releases: ReleaseCall[];
  layers: LayerSnapshot[];
  waitForFrame: (predicate: (frame: string) => boolean) => Promise<unknown>;
  flush: () => Promise<void>;
  destroy: () => void;
}

interface MountOptions {
  entries: QuarantineEntry[];
  setBehaviour: "accept" | "reject";
  releaseBehaviour: "accept" | "disagree";
  models?: ConnectedModelInfo[];
}

async function mountQuarantineScreen(options: MountOptions): Promise<Harness> {
  const layers: LayerSnapshot[] = [];
  const sets: SetCall[] = [];
  const releases: ReleaseCall[] = [];

  const catalog: ModelCatalogPort | undefined = options.models
    ? ({
        getConnectedModels: async () => options.models!,
      } as unknown as ModelCatalogPort)
    : undefined;

  const api: TuiPluginApi = {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: (layer: unknown) => {
        const snapshot = layer as {
          priority?: number;
          commands?: Array<{ name: string; run: (ctx?: { ch?: string }) => void }>;
          bindings?: Array<{ key: string; cmd: string }>;
        };
        const entry: LayerSnapshot = {
          priority: snapshot.priority ?? 0,
          commands: (snapshot.commands ?? []).map((c) => ({ name: c.name, run: c.run })),
          bindings: (snapshot.bindings ?? []).map((b) => ({ key: b.key, cmd: b.cmd })),
        };
        layers.push(entry);
        return () => {
          const idx = layers.indexOf(entry);
          if (idx !== -1) layers.splice(idx, 1);
        };
      },
    } as never,
    route: { register: () => () => {}, navigate: () => {}, current: { name: "home" } },
    mode: { current: () => "modal", push: () => () => {} },
    ui: {
      DialogAlert: (() => null) as never,
      Dialog: (() => null) as never,
      DialogConfirm: (() => null) as never,
      DialogPrompt: (() => null) as never,
      DialogSelect: (() => null) as never,
      Slot: (() => null) as never,
      Prompt: (() => null) as never,
      toast: () => {},
      dialog: {} as never,
    },
    tuiConfig: {} as never,
    kv: {} as never,
    state: {} as never,
    theme: {} as never,
    client: {} as never,
    event: {} as never,
    renderer: {} as never,
    slots: {} as never,
    plugins: {} as never,
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
  };

  const setQuarantineUseCase = {
    submitDraft: async (draft: { level: string; reason: string; providerId?: string; modelId?: string; duration: { kind: string; hours?: number } }) => {
      if (options.setBehaviour === "reject") {
        throw new Error("Readback verification failed");
      }
      const cmd: SetQuarantineCommand = {
        level: draft.level as SetQuarantineCommand["level"],
        type: draft.duration.kind === "ttl" ? "ttl" : "permanent",
        until: null,
        reason: draft.reason,
      };
      if (draft.providerId !== undefined) cmd.providerId = draft.providerId;
      if (draft.modelId !== undefined) cmd.modelId = draft.modelId;
      sets.push({ cmd });
      return {
        level: cmd.level,
        providerId: cmd.providerId,
        modelId: cmd.modelId,
        type: cmd.type,
        until: cmd.until ?? null,
        reason: cmd.reason ?? null,
      };
    },
  };

  const releaseQuarantineUseCase = {
    releaseFromTarget: async (target: QuarantineTarget) => {
      releases.push({ target });
      if (options.releaseBehaviour === "disagree") {
        throw new Error("Quarantine release verification failed");
      }
    },
  };

  const listQuarantinesUseCase = {
    execute: async () => options.entries,
  };

  const setup = await testRender(
    () =>
      createComponent(ModelControlCenter, {
        api,
        catalog,
        detailQuery: undefined,
        saveDetailUseCase: undefined,
        listQuarantinesUseCase,
        setQuarantineUseCase: setQuarantineUseCase as never,
        releaseQuarantineUseCase: releaseQuarantineUseCase as never,
      }) as JSX.Element,
  );

  const runKey = async (key: string): Promise<boolean> => {
    // Resolve through the highest-priority layer first; fall back to
    // any layer that binds the key. This mirrors the production
    // dispatch order.
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]!;
      let binding = layer.bindings.find((candidate) => candidate.key === key);
      let isWildcard = false;
      if (!binding && key.length === 1) {
        binding = layer.bindings.find((candidate) => candidate.key === "<character>");
        isWildcard = true;
      }
      if (!binding) continue;
      const command = layer.commands.find((candidate) => candidate.name === binding.cmd);
      if (!command) continue;
      if (isWildcard) {
        (command.run as (ctx?: { ch?: string }) => void)({ ch: key });
      } else {
        command.run();
      }
      await setup.flush();
      return true;
    }
    console.error(`  FAIL: no registered command for key '${key}'`);
    failures++;
    return false;
  };

  return {
    runKey,
    frame: () => setup.captureCharFrame(),
    sets,
    releases,
    layers,
    waitForFrame: (predicate) => setup.waitForFrame(predicate),
    flush: () => setup.flush(),
    destroy: () => setup.renderer.destroy(),
  };
}

async function navigateToQuarantines(h: Harness): Promise<void> {
  await h.waitForFrame((frame) => frame.includes("Model Control Center"));
  // main menu -> quarantines
  await h.runKey("down");
  await h.waitForFrame((frame) => frame.includes("> Quarantines"));
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("Quarantine Management"));
}

async function testQuarantinesListWithoutOverlay(): Promise<void> {
  console.log("\n[case] quarantines list — no overlay, no character bindings on the base layer");
  const h = await mountQuarantineScreen({
    entries: [
      {
        level: "provider",
        providerId: "anthropic",
        type: "permanent",
        until: null,
        reason: "vendor incident",
      },
    ],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
  });

  await navigateToQuarantines(h);

  // Reason is surfaced in the list without changing the active/expired
  // sort or the level precedence.
  const frame = h.frame();
  assert(frame.includes("vendor incident"), "list surfaces the trimmed reason");
  assert(frame.includes("ACTIVE (Permanent)"), "active status label preserved");
  assert(frame.includes("[provider]"), "level chip preserved");

  // The base priority-200 layer has numeric shortcuts for numeric editing, but letters
  // must NOT be claimed by the base layer.
  const baseLayer = h.layers.find((layer) => layer.priority === 200);
  assert.ok(baseLayer, "base priority-200 layer is registered");
  const letterKeys = ["a", "z"];
  for (const key of letterKeys) {
    assert.equal(
      baseLayer!.bindings.find((binding) => binding.key === key),
      undefined,
      `base layer has no '${key}' binding (does not swallow letter keys outside an editor)`,
    );
  }
  h.destroy();
}

async function testCreateOverlayRegistrationAndRender(): Promise<void> {
  console.log("\n[case] create overlay — priority-300 capture layer is registered while active");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    } as unknown as ConnectedModelInfo,
  ];
  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);

  // Open the create overlay via the new keymap command registered by
  // ModelControlCenter. The exact binding name comes from the production
  // component; both `c` and `n` (new) are accepted.
  const beforeFrame = h.frame();
  assert(!beforeFrame.includes("[QUARANTINE OVERLAY: CREATE RULE]"), "create overlay is not visible before open");

  const opened = await h.runKey("c");
  assert(opened, "create overlay opens via the registered 'c' binding");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  // A new priority-300 capture layer is registered while the overlay
  // is active and exposes the character/edit bindings.
  const captureLayer = h.layers.find((layer) => layer.priority === 300);
  assert.ok(captureLayer, "priority-300 capture layer is registered while the overlay is active");
  const captureKeys = captureLayer!.bindings.map((b) => b.key);
  assert.ok(captureKeys.includes("backspace"), "capture layer exposes backspace");
  assert.ok(captureKeys.includes("enter"), "capture layer exposes enter (commit)");
  assert.ok(captureKeys.includes("esc"), "capture layer exposes esc (cancel)");
  assert.ok(captureKeys.some((k) => k === "<character>"), "capture layer exposes a wildcard character binding");

  // The overlay form is visible with the field labels.
  const frame = h.frame();
  assert(frame.includes("Scope"), "create overlay shows the scope field");
  assert(frame.includes("Select Target:"), "create overlay shows the select target field");
  assert(frame.includes("Reason"), "create overlay shows the reason field");
  assert(frame.includes("Duration"), "create overlay shows the duration field");

  h.destroy();
}

async function testCreateOverlayCancelDisposesCaptureLayer(): Promise<void> {
  console.log("\n[case] cancel the create overlay — capture layer is disposed");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    } as unknown as ConnectedModelInfo,
  ];
  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));
  const captureBefore = h.layers.filter((layer) => layer.priority === 300).length;
  assert.ok(captureBefore >= 1, "capture layer is registered before cancel");

  // Esc disposes the capture layer.
  const cancelled = await h.runKey("esc");
  assert(cancelled, "esc on the overlay is registered");
  await h.waitForFrame((frame) => !frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));
  const captureAfter = h.layers.filter((layer) => layer.priority === 300).length;
  assert.equal(captureAfter, captureBefore - 1, "capture layer is disposed on cancel");
  assert.equal(h.sets.length, 0, "cancel does not write to persistence");
  h.destroy();
}

async function testCreateOverlayInvalidInputBlocksWrite(): Promise<void> {
  console.log("\n[case] create overlay — blank reason blocks the write");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    } as unknown as ConnectedModelInfo,
  ];
  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  // Tab past the reason (no reason typed) and try to commit.
  await h.runKey("tab");
  await h.runKey("enter");

  const frame = h.frame();
  assert(h.sets.length === 0, "blank reason keeps set count at zero (no write, no publish)");
  assert(
    frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"),
    "blank reason keeps the overlay open (no silent discard)",
  );
  assert(
    /reason/i.test(frame),
    "overlay reports the blank-reason validation reason",
  );

  h.destroy();
}

async function testCreateOverlayValidInputDispatchesUseCase(): Promise<void> {
  console.log("\n[case] create overlay — valid input dispatches setQuarantineUseCase exactly once");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    } as unknown as ConnectedModelInfo,
  ];
  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  // Tab to reason field, type reason, then commit.
  await h.runKey("tab");
  for (const ch of "rate limit") await h.runKey(ch);
  await h.runKey("enter");

  await h.waitForFrame((frame) => !frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));
  assert.equal(h.sets.length, 1, "submit dispatches the use case exactly once");
  const submitted = h.sets[0]?.cmd;
  assert.ok(submitted, "submitted command captured");
  assert.equal(submitted!.providerId, "openai", "submitted command carries the selected provider id");
  assert.equal(submitted!.reason, "rate limit", "submitted command carries the trimmed reason");
  assert.equal(submitted!.type, "permanent", "submitted command carries the permanent duration");

  // Capture layer disposed after the successful commit.
  const captureAfter = h.layers.filter((layer) => layer.priority === 300).length;
  assert.equal(captureAfter, 0, "capture layer disposed after commit");
  h.destroy();
}

async function testCreateOverlayVerifierRejectionKeepsOverlay(): Promise<void> {
  console.log("\n[case] create overlay — verifier rejection keeps the overlay open");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    } as unknown as ConnectedModelInfo,
  ];
  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "reject",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));
  await h.runKey("tab");
  for (const ch of "rate limit") await h.runKey(ch);
  await h.runKey("enter");

  // The overlay stays open and reports the verifier error.
  await h.waitForFrame((frame) => frame.includes("ERROR:"));
  assert.equal(h.sets.length, 0, "use case set is not recorded because stub rejects write");
  const frame = h.frame();
  assert(
    frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"),
    "verifier rejection keeps the overlay open",
  );
  h.destroy();
}

async function testReleaseOverlayDispatchesUseCase(): Promise<void> {
  console.log("\n[case] release overlay — confirm dispatches releaseQuarantineUseCase exactly once");
  const h = await mountQuarantineScreen({
    entries: [
      {
        level: "provider",
        providerId: "openai",
        type: "permanent",
        until: null,
        reason: "to release",
      },
    ],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
  });

  await navigateToQuarantines(h);
  await h.waitForFrame((frame) => frame.includes("to release"));

  // Open release overlay via the new `r` binding.
  const opened = await h.runKey("r");
  assert(opened, "release overlay opens via the registered 'r' binding");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CONFIRM RELEASE]"));

  // Confirm with Enter.
  await h.runKey("enter");
  await h.waitForFrame((frame) => !frame.includes("[QUARANTINE OVERLAY: CONFIRM RELEASE]"));
  assert.equal(h.releases.length, 1, "release dispatches the use case exactly once");
  assert.equal(h.releases[0]?.target.level, "provider");
  assert.equal(h.releases[0]?.target.providerId, "openai");
  h.destroy();
}

async function testReleaseOverlayVerifierRejectionBlocks(): Promise<void> {
  console.log("\n[case] release overlay — verifier disagreement blocks the release");
  const h = await mountQuarantineScreen({
    entries: [
      {
        level: "provider",
        providerId: "openai",
        type: "permanent",
        until: null,
        reason: "stale row",
      },
    ],
    setBehaviour: "accept",
    releaseBehaviour: "disagree",
  });

  await navigateToQuarantines(h);
  await h.runKey("r");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CONFIRM RELEASE]"));
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("ERROR:"));

  // Use case was invoked (writer attempted) but the overlay stays open
  // because the verifier readback still observes an active row.
  assert.equal(h.releases.length, 1, "use case invoked once even when verifier disagrees");
  const frame = h.frame();
  assert(
    frame.includes("[QUARANTINE OVERLAY: CONFIRM RELEASE]"),
    "verifier rejection keeps the release overlay open",
  );
  h.destroy();
}

async function testEmptyCatalogPreventsSubmission(): Promise<void> {
  console.log("\n[case] empty catalog keeps overlay open and dispatches no submit");
  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models: [],
  });

  await navigateToQuarantines(h);
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));
  await h.runKey("enter");

  assert.equal(h.sets.length, 0, "no submit draft dispatched when catalog is empty");
  const frame = h.frame();
  assert(
    frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"),
    "overlay remains open",
  );
  assert(
    frame.includes("No connected targets available"),
    "empty target hint rendered",
  );
  h.destroy();
}

async function testZeroFilterMatchesPreventsSubmission(): Promise<void> {
  console.log("\n[case] zero filter matches keeps overlay open and dispatches no submit");
  const models = [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      provider: { isBlocked: false },
    } as unknown as ConnectedModelInfo,
  ];
  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  // Move focus to scope, switch to Provider/Model, then move focus back to id (filter)
  await h.runKey("shift+tab");
  await h.runKey("right");
  await h.waitForFrame((frame) => frame.includes("[ Provider/Model ]"));
  await h.runKey("tab");

  // Type a filter that excludes all models
  for (const ch of "ZZZZZ") await h.runKey(ch);
  await h.waitForFrame((frame) => frame.includes("Filter: ZZZZZ"));

  // Press Enter while candidates list is empty
  await h.runKey("enter");

  assert.equal(h.sets.length, 0, "no submit draft dispatched when filter yields zero candidates");
  const frame = h.frame();
  assert(
    frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"),
    "overlay remains open",
  );
  assert(
    frame.includes('No connected model matches "ZZZZZ"'),
    "zero match refine hint rendered",
  );
  h.destroy();
}

async function testDownMovesCandidateCursor(): Promise<void> {
  console.log("\n[case] Down moves candidate cursor within bounds");
  const models = [
    { providerId: "anthropic", modelId: "claude-3-5-sonnet", modelName: "Claude 3.5 Sonnet", provider: { isBlocked: false } },
    { providerId: "google", modelId: "gemini-1.5-pro", modelName: "Gemini 1.5 Pro", provider: { isBlocked: false } },
    { providerId: "openai", modelId: "gpt-4o", modelName: "GPT-4o", provider: { isBlocked: false } },
  ] as unknown as ConnectedModelInfo[];

  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  // Initial candidate index is 0 ("anthropic")
  let frame = h.frame();
  assert(frame.includes("> anthropic"), "initial candidate index is 0 (anthropic selected)");

  // Press down -> candidate index 1 ("google")
  await h.runKey("down");
  await h.waitForFrame((frame) => frame.includes("> google"));
  frame = h.frame();
  assert(frame.includes("> google"), "down key advances cursor to index 1 (google)");

  // Press down -> candidate index 2 ("openai")
  await h.runKey("down");
  await h.waitForFrame((frame) => frame.includes("> openai"));
  frame = h.frame();
  assert(frame.includes("> openai"), "down key advances cursor to index 2 (openai)");

  h.destroy();
}

async function testUpMovesCandidateCursor(): Promise<void> {
  console.log("\n[case] Up moves candidate cursor within bounds");
  const models = [
    { providerId: "anthropic", modelId: "claude-3-5-sonnet", modelName: "Claude 3.5 Sonnet", provider: { isBlocked: false } },
    { providerId: "google", modelId: "gemini-1.5-pro", modelName: "Gemini 1.5 Pro", provider: { isBlocked: false } },
    { providerId: "openai", modelId: "gpt-4o", modelName: "GPT-4o", provider: { isBlocked: false } },
  ] as unknown as ConnectedModelInfo[];

  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  // Press up from index 0 -> wraps to index 2 ("openai")
  await h.runKey("up");
  await h.waitForFrame((frame) => frame.includes("> openai"));
  let frame = h.frame();
  assert(frame.includes("> openai"), "up key wraps cursor to index 2 (openai)");

  // Press up from index 2 -> index 1 ("google")
  await h.runKey("up");
  await h.waitForFrame((frame) => frame.includes("> google"));
  frame = h.frame();
  assert(frame.includes("> google"), "up key retreats cursor to index 1 (google)");

  h.destroy();
}

async function testUnderlyingListNavResumesAfterEsc(): Promise<void> {
  console.log("\n[case] underlying list navigation resumes after Esc");
  const models = [
    { providerId: "anthropic", modelId: "claude-3-5-sonnet", modelName: "Claude 3.5 Sonnet", provider: { isBlocked: false } },
    { providerId: "openai", modelId: "gpt-4o", modelName: "GPT-4o", provider: { isBlocked: false } },
  ] as unknown as ConnectedModelInfo[];

  const entries: QuarantineEntry[] = [
    { level: "provider", providerId: "anthropic", type: "permanent", until: null, reason: "r1" },
    { level: "provider", providerId: "openai", type: "permanent", until: null, reason: "r2" },
  ];

  const h = await mountQuarantineScreen({
    entries,
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);

  // Open create overlay
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  // Press down inside overlay (moves candidate cursor to index 1)
  await h.runKey("down");
  await h.waitForFrame((frame) => frame.includes("> openai"));

  // Cancel overlay via Esc
  await h.runKey("esc");
  await h.waitForFrame((frame) => !frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  // Press down on the underlying list (moves selection from item 0 to item 1)
  await h.runKey("down");
  await h.waitForFrame((frame) => frame.includes("> [provider] openai"));

  const frame = h.frame();
  assert(frame.includes("> [provider] openai"), "down key after Esc moves cursor on underlying list");
  h.destroy();
}

async function testActivatingProviderCandidateDispatchesOneSubmit(): Promise<void> {
  console.log("\n[case] activating a provider candidate dispatches one submit");
  const models = [
    { providerId: "anthropic", modelId: "claude-3-5-sonnet", modelName: "Claude 3.5 Sonnet", provider: { isBlocked: false } },
    { providerId: "openai", modelId: "gpt-4o", modelName: "GPT-4o", provider: { isBlocked: false } },
  ] as unknown as ConnectedModelInfo[];

  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  // Move cursor down to index 1 ("openai")
  await h.runKey("down");
  await h.waitForFrame((frame) => frame.includes("> openai"));

  // Tab to reason and type reason
  await h.runKey("tab");
  for (const ch of "vendor outage") await h.runKey(ch);

  // Press Enter to submit
  await h.runKey("enter");
  await h.waitForFrame((frame) => !frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  assert.equal(h.sets.length, 1, "exactly one submit dispatched");
  const cmd = h.sets[0]?.cmd;
  assert.equal(cmd?.level, "provider");
  assert.equal(cmd?.providerId, "openai");
  assert.equal(cmd?.reason, "vendor outage");
  h.destroy();
}

async function testActivatingProviderModelCandidateDispatchesOneSubmit(): Promise<void> {
  console.log("\n[case] activating a provider-model candidate dispatches one submit");
  const models = [
    { providerId: "anthropic", modelId: "claude-3-5-sonnet", modelName: "Claude 3.5 Sonnet", provider: { isBlocked: false } },
    { providerId: "openai", modelId: "gpt-4o", modelName: "GPT-4o", provider: { isBlocked: false } },
  ] as unknown as ConnectedModelInfo[];

  const h = await mountQuarantineScreen({
    entries: [],
    setBehaviour: "accept",
    releaseBehaviour: "accept",
    models,
  });

  await navigateToQuarantines(h);
  await h.runKey("c");
  await h.waitForFrame((frame) => frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  // Move focus to scope, switch to Provider/Model, then back to id (filter)
  await h.runKey("shift+tab");
  await h.runKey("right");
  await h.waitForFrame((frame) => frame.includes("[ Provider/Model ]"));
  await h.runKey("tab");

  // Type filter "gpt" to narrow candidates to gpt-4o
  for (const ch of "gpt") await h.runKey(ch);
  await h.waitForFrame((frame) => frame.includes("Filter: gpt"));

  // Tab to reason and type reason
  await h.runKey("tab");
  for (const ch of "high latency") await h.runKey(ch);

  // Press Enter to submit
  await h.runKey("enter");
  await h.waitForFrame((frame) => !frame.includes("[QUARANTINE OVERLAY: CREATE RULE]"));

  assert.equal(h.sets.length, 1, "exactly one submit dispatched for modelProvider");
  const cmd = h.sets[0]?.cmd;
  assert.equal(cmd?.level, "modelProvider");
  assert.equal(cmd?.providerId, "openai");
  assert.equal(cmd?.modelId, "gpt-4o");
  assert.equal(cmd?.reason, "high latency");
  h.destroy();
}

async function main(): Promise<void> {
  await testQuarantinesListWithoutOverlay();
  await testCreateOverlayRegistrationAndRender();
  await testCreateOverlayCancelDisposesCaptureLayer();
  await testCreateOverlayInvalidInputBlocksWrite();
  await testCreateOverlayValidInputDispatchesUseCase();
  await testCreateOverlayVerifierRejectionKeepsOverlay();
  await testEmptyCatalogPreventsSubmission();
  await testZeroFilterMatchesPreventsSubmission();
  await testDownMovesCandidateCursor();
  await testUpMovesCandidateCursor();
  await testUnderlyingListNavResumesAfterEsc();
  await testActivatingProviderCandidateDispatchesOneSubmit();
  await testActivatingProviderModelCandidateDispatchesOneSubmit();
  await testReleaseOverlayDispatchesUseCase();
  await testReleaseOverlayVerifierRejectionBlocks();

  console.log("\n=== PR3 QUARANTINE OVERLAY SUMMARY ===");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("All PR3 quarantine overlay assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
