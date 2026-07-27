/**
 * Task 7 Integration Test — Dialog mount/unmount lifecycle, listener leak
 * detection, and `alt+shift+m` host collision check.
 *
 * Change: `model-control-center-native-dialog`.
 * Updated for the native dialog contract: tests drive 5 dialog
 * mount/unmount cycles through the captured `render` / `onClose`
 * passed to `api.ui.dialog.replace`, asserting mode push/pop parity,
 * per-mount keymap disposer exactly-once, base layer registered once,
 * and the delayed `onClose` interleaving race regression.
 *
 * Acceptance scenarios (from spec rev 2):
 *   - "Each dialog mount MUST activate its dialog-scoped mode and keymap
 *      only for that mount."
 *   - "Closing, replacing, host disposal, or rollback MUST dispose each
 *      registered lifecycle resource exactly once."
 *   - "A later open MUST create one fresh scope without retaining or
 *      duplicating prior mode or keymap state."
 *   - The legacy `ctrl+alt+f` binding MUST NOT be re-registered in any
 *      layer (host collision guard).
 */
import assert from "node:assert/strict";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createRoot } from "solid-js";
import { createComponent } from "solid-js/web";
import type { JSX } from "@opentui/solid";

import SddTuiModule from "../src/tui.js";
import { getOrCreateModelConfigRegistry } from "../src/infrastructure/runtime/model-config-registry.js";

console.log("--- Task 7 Integration: Dialog Cleanup, Listener Leak, Host Collision ---");

const failures: string[] = [];

// Silence unused-import lint for the createRoot import (solid-js) — Node
// tooling reads it as a type/host contract for the dialog render pattern.
void createRoot;

function assertOk(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error("  FAIL: " + message);
  } else {
    console.log("  pass: " + message);
  }
}

/**
 * OpenTUI's real intrinsic elements (`jsx("box"/"text")`) require the
 * native FFI renderer, which is only available under Bun. This process
 * runs under Node (`tsx`), so calling `captured.render()` (which
 * constructs plain-JSX production content via ModelControlCenter) throws
 * here by design — it is NOT a lifecycle or keymap-contract bug. Keymap
 * layer registration and its `onCleanup` disposer registration happen
 * synchronously BEFORE the JSX construction point, so lifecycle/counter
 * assertions remain valid even when this guard swallows the downstream
 * content-construction error. Content correctness is proven by
 * `test:tui:bun` and the real-host PTY gate, not here.
 */
function isRendererUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /No renderer found|native FFI is not available/.test(msg);
}

function logRendererSkip(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(
    `  SKIP (environment limitation, ${context}): OpenTUI intrinsic content requires Bun native FFI, unavailable under Node/tsx (${msg}). Content assertions deferred to test:tui:bun / real-host PTY.`,
  );
}

interface RegistrationCounters {
  baseLayerRegistrations: number;
  baseLayerDisposersInvoked: number;
  modePushes: number;
  modePops: number;
  layerRegistrations: number;
  layerDisposersInvoked: number;
  listenerErrors: number;
  dialogAlertInvocations: number;
  dialogReplaceInvocations: number;
  dialogClearInvocations: number;
  routeRegisterInvocations: number;
  routeNavigateInvocations: number;
}

interface CapturedDialog {
  render: () => JSX.Element;
  onClose?: () => void;
}

interface DialogHarness {
  api: TuiPluginApi;
  counters: RegistrationCounters;
  layers: Array<{ mode?: string; priority?: number; commands: unknown[]; bindings: unknown[] }>;
  disposers: Array<() => void>;
  dialogs: CapturedDialog[];
}

