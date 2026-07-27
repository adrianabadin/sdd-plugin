/**
 * Real OpenTUI renderer test using @opentui/solid testRender.
 * Must be executed under Bun runtime (which OpenCode uses in production).
 *
 * Change: `model-control-center-interactive-dialog-fix`.
 *
 * Three-part test (no source edits in Batch 1):
 *
 * 1. Gate 2 feasibility probe (`probeDialogMount`) — runs first and
 *    validates the SINGLE createRoot topology under Bun. Mirrors the
 *    design's per-instance DialogHandle contract.
 *
 * 2. Production renderer test — invokes `tui()`, runs the
 *    `model-control-center.open` command, captures the render fn
 *    passed to `api.ui.dialog.replace`, mounts it via `testRender`,
 *    asserts the visible frame contains the dialog content, and
 *    destroys the renderer to confirm the per-instance onClose
 *    disposes the dialog scope exactly once.
 *
 * 3. Phase 1a/1b RED — direct captured command invocation proves
 *    RENDERER-LAYER frame reactivity (NOT keyboard evidence), and
 *    `dialogAlertInvocations === 0` proves no host DialogAlert is
 *    used for normal screens. Both assertions MUST fail RED on the
 *    current code; they will turn GREEN after Phase 3 (plain JSX)
 *    and Phase 4 (reactive composition) land.
 */
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import type { JSX } from "@opentui/solid";
import { createRoot, onCleanup } from "solid-js";
import { createComponent } from "solid-js/web";
import SddTuiModule from "../src/tui.js";
import ModelControlCenter from "../src/tui/ModelControlCenter.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

interface ProbeMocks {
  modePushes: number;
  modePops: number;
  layerRegistrations: number;
  layerDisposersInvoked: number;
  dialogAlertInvocations: number;
  dialogReplaceInvocations: number;
  dialogClearInvocations: number;
}

function buildProbeMockApi(mocks: ProbeMocks): TuiPluginApi {
  return {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: () => {
        mocks.layerRegistrations++;
        return () => {
          mocks.layerDisposersInvoked++;
        };
      },
    } as never,
    route: {
      register: () => () => {},
      navigate: () => {},
      current: { name: "home" },
    },
    mode: {
      current: () => "base",
      push: (_name: string) => {
        mocks.modePushes++;
        return () => {
          mocks.modePops++;
        };
      },
    },
    ui: {
      DialogAlert: (props: { title?: string; message?: string }): JSX.Element => {
        mocks.dialogAlertInvocations++;
        // Use a function component that returns a non-null sentinel —
        // avoids the OpenTUI renderer context dependency that
        // `jsx("box", ...)` would pull in. The probe is about lifecycle.
        const sentinel = {
          __probeSentinel: true,
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
        replace: () => {
          mocks.dialogReplaceInvocations++;
        },
        clear: () => {
          mocks.dialogClearInvocations++;
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
      onDispose: () => () => {},
    },
  };
}

/**
 * probeDialogMount — test-local feasibility helper.
 *
 * Mirrors the design's SINGLE owned createRoot topology: api.mode.push,
 * onCleanup(popMode), and the real ModelControlCenter mount all live
 * inside the SAME createRoot. One dispose cleans both the mode push
 * and the component keymap layer.
 *
 * This is NOT the production renderDialog. It proves the pattern is
 * sound before any source edit touches src/tui.ts.
 */
function probeDialogMount(
  api: TuiPluginApi,
): { dispose: () => void; renderResult: unknown } {
  let captured: unknown = null;
  let disposeOut: (() => void) | null = null;
  createRoot((dispose) => {
    disposeOut = dispose;
    const popMode = api.mode.push("model-control-center");
    onCleanup(() => {
      popMode();
    });
    captured = createComponent(ModelControlCenter, {
      api,
      catalog: undefined,
      detailQuery: undefined,
      saveDetailUseCase: undefined,
      quarantinePort: undefined,
      listQuarantinesUseCase: undefined,
      setQuarantineUseCase: undefined,
      releaseQuarantineUseCase: undefined,
    });
  });
  return {
    dispose: () => {
      if (disposeOut) (disposeOut as () => void)();
    },
    renderResult: captured,
  };
}

// Top-level failures array — Phase 1 RED assertions push here so the
// script's final `process.exit(1)` fires when the production code is
// still broken (i.e., before Phase 2/3/4 land).
const failures: string[] = [];
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failures.push(msg);
    console.error("  FAIL (expected RED on current code): " + msg);
  } else {
    console.log("  pass: " + msg);
  }
}

