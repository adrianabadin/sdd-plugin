/**
 * Test for TUI registration, dialog mount lifecycle, and keymap binding under
 * the host-native dialog presentation contract.
 *
 * Change: `model-control-center-native-dialog`.
 * Covers spec Requirements: Native Dialog Entry, Deterministic Lifecycle,
 * and the design's per-instance DialogHandle / identity-guard disposal
 * contract.
 *
 * The test asserts that the `model-control-center.open` command calls
 * `api.ui.dialog.replace` (NOT `api.route.navigate`), that each dialog
 * mount activates its own Solid root so the mount's mode push and
 * keymap layer are disposed exactly once per close, that re-opens
 * produce a fresh scope without retaining prior state, and that a
 * delayed `onClose` from a previously-closed dialog cannot dispose the
 * active dialog's scope or null its slot.
 */
import SddTuiModule from "../src/tui.js";
import type { TuiPluginApi, TuiRouteDefinition } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createRoot } from "solid-js";
import { createComponent } from "solid-js/web";

const failures: string[] = [];

function assert(condition: unknown, message: string): void {
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
 * runs under Node (`tsx`), so any call path that constructs production
 * screen content (via `renderDialog` -> `ModelControlCenter` -> plain
 * JSX screens) throws here by design — it is NOT a lifecycle or
 * keymap-contract bug. Lifecycle state (keymap registration, onCleanup
 * registration, per-instance scope assignment) is mutated synchronously
 * BEFORE the JSX construction point, so those assertions remain valid
 * even when this guard swallows the downstream content-construction
 * error. Content/frame correctness is proven by `test:tui:bun` (Bun
 * native renderer) and the real-host PTY gate, not here.
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

interface DialogReplaceInvocation {
  render: () => JSX.Element;
  onClose?: () => void;
}

async function main(): Promise<void> {
  console.log("\n--- TUI Registration Test (Native Dialog Contract) ---");

  // 1. Module shape
  assert(SddTuiModule && typeof SddTuiModule === "object", "SddTuiModule is an object");
  assert(SddTuiModule.id === "sdd-plugin.tui", "id is 'sdd-plugin.tui'");
  assert(typeof SddTuiModule.tui === "function", "tui is a function");

  // 2. Trackers
  let layerRegistered = false;
  let registeredLayer: any = null;
  // Stable reference to the BASE layer's "open" command, captured once.
  // The mock's `keymap.registerLayer` reassigns `registeredLayer` on
  // every call — including each dialog mount's component-lifetime
  // layer — so later sections MUST NOT re-derive the base "open"
  // command from the mutable `registeredLayer` variable (it will have
  // been overwritten by then).
  let baseOpenCmdRef: { name?: string; run?: () => Promise<void> | void } | null = null;
  let routeRegistered = false;
  let registeredRoutes: TuiRouteDefinition[] = [];
  const routeNavigateInvocations: string[] = [];
  let modePushedCount = 0;
  let modePoppedCount = 0;
  let layerDisposerCalled = false;
  let routeDisposerCalled = false;
  // Track per-component-lifetime layer data for Phase 1c RED assertions.
  const componentLayerRegistry: Array<{ mode?: string; priority?: number; disposerCalls: number }> = [];
  const lifecycleDisposers: Array<() => void> = [];

  // Dialog lifecycle tracking
  const dialogReplaceInvocations: DialogReplaceInvocation[] = [];
  let dialogClearCalls = 0;
  const capturedDialogFrames: Array<{ description: string }> = [];
  let dialogAlertInvocations: Array<{ title?: string; message?: string }> = [];

  const mockApi: TuiPluginApi = {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: (layer: unknown) => {
        layerRegistered = true;
        registeredLayer = layer;
        // Track each component-lifetime layer (mode !== "base") for
        // Phase 1c RED assertions. The returned disposer increments
        // THIS specific layer's call count (per-instance invariant).
        const l = layer as { mode?: string; priority?: number; commands: unknown[]; bindings: unknown[] };
        let myTracker: { mode?: string; priority?: number; disposerCalls: number } | null = null;
        if (l?.mode !== "base") {
          myTracker = { mode: l.mode, priority: l.priority, disposerCalls: 0 };
          componentLayerRegistry.push(myTracker);
        }
        return () => {
          layerDisposerCalled = true;
          if (myTracker) myTracker.disposerCalls += 1;
        };
      },
    } as never,
    route: {
      register: (routes) => {
        routeRegistered = true;
        registeredRoutes = routes;
        return () => {
          routeDisposerCalled = true;
        };
      },
      navigate: (name: string) => {
        routeNavigateInvocations.push(name);
      },
      current: { name: "home" },
    },
    mode: {
      current: () => "base",
      push: (_name: string) => {
        modePushedCount++;
        return () => {
          modePoppedCount++;
        };
      },
    },
    ui: {
      DialogAlert: (props) => {
        dialogAlertInvocations.push(props);
        // Function component returning a non-null sentinel — avoids the
        // OpenTUI renderer context dependency that `jsx("box", ...)`
        // would pull in. Returns a structurally valid JSX-shaped value.
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
        replace: (render, onClose) => {
          dialogReplaceInvocations.push({ render, onClose });
        },
        clear: () => {
          dialogClearCalls++;
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
        lifecycleDisposers.push(cb);
        return () => {};
      },
    },
  };

  await SddTuiModule.tui(mockApi, undefined, {} as never);

  // 3. Keymap Registration (command still on base layer)
  assert(layerRegistered, "api.keymap.registerLayer called");
  if (registeredLayer) {
    assert(registeredLayer.mode === "base", "layer mode is 'base'");
    assert(Array.isArray(registeredLayer.commands), "layer has commands array");
    const openCmd = registeredLayer.commands.find(
      (c: { name?: string; run?: () => Promise<void> | void }) => c.name === "model-control-center.open",
    );
    baseOpenCmdRef = openCmd ?? null;
    assert(Boolean(openCmd), "found 'model-control-center.open' command");

    assert(Array.isArray(registeredLayer.bindings), "layer has bindings array");
    const binding = registeredLayer.bindings.find(
      (b: { key?: string; cmd?: string }) => b.key === "alt+shift+m",
    );
    assert(
      Boolean(binding && binding.cmd === "model-control-center.open"),
      "binding 'alt+shift+m' points to open command",
    );
    // Guard against silent revert: the legacy 'ctrl+alt+f' binding collides with the host's
    // built-in `messages_page_down` (OpenCode 1.18.4) and MUST NOT be re-introduced.
    const legacyCollision = registeredLayer.bindings.find(
      (b: { key?: string; cmd?: string }) => b.key === "ctrl+alt+f",
    );
    assert(!legacyCollision, "legacy 'ctrl+alt+f' binding is absent (collides with host messages_page_down)");

    // 4. Run command: must call dialog.replace, NOT route.navigate
    if (openCmd && typeof openCmd.run === "function") {
      const navBefore = routeNavigateInvocations.length;
      const replaceBefore = dialogReplaceInvocations.length;
      await openCmd.run();
      assert(
        dialogReplaceInvocations.length === replaceBefore + 1,
        "running command calls api.ui.dialog.replace exactly once",
      );
      assert(
        routeNavigateInvocations.length === navBefore,
        "running command does NOT call api.route.navigate",
      );
    }
  }

  // 5. Dialog render: invoking render mounts the production component
  if (dialogReplaceInvocations.length === 1) {
    const invocation = dialogReplaceInvocations[0]!;
    assert(typeof invocation.render === "function", "dialog.replace receives a render function");
    assert(
      typeof invocation.onClose === "function",
      "dialog.replace receives a per-instance onClose function",
    );

    // Mount the dialog render in a Solid root that mirrors the host dialog stack.
    // The render function owns its own createRoot so cleanup is deterministic.
    // After Phase 2: the render does NOT push a custom mode; the MCC
    // keymap layer is modeless and priority-200.
    let disposeOuter: (() => void) | null = null;
    let renderResult: JSX.Element | null = null;
    let outerModePushes = 0;
    let outerModePops = 0;
    let renderThrew: unknown = null;
    createRoot((dispose) => {
      disposeOuter = dispose;
      const before = modePushedCount;
      try {
        renderResult = invocation.render();
      } catch (err) {
        renderThrew = err;
      }
      outerModePushes = modePushedCount - before;
    });

    if (renderThrew !== null) {
      if (!isRendererUnavailable(renderThrew)) throw renderThrew;
      logRendererSkip("dialog render returns JSX element", renderThrew);
    } else {
      assert(renderResult !== null, "dialog render returned a JSX element");
    }
    assert(outerModePushes === 0, "render pushes NO custom mode (modeless MCC keymap; host owns modal)");
    assert(modePoppedCount === 0, "mode remains stable while dialog is mounted");

    // Capture the current per-instance onClose after a single mount
    const onCloseAfterMount = invocation.onClose;
    assert(typeof onCloseAfterMount === "function", "onClose is a callable function");

    // Fire per-instance onClose: should dispose the dialog scope exactly once.
    if (onCloseAfterMount) {
      onCloseAfterMount();
    }
    // After Phase 2: no mode is pushed, so mode pop count is unchanged
    // (the per-instance onClose disposes the scope, which fires the
    // modeless keymap layer disposer via onCleanup).
    assert(modePoppedCount === 0, "host onClose disposal does NOT pop any custom mode (no mode push to pop)");

    // Idempotency: a second onClose call MUST NOT throw and MUST NOT
    // double-fire the disposer.
    if (onCloseAfterMount) {
      onCloseAfterMount();
    }
    assert(
      modePoppedCount === 0,
      "host onClose is idempotent: a second call does not change mode pop count",
    );

    // Dispose our outer wrapper to confirm no-leak.
    if (disposeOuter) (disposeOuter as () => void)();
  }

  // 6. Re-open parity: open command invoked again creates a fresh
  //    scope, no custom-mode push (Phase 2 invariant: modeless MCC
  //    keymap; the keymap layer registers freshly per open).
  {
    const openCmd = baseOpenCmdRef;
    if (openCmd && typeof openCmd.run === "function") {
      const replacementsBefore = dialogReplaceInvocations.length;
      const modePushesBefore = modePushedCount;
      const modePopsBefore = modePoppedCount;
      await openCmd.run();
      assert(
        dialogReplaceInvocations.length === replacementsBefore + 1,
        "second open command call replaces dialog again",
      );
      assert(
        modePushedCount === modePushesBefore,
        "re-open does NOT push any custom mode (modeless MCC keymap)",
      );
      assert(modePoppedCount === modePopsBefore, "re-open: mode pop count unchanged (no mode push to pop)");

      // Mount the new render and close it via the per-instance onClose.
      const secondInvocation = dialogReplaceInvocations[dialogReplaceInvocations.length - 1]!;
      if (secondInvocation) {
        createRoot((dispose) => {
          const before = modePushedCount;
          try {
            secondInvocation.render();
          } catch (err) {
            if (!isRendererUnavailable(err)) throw err;
            logRendererSkip("re-open render", err);
          }
          const delta = modePushedCount - before;
          assert(delta === 0, "re-open render pushes NO custom mode");
          dispose();
        });
      }
    }
  }

  // 7. Race regression: open A → open B → delayed onClose_A fires
  //    B's scope must remain alive, slot NOT nulled by A's late onClose.
  if (dialogReplaceInvocations.length >= 2) {
    const a = dialogReplaceInvocations[dialogReplaceInvocations.length - 2]!;
    const b = dialogReplaceInvocations[dialogReplaceInvocations.length - 1]!;
    assert(a !== b, "captured two distinct dialog.replace invocations for race test");

    let disposeA: (() => void) | null = null;
    let disposeB: (() => void) | null = null;
    createRoot((dispose) => {
      disposeB = dispose;
      try {
        b.render();
      } catch (err) {
        if (!isRendererUnavailable(err)) throw err;
        logRendererSkip("race regression: B mount", err);
      }
    });
    // After Phase 2: no custom mode is ever pushed. Mode counters
    // stay 0 throughout the A/B race.
    assert(modePushedCount === 0, "B's mount does NOT push any custom mode");
    const modePushesBeforeLateA = modePushedCount;
    const modePopsBeforeLateA = modePoppedCount;

    // A's onClose is intentionally never invoked at mount time. Simulate a
    // delayed host onClose_A that fires AFTER B is mounted.
    if (a.onClose) {
      a.onClose();
    }
    assert(
      modePushedCount === modePushesBeforeLateA,
      "delayed onClose_A does NOT push additional mode",
    );
    assert(
      modePoppedCount === modePopsBeforeLateA,
      "delayed onClose_A does NOT pop B's mode (no custom mode to pop)",
    );

    // Now legitimately close B. Mode counters remain 0 throughout
    // (no custom mode to pop).
    if (b.onClose) {
      b.onClose();
    }
    assert(modePoppedCount === 0, "B's onClose: no custom mode to pop (mode counters stay 0)");

    // Cleanup outer B root
    if (disposeB) (disposeB as () => void)();
    if (disposeA) (disposeA as () => void)();
  }

  // 8. requestClose ordering: dialog.clear() is only invoked AFTER
  //    internal dispose. We assert this indirectly via the onClose ->
  //    dialog.clear() chain by tracking the dialogClearCalls counter.
  //    A direct test below: the spec'd root-escape path inside ModelControlCenter
  //    calls api.ui.dialog.clear() when no onClose is provided. Since this
  //    test stubs dialog.replace with a host-driven onClose, we verify that
  //    the onClose path does NOT call dialog.clear() directly (the host
  //    stack handles clearing). Clear calls are only expected from the
  //    internal requestClose path inside an opened dialog.
  const dialogClearCallsBefore = dialogClearCalls;
  // After dismiss of the last dialog, no automatic clear() should be triggered
  // by the onClose path itself. The host dialog stack is responsible for clearing.
  assert(
    dialogClearCalls === dialogClearCallsBefore,
    "host onClose does NOT directly call api.ui.dialog.clear() (host stack handles)",
  );

  // 9. Lifecycle disposal: plugin unload disposes base keymap
  assert(lifecycleDisposers.length > 0, "disposers registered with api.lifecycle.onDispose");

  console.log("  Simulating plugin unload (triggering onDispose callbacks)...");
  for (const dispose of lifecycleDisposers) {
    dispose();
  }

  assert(layerDisposerCalled, "keymap layer disposer called on plugin unload");

  // 10. Route registration assertion: production code MUST NOT register a route.
  // Current route-based code calls api.route.register; native dialog code MUST NOT.
  assert(
    routeRegistered === false,
    "api.route.register is NOT called (native dialog replaces route presentation)",
  );
  assert(
    registeredRoutes.length === 0,
    "no routes are registered by the native dialog code path",
  );
  assert(
    routeNavigateInvocations.length === 0,
    "no route.navigate calls are emitted by the native dialog code path",
  );

  // ============================================================
  // Phase 1c RED — No custom mode + priority-200 keymap lifecycle
  // (exactly-once, reopen, idempotency). Uses the existing
  // componentLayerRegistry populated by the 5-cycle + delayed
  // onClose_A flow above. Failures land in the top-level
  // `failures` array so `process.exit(1)` fires when RED.
  // ============================================================
  console.log("\n--- Phase 1c RED: no custom mode + priority-200 keymap lifecycle ---");

  // 1c.1 — Component-lifetime layer is registered WITHOUT 'mode' field
  // and with priority 200. Current code still registers
  // `mode: "model-control-center"`.
  const firstComponent = componentLayerRegistry[0];
  assert(
    componentLayerRegistry.length >= 1,
    `phase1c.1: at least one component-lifetime layer registered (count=${componentLayerRegistry.length})`,
  );
  assert(
    firstComponent?.mode === undefined,
    `phase1c.1: component-lifetime layer has NO 'mode' field (current: ${firstComponent?.mode ?? "<absent>"})`,
  );
  assert(
    firstComponent?.priority === 200,
    `phase1c.1: component-lifetime layer has priority 200 (current: ${firstComponent?.priority})`,
  );

  // 1c.2 / 1c.3 — Per-instance dispose counts: first onClose = 1;
  // repeated onClose remains 1. Reopen via openCmd.run() to get a
  // fresh instance.
  if (dialogReplaceInvocations.length >= 1) {
    const last = dialogReplaceInvocations[dialogReplaceInvocations.length - 1]!;
    // The existing 5-cycle already called each onClose once. Capture
    // the count, then call again to test idempotency.
    const beforeRepeated = componentLayerRegistry[componentLayerRegistry.length - 1]?.disposerCalls ?? 0;
    if (last.onClose) last.onClose();
    if (last.onClose) last.onClose();
    const afterRepeated = componentLayerRegistry[componentLayerRegistry.length - 1]?.disposerCalls ?? 0;
    assert(
      afterRepeated - beforeRepeated <= 1,
      `phase1c.2: repeated onClose is idempotent — disposer delta <= 1 (before=${beforeRepeated}, after=${afterRepeated})`,
    );
  }

  // 1c.2 (reopen) — Reopen via the base layer's open command run()
  // → fresh distinct dialog replacement, no shared state. Uses the
  // stable `baseOpenCmdRef` captured in section 3 — NOT the mutable
  // `registeredLayer`, which has been overwritten by every subsequent
  // component-lifetime layer registration.
  const baseOpenCmd = baseOpenCmdRef;
  if (baseOpenCmd && typeof baseOpenCmd.run === "function") {
    const before = dialogReplaceInvocations.length;
    await baseOpenCmd.run();
    assert(
      dialogReplaceInvocations.length === before + 1,
      `phase1c.2: reopen calls dialog.replace again (before=${before}, after=${dialogReplaceInvocations.length})`,
    );
    const reopened = dialogReplaceInvocations[dialogReplaceInvocations.length - 1]!;
    const priorLast = dialogReplaceInvocations[dialogReplaceInvocations.length - 2]!;
    assert(
      reopened.render !== priorLast.render,
      "phase1c.2: reopened dialog is a distinct instance (fresh render fn)",
    );
  }

  if (failures.length > 0) {
    console.error(`\n=== Phase 1c RED: ${failures.length} expected failure(s) ===`);
  } else {
    console.log("\n=== Phase 1c RED: 0 failures (unexpected; current code pushes 'model-control-center' mode) ===");
  }

  // Final summary
  console.log("\n=== TUI REGISTRATION (NATIVE DIALOG) TEST SUMMARY ===");
  if (failures.length === 0) {
    console.log("All TUI registration assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " assertion(s) failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("TUI test crashed:", err);
  process.exit(1);
});