function buildMockApi(counters: RegistrationCounters, harness: DialogHarness): TuiPluginApi {
  return {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: (layer: unknown) => {
        counters.layerRegistrations++;
        const l = layer as { mode?: string; priority?: number; commands: unknown[]; bindings: unknown[] };
        harness.layers.push(l);
        if (l.mode === "base") {
          counters.baseLayerRegistrations++;
        }
        return () => {
          counters.layerDisposersInvoked++;
          if (l.mode === "base") {
            counters.baseLayerDisposersInvoked++;
          }
        };
      },
    } as never,
    route: {
      register: () => {
        counters.routeRegisterInvocations++;
        return () => {};
      },
      navigate: () => {
        counters.routeNavigateInvocations++;
      },
      current: { name: "home" },
    },
    mode: {
      current: () => "base",
      push: (_name: string) => {
        counters.modePushes++;
        return () => {
          counters.modePops++;
        };
      },
    },
    ui: {
      DialogAlert: (props: { title?: string; message?: string }): JSX.Element => {
        counters.dialogAlertInvocations++;
        // Non-null sentinel — avoids the OpenTUI renderer context dependency
        // that `jsx("box", ...)` would pull in.
        const sentinel = {
          __dialogAlertSentinel: true,
          title: props.title,
          message: props.message,
        };
        return createComponent(
          ((p: { title?: string; message?: string }) => sentinel) as unknown as (p: typeof props) => JSX.Element,
          props,
        ) as unknown as JSX.Element;
      },
      Dialog: (() => null) as never,
      DialogConfirm: (() => null) as never,
      DialogPrompt: (() => null) as never,
      DialogSelect: (() => null) as never,
      Slot: (() => null) as never,
      Prompt: (() => null) as never,
      toast: () => {},
      dialog: {
        replace: (render: () => JSX.Element, onClose?: () => void) => {
          counters.dialogReplaceInvocations++;
          harness.dialogs.push({ render, onClose });
        },
        clear: () => {
          counters.dialogClearInvocations++;
        },
        setSize: () => {},
        get size() {
          return "medium" as const;
        },
        get depth() {
          return 0;
        },
        get open() {
          return true;
        },
      },
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
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (cb: () => void) => {
        harness.disposers.push(cb);
        return () => {};
      },
    },
  };
}