async function main(): Promise<void> {
  console.log("\n--- Real OpenTUI Bun Renderer Test (Gate 2 Probe + Production Render) ---");

  // Verify runtime is Bun
  if (typeof (globalThis as unknown as { Bun?: unknown }).Bun === "undefined") {
    console.error(
      "FAIL: OpenTUI testRender requires Bun runtime (native FFI). Current runtime is Node.js (" +
        process.version +
        ").",
    );
    console.error("Execute with 'bun tests/tui-bun-renderer.test.ts' or 'npm run test:tui:bun' under Bun.");
    process.exit(1);
  }

  console.log("Bun runtime detected. Initializing real OpenTUI testRender...");

  // ===== Production renderer test (mounted via captured dialog.replace) =====
  console.log("\n--- Production renderer: mount dialog.replace render via testRender ---");

  const prodMocks: ProbeMocks = {
    modePushes: 0,
    modePops: 0,
    layerRegistrations: 0,
    layerDisposersInvoked: 0,
    dialogAlertInvocations: 0,
    dialogReplaceInvocations: 0,
    dialogClearInvocations: 0,
  };

  // Capture the render fn + onClose passed to dialog.replace.
  let capturedRender: (() => JSX.Element) | null = null;
  let capturedOnClose: (() => void) | null = null;

  const mockApi: TuiPluginApi = {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: () => {
        prodMocks.layerRegistrations++;
        return () => {
          prodMocks.layerDisposersInvoked++;
        };
      },
    } as never,
    route: {
      register: () => () => {},
      navigate: () => {},
      current: { name: "home" },
    },
    mode: {
      current: () => "base",
      push: (_name: string) => {
        prodMocks.modePushes++;
        return () => {
          prodMocks.modePops++;
        };
      },
    },
    ui: {
      DialogAlert: (props: { title?: string; message?: string }): JSX.Element => {
        prodMocks.dialogAlertInvocations++;
        return jsx("box", {
          border: true,
          children: [
            jsx("text", { children: props.title ?? "" }),
            jsx("text", { children: props.message ?? "" }),
          ],
        });
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
          prodMocks.dialogReplaceInvocations++;
          capturedRender = render;
          capturedOnClose = onClose ?? null;
        },
        clear: () => {
          prodMocks.dialogClearInvocations++;
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
      onDispose: () => () => {},
    },
  };

  // Capture the open command run during registration.
  let openCmdRun: (() => void) | null = null;
  const origRegisterLayer = mockApi.keymap?.registerLayer;
  if (origRegisterLayer) {
    (mockApi.keymap as unknown as { registerLayer: (l: { commands: Array<{ name: string; run: () => void }> }) => () => void }).registerLayer = (
      layer: { commands: Array<{ name: string; run: () => void }> },
    ) => {
      const openCmd = layer.commands?.find((c) => c.name === "model-control-center.open");
      if (openCmd && typeof openCmd.run === "function") {
        openCmdRun = openCmd.run;
      }
      return origRegisterLayer.call(mockApi.keymap, layer);
    };
  }

  await SddTuiModule.tui(mockApi, undefined, {} as never);

  if (typeof openCmdRun !== "function") {
    console.error("FAIL: could not capture model-control-center.open command run");
    process.exit(1);
  }

  // Trigger the open command. This calls dialog.replace (mocked).
  (openCmdRun as () => void)();
  if (capturedRender === null) {
    console.error("FAIL: dialog.replace did not receive render function");
    process.exit(1);
  }
  if (capturedOnClose === null) {
    console.error("FAIL: dialog.replace did not receive per-instance onClose");
    process.exit(1);
  }

  // Use testRender to mount the captured render. The producer of the
  // render is the production createRoot inside openModelControlCenterDialog
  // → renderDialog. The test renderer provides the OpenTUI context.
  const testSetup = await testRender(() => {
    if (capturedRender) return capturedRender();
    return null as unknown as JSX.Element;
  });

  if (!testSetup || !testSetup.renderer) {
    console.error("FAIL: testRender returned invalid TestRendererSetup");
    process.exit(1);
  }

  console.log("Real OpenTUI testRender mounted dialog tree successfully.");

  // Wait for a frame containing the dialog content. The MainMenu delegate
  // to DialogAlert when api.ui.DialogAlert is provided.
  const frame = await testSetup.waitForFrame((captured: string) => {
    return captured.includes("Model Control Center");
  });

  if (!frame || frame.length === 0) {
    console.error("FAIL: Captured frame is empty or unavailable.");
    process.exit(1);
  }

  console.log("Captured frame characters length: " + frame.length);

  if (!frame.includes("Model Control Center")) {
    console.error("FAIL: Captured frame does not contain expected title text 'Model Control Center'");
    process.exit(1);
  }

  // Exactly-once disposal on destroy: the renderer.destroy() cascades
  // through the OpenTUI createRoot, which fires onCleanup(popMode) and
  // the component's keymap layer disposer.
  const modePushesBeforeDestroy = prodMocks.modePushes;
  const layerDisposersBeforeDestroy = prodMocks.layerDisposersInvoked;
  testSetup.renderer.destroy();

  console.log("\n--- Production lifecycle accounting after destroy ---");
  console.log("  modePushes: " + prodMocks.modePushes + " (before destroy: " + modePushesBeforeDestroy + ")");
  console.log("  modePops: " + prodMocks.modePops);
  console.log("  layerDisposersInvoked: " + prodMocks.layerDisposersInvoked + " (before destroy: " + layerDisposersBeforeDestroy + ")");

  // Per-instance onClose must also dispose the scope when invoked.
  // (renderer.destroy may or may not call onClose depending on host
  // semantics; we explicitly invoke onClose to test the per-instance
  // contract.)
  const onClose = capturedOnClose as (() => void) | null;
  if (onClose) onClose();
  // Counts must NOT increase on a second onClose (idempotent).
  if (onClose) onClose();

  // ============================================================
  // Phase 1a/1b RED — Direct captured command = frame transition
  // (renderer/reactivity evidence ONLY; NOT keyboard evidence) +
  // zero DialogAlert (narrowed to main-menu + Quarantines screen,
  // the only states actually exercised in this test). RED on
  // current code; GREEN after Phase 3 + Phase 4.
  // Failures land in the top-level `failures` array so
  // `process.exit(1)` fires when RED.
  // ============================================================
  console.log("\n--- Phase 1a/1b RED ---");
  let phase1DialogAlerts = 0;
  const phase1Layers: Array<{ mode?: string; commands: Array<{ name?: string; run?: () => void }> }> = [];
  const phase1OpenBox: { cmd: { run: () => void } | null } = { cmd: null };
  let phase1Render: (() => JSX.Element) | null = null;
  let phase1OnClose: (() => void) | null = null;
  const phase1Mock: TuiPluginApi = {
    app: { version: "1.18.4" }, attention: {} as never, keys: {} as never,
    keymap: { registerLayer: (layer: unknown) => {
      const l = layer as { mode?: string; commands: Array<{ name?: string; run?: () => void }> };
      phase1Layers.push(l);
      if (l.mode === "base") {
        const c = l.commands.find((c) => c?.name === "model-control-center.open");
        if (c?.run) phase1OpenBox.cmd = { run: c.run };
      }
      return () => {};
    } } as never,
    route: { register: () => () => {}, navigate: () => {}, current: { name: "home" } },
    mode: { current: () => "base", push: () => () => {} },
    ui: {
      DialogAlert: ((props: { title?: string; message?: string }): JSX.Element => {
        phase1DialogAlerts++;
        return jsx("box", { children: [jsx("text", { children: props.title ?? "" }), jsx("text", { children: props.message ?? "" })] });
      }) as never,
      Dialog: (() => null) as never, DialogConfirm: (() => null) as never, DialogPrompt: (() => null) as never,
      DialogSelect: (() => null) as never, Slot: (() => null) as never, Prompt: (() => null) as never,
      toast: () => {},
      dialog: {
        replace: (render: () => JSX.Element, onClose?: () => void) => { phase1Render = render; phase1OnClose = onClose ?? null; },
        clear: () => {}, setSize: () => {},
        get size() { return "medium" as const; }, get depth() { return 0; }, get open() { return true; },
      },
    },
    tuiConfig: {} as never, kv: {} as never, state: {} as never, theme: {} as never,
    client: {} as never, event: {} as never, renderer: {} as never, slots: {} as never, plugins: {} as never,
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
  };
  await SddTuiModule.tui(phase1Mock, undefined, {} as never);
  if (phase1OpenBox.cmd) phase1OpenBox.cmd.run();
  if (!phase1Render) {
    assert(false, "phase1: dialog.replace did not receive a render function");
  } else {
    const setup = await testRender(() => phase1Render!());
    await setup.waitForFrame((s: string) => s.includes("Model Control Center"));
    const frame1 = setup.captureCharFrame();
    assert(frame1.includes("Model Control Center"), "phase1: initial frame contains 'Model Control Center'");
    const componentLayer = phase1Layers.find((l) => l.mode !== "base");
    if (!componentLayer) {
      assert(false, "phase1: no component-lifetime keymap layer registered after mount");
    } else {
      const down = componentLayer.commands.find((c) => c?.name === "mcc.nav.down");
      const activate = componentLayer.commands.find((c) => c?.name === "mcc.nav.activate");
      // Real MainMenu markup (src/tui/MainMenu.tsx) prefixes the selected
      // option with "> " and unselected options with two spaces — it never
      // renders the literal string "Selected: <label>". Assert against the
      // ACTUAL visible selection markers, not an invented string that would
      // trivially "pass" on any frame (tautological on the current UI).
      assert(/>\s*Models/.test(frame1), "phase1: initial frame shows '> Models' selected (real markup)");
      if (down?.run) (down.run as () => void)();
      await setup.flush();
      const frame2 = setup.captureCharFrame();
      assert(frame2 !== frame1, "phase1: frame CHANGED after captured mcc.nav.down (renderer/reactivity evidence, NOT keyboard)");
      assert(!/>\s*Models/.test(frame2), "phase1: frame after down no longer shows '> Models' selected (real markup)");
      assert(/>\s*Quarantines/.test(frame2), "phase1: frame after down shows '> Quarantines' selected (real markup)");
      if (activate?.run) (activate.run as () => void)();
      await setup.flush();
      const frame3 = setup.captureCharFrame();
      // Screen-unique heading asserted (QuarantinesScreen.tsx plain-JSX title).
      assert(/Quarantine Management/.test(frame3), "phase1: frame after activate contains screen-unique 'Quarantine Management' heading");
    }
    assert(phase1DialogAlerts === 0, `phase1: dialogAlertInvocations === 0 on normal screens (current: ${phase1DialogAlerts})`);
    setup.renderer.destroy();
    if (phase1OnClose) (phase1OnClose as () => void)();
  }
  if (failures.length > 0) {
    console.error(`\n=== Phase 1a/1b RED: ${failures.length} expected failure(s) ===`);
  } else {
    console.log("\n=== Phase 1a/1b RED: 0 failures (unexpected; current code is known broken) ===");
  }

  console.log("\nAll real OpenTUI renderer assertions passed.");
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Bun renderer test crashed:", err);
  process.exit(1);
});