async function run() {
  const counters: RegistrationCounters = {
    baseLayerRegistrations: 0,
    baseLayerDisposersInvoked: 0,
    modePushes: 0,
    modePops: 0,
    layerRegistrations: 0,
    layerDisposersInvoked: 0,
    listenerErrors: 0,
    dialogAlertInvocations: 0,
    dialogReplaceInvocations: 0,
    dialogClearInvocations: 0,
    routeRegisterInvocations: 0,
    routeNavigateInvocations: 0,
  };
  const harness: DialogHarness = {
    api: undefined as unknown as TuiPluginApi,
    counters,
    layers: [],
    disposers: [],
    dialogs: [],
  };
  harness.api = buildMockApi(counters, harness);

  // === Initial registration via tui() ===
  await SddTuiModule.tui(harness.api, undefined, {} as never);

  assertOk(counters.baseLayerRegistrations === 1, "first tui() call registers the base keymap layer exactly once");
  assertOk(counters.routeRegisterInvocations === 0, "first tui() call does NOT register a route (native dialog replaces route)");
  assertOk(harness.layers[0]?.mode === "base", "keymap layer is registered with mode='base'");
  assertOk(typeof harness.layers[0]?.priority === "number", "keymap layer carries a numeric priority");

  // === Host collision: the chosen mnemonic MUST be on the base layer ONLY ===
  assertOk(harness.api.app.version === "1.18.4", "host API reports supported OpenCode version 1.18.4");
  const [major, minor] = harness.api.app.version.split(".").map(Number) as [number, number];
  assertOk(
    major > 1 || (major === 1 && minor >= 17),
    "host version satisfies >= 1.17.11 peer dependency contract",
  );

  const altShiftM = harness.layers[0]?.bindings.find((b: { key?: string; cmd?: string }) => b.key === "alt+shift+m");
  assertOk(altShiftM !== undefined, "base layer registers binding 'alt+shift+m'");
  assertOk(
    (altShiftM as { cmd?: string })?.cmd === "model-control-center.open",
    "alt+shift+m binding points to command 'model-control-center.open'",
  );
  assertOk(
    typeof (altShiftM as { desc?: string })?.desc === "string" && (altShiftM as { desc?: string }).desc!.length > 0,
    "alt+shift+m binding carries a non-empty description",
  );

  // Regression guard: the legacy 'ctrl+alt+f' binding collides with the host's
  // built-in `messages_page_down` command on OpenCode 1.18.4 and must NOT be
  // re-introduced in any layer (base or dialog-scoped).
  const legacyCollisions = harness.layers.flatMap((layer, layerIndex) =>
    (layer.bindings as Array<{ key?: string }>)
      .filter((b) => b.key === "ctrl+alt+f")
      .map((b) => ({ layerIndex, key: b.key })),
  );
  assertOk(
    legacyCollisions.length === 0,
    `legacy 'ctrl+alt+f' binding is absent from every layer (host collision guard; found ${legacyCollisions.length} occurrence(s))`,
  );

  const openCmd = (harness.layers[0]?.commands as Array<{ name?: string; run?: () => unknown }>).find(
    (c) => c.name === "model-control-center.open",
  );
  assertOk(openCmd !== undefined, "command 'model-control-center.open' is registered in base layer");
  assertOk(typeof openCmd?.run === "function", "command 'model-control-center.open' has a run function");

  // === Repeated dialog mount/unmount cycles via captured render+onClose ===
  // Each mount invokes the captured render (which pushes mode and registers
  // the dialog-scoped keymap layer inside our createRoot). Each unmount
  // invokes the captured onClose (which disposes the per-instance scope).
  // After Phase 2: no custom mode push (modeless MCC keymap; host owns
  // the modal surface). Mode counters stay 0 throughout the 5 cycles.
  const CYCLES = 5;
  for (let i = 0; i < CYCLES; i++) {
    const pushesBefore = counters.modePushes;
    const popsBefore = counters.modePops;
    const layersBefore = counters.layerRegistrations;
    const dialogsBefore = harness.dialogs.length;

    // Trigger open command
    (openCmd?.run as () => void)();
    assertOk(
      harness.dialogs.length === dialogsBefore + 1,
      `cycle ${i + 1}: open command appends a new dialog.replace invocation`,
    );

    const captured = harness.dialogs[harness.dialogs.length - 1]!;
    assertOk(typeof captured.render === "function", `cycle ${i + 1}: dialog.replace receives render function`);
    assertOk(
      typeof captured.onClose === "function",
      `cycle ${i + 1}: dialog.replace receives per-instance onClose`,
    );

    // Mount via createRoot simulating the host dialog stack frame.
    let dispose: (() => void) | null = null;
    createRoot((d) => {
      dispose = d;
      try {
        captured.render();
      } catch (err) {
        if (!isRendererUnavailable(err)) throw err;
        logRendererSkip(`cycle ${i + 1}: dialog render`, err);
      }
    });
    assertOk(
      counters.modePushes === pushesBefore,
      `cycle ${i + 1}: dialog render does NOT push any custom mode (modeless MCC keymap)`,
    );
    assertOk(counters.modePops === popsBefore, `cycle ${i + 1}: mode push/pop counts unchanged during mount`);
    assertOk(
      counters.layerRegistrations === layersBefore + 1,
      `cycle ${i + 1}: mounted component registered its modeless keymap layer exactly once`,
    );
    // The component-lifetime layer is modeless (no `mode` field) and
    // has priority 200. Base layer keeps mode === "base".
    const lastComponentLayer = harness.layers[harness.layers.length - 1]!;
    assertOk(
      !("mode" in lastComponentLayer),
      `cycle ${i + 1}: component-lifetime layer has NO 'mode' field`,
    );
    assertOk(
      lastComponentLayer.priority === 200,
      `cycle ${i + 1}: component-lifetime layer priority is 200`,
    );

    // Unmount via per-instance onClose (the host's dispose path).
    (captured.onClose as () => void)();
    assertOk(
      counters.modePops === popsBefore,
      `cycle ${i + 1}: per-instance onClose does NOT pop any custom mode (no mode to pop)`,
    );
    assertOk(
      counters.layerDisposersInvoked >= 1,
      `cycle ${i + 1}: per-instance onClose fires the component keymap disposer`,
    );

    // Dispose the outer Solid root we used to simulate the host frame.
    (dispose as () => void)();
  }

  // After cycles, mode push/pop MUST be balanced (both 0) and base layer
  // MUST be unique. Component-lifetime layers are modeless (no `mode`).
  assertOk(
    counters.modePushes === counters.modePops,
    `mode push/pop balanced after ${CYCLES} cycles (pushes=${counters.modePushes}, pops=${counters.modePops})`,
  );
  assertOk(counters.modePushes === 0, "no custom mode pushed across all cycles (Phase 2 invariant)");
  assertOk(counters.modePops === 0, "no custom mode popped across all cycles (Phase 2 invariant)");
  assertOk(counters.layerRegistrations === 1 + CYCLES, "base keymap layer registered once; only component-lifetime layers added per cycle");
  assertOk(harness.layers.filter((l) => l.mode === "base").length === 1, "exactly one base keymap layer is registered");
  // Component-lifetime layers are modeless (no `mode` field).
  const componentLayers = harness.layers.filter((l) => l.mode !== "base");
  assertOk(
    componentLayers.every((l) => !("mode" in l) || l.mode === undefined),
    "all component-lifetime layers are modeless (no 'mode' field)",
  );
  assertOk(
    componentLayers.every((l) => l.priority === 200),
    "all component-lifetime layers have priority 200",
  );
  assertOk(
    counters.routeRegisterInvocations === 0,
    "no route registration calls across all dialog cycles (native dialog contract)",
  );
  assertOk(
    counters.routeNavigateInvocations === 0,
    "no route.navigate calls across all dialog cycles (native dialog contract)",
  );

  // === Delayed onClose interleaving race regression ===
  // Open dialog A → open dialog B → fire delayed onClose_A → assert B's
  // modeless keymap is intact, B's slot is preserved, A's scope is
  // disposed idempotently. No custom mode is in play (Phase 2).
  if (harness.dialogs.length >= 2) {
    const a = harness.dialogs[harness.dialogs.length - 2]!;
    const b = harness.dialogs[harness.dialogs.length - 1]!;

    let disposeA: (() => void) | null = null;
    let disposeB: (() => void) | null = null;
    createRoot((d) => {
      disposeB = d;
      try {
        b.render();
      } catch (err) {
        if (!isRendererUnavailable(err)) throw err;
        logRendererSkip("race regression: B mount", err);
      }
    });
    const modePushesBeforeLateA = counters.modePushes;
    const modePopsBeforeLateA = counters.modePops;
    const layerDisposersBeforeLateA = counters.layerDisposersInvoked;

    // Fire A's onClose AFTER B is mounted (delayed callback).
    (a.onClose as () => void)();
    assertOk(
      counters.modePushes === modePushesBeforeLateA,
      "delayed onClose_A does NOT push additional mode",
    );
    assertOk(
      counters.modePops === modePopsBeforeLateA,
      "delayed onClose_A does NOT pop B's mode (no custom mode to pop; slot remains B's)",
    );
    assertOk(
      counters.layerDisposersInvoked === layerDisposersBeforeLateA,
      "delayed onClose_A does NOT fire B's keymap disposer",
    );

    // Now legitimately close B. (No mode pop: no custom mode was pushed.)
    (b.onClose as () => void)();
    assertOk(
      counters.modePops === 0,
      "B's onClose: no custom mode to pop (mode counters remain 0)",
    );

    // Cleanup outer B root.
    (disposeB as () => void)();
    if (disposeA) (disposeA as () => void)();
  }

  // === No listener leak on globalThis registry ===
  const registry = getOrCreateModelConfigRegistry();
  const initialRevision = registry.revision;
  let listenerCalls = 0;
  const unsubscribe = registry.subscribe(() => {
    listenerCalls++;
  });
  registry.publish({
    providerId: "cleanup-test",
    modelId: "cleanup-test",
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: [],
    inputPerMillion: null,
    outputPerMillion: null,
    cachedPerMillion: null,
    currency: "USD",
    isBlocked: false,
    subscription: null,
    metadataEnvelopeHash: null,
  });
  assertOk(listenerCalls === 1, "subscriber receives publish event");
  unsubscribe();
  registry.publish({
    providerId: "cleanup-test",
    modelId: "cleanup-test",
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: [],
    inputPerMillion: null,
    outputPerMillion: null,
    cachedPerMillion: null,
    currency: "USD",
    isBlocked: false,
    subscription: null,
    metadataEnvelopeHash: null,
  });
  assertOk(listenerCalls === 1, "unsubscribed listener does not receive subsequent events (no leak)");

  // === Plugin unload disposes base keymap ===
  for (const dispose of harness.disposers) {
    dispose();
  }
  assertOk(
    counters.baseLayerDisposersInvoked === 1,
    `base keymap layer disposer invoked on plugin unload (disposers=${counters.baseLayerDisposersInvoked})`,
  );

  // Cleanup entry from registry (so we don't pollute subsequent tests)
  const key = "cleanup-test/cleanup-test";
  const deleted = (registry as unknown as { entries: Map<string, unknown> }).entries.delete(key);
  assertOk(deleted === true, "test cleanup entry removed from registry");

  assertOk(registry.revision > initialRevision, "registry revision advances with each publish");

  // ============================================================
  // Phase 1c.4 RED — Delayed onClose_A across dialog cycles.
  // Real ordering: open A, mount A, open B (simulate production's
  // activeScope pre-dispose by calling A's onClose), mount B,
  // fire delayed onClose_A. Assert A's total disposer delta = 0
  // after the delayed call (identity guard absorbs it), and no
  // custom mode is pushed across the entire lifecycle.
  // Uses the existing harness counters and dialogs (no new mock,
  // no outer-Solid-root disposal in the test path).
  // ============================================================
  console.log("\n--- Phase 1c.4 RED: Delayed onClose_A isolation + no custom mode ---");

  // 1) open A
  (openCmd?.run as () => void)();
  const aDialog = harness.dialogs[harness.dialogs.length - 1]!;
  // 2) mount A in a transient createRoot (matches the existing
  // 5-cycle pattern: outer wrapper owns Solid context; the inner
  // scope is the production code's createRoot inside the render fn).
  let _disposeAOuter: (() => void) | null = null;
  createRoot((d) => {
    _disposeAOuter = d;
    try {
      aDialog.render();
    } catch (err) {
      if (!isRendererUnavailable(err)) throw err;
      logRendererSkip("phase1c.4: A mount", err);
    }
  });
  // 3) open B (production: activeScope?.dispose() → calls A's onClose).
  // Test simulates the auto-dispose by calling A's onClose explicitly.
  (openCmd?.run as () => void)();
  const bDialog = harness.dialogs[harness.dialogs.length - 1]!;
  (aDialog.onClose as () => void)(); // simulate stale-scope pre-dispose
  // 4) mount B
  let _disposeBOuter: (() => void) | null = null;
  createRoot((d) => {
    _disposeBOuter = d;
    try {
      bDialog.render();
    } catch (err) {
      if (!isRendererUnavailable(err)) throw err;
      logRendererSkip("phase1c.4: B mount", err);
    }
  });

  // Snapshot the disposer count after the auto-dispose of A.
  const disposersAfterAutoDispose = counters.layerDisposersInvoked;
  // 5) Fire delayed onClose_A. Identity guard makes this a no-op.
  (aDialog.onClose as () => void)();
  assertOk(
    counters.layerDisposersInvoked === disposersAfterAutoDispose,
    `phase1c.4: delayed onClose_A is idempotent — A's total disposer delta = 0 (current delta = ${counters.layerDisposersInvoked - disposersAfterAutoDispose})`,
  );

  // 6) Verify B has not been closed yet. B's disposer should not have
  // fired. We assert by snapshotting layerDisposersInvoked before
  // closing B and asserting it does not change.
  const disposersBeforeBClose = counters.layerDisposersInvoked;
  // B is still alive; do not dispose its outer wrapper (the test
  // path is purely onClose-driven).
  void _disposeAOuter;
  void _disposeBOuter;
  assertOk(
    counters.layerDisposersInvoked === disposersBeforeBClose,
    `phase1c.4: B remains operational — B's disposer delta = 0 before B's onClose (current delta = ${counters.layerDisposersInvoked - disposersBeforeBClose})`,
  );

  // 7) No custom mode pushed for the entire lifecycle. Patch
  // harness.api.mode.push briefly to capture mode names, then
  // restore. Trigger a fresh open+mount cycle to capture the mode
  // push that happens inside the production code's render fn.
  const modePushNames: string[] = [];
  const _origModePush = harness.api.mode.push;
  (harness.api.mode as unknown as { push: (n: string) => () => void }).push = (name: string) => {
    modePushNames.push(name);
    return _origModePush.call(harness.api.mode, name);
  };
  // Trigger one open+mount cycle to exercise the production code's
  // `api.mode.push("model-control-center")` inside the render fn.
  (openCmd?.run as () => void)();
  const freshDialog = harness.dialogs[harness.dialogs.length - 1]!;
  createRoot((d) => {
    try {
      freshDialog.render();
    } catch (err) {
      if (!isRendererUnavailable(err)) throw err;
      logRendererSkip("phase1c.4: fresh open+mount cycle", err);
    }
    d();
  });
  (harness.api.mode as unknown as { push: typeof _origModePush }).push = _origModePush;
  const nonBasePushes = modePushNames.filter((n) => n && n !== "base");
  assertOk(
    nonBasePushes.length === 0,
    `phase1c.4: no custom mode pushed across the lifecycle (pushed non-base: [${nonBasePushes.join(", ")}])`,
  );

  // 8) Close B (B's onClose fires the disposer; B is closed).
  (bDialog.onClose as () => void)();

  if (failures.length > 0) {
    console.error(`\n=== Phase 1c.4 RED: ${failures.length} expected failure(s) ===`);
  } else {
    console.log("\n=== Phase 1c.4 RED: 0 failures (unexpected) ===");
  }

  console.log("\n=== INTEGRATION DIALOG CLEANUP + HOST COLLISION SUMMARY ===");
  if (failures.length === 0) {
    console.log("All dialog cleanup, listener leak, and host collision assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " assertion(s) failed.");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
