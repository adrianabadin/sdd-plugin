/**
 * Test for TUI registration and keymap binding with the real OpenCode TUI contract.
 */
import SddTuiModule, { renderPlaceholderRoute } from "../src/tui.js";
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

async function main(): Promise<void> {
  console.log("\n--- TUI Registration Test (Real Contract) ---");

  // 1. Module shape
  assert(SddTuiModule && typeof SddTuiModule === "object", "SddTuiModule is an object");
  assert(SddTuiModule.id === "sdd-plugin.tui", "id is 'sdd-plugin.tui'");
  assert(typeof SddTuiModule.tui === "function", "tui is a function");

  let layerRegistered = false;
  let registeredLayer: any = null;
  let routeRegistered = false;
  let registeredRoutes: TuiRouteDefinition[] = [];
  let navigatedRoute: string | null = null;
  let modePushedCount = 0;
  let modePoppedCount = 0;
  let layerDisposerCalled = false;
  let routeDisposerCalled = false;
  const lifecycleDisposers: Array<() => void> = [];

  let dialogAlertInvocations: Array<{ title?: string; message?: string }> = [];

  const mockApi: TuiPluginApi = {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: (layer: unknown) => {
        layerRegistered = true;
        registeredLayer = layer;
        return () => {
          layerDisposerCalled = true;
        };
      }
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
        navigatedRoute = name;
      },
      current: { name: "home" }
    },
    mode: {
      current: () => "base",
      push: (_name: string) => {
        modePushedCount++;
        return () => {
          modePoppedCount++;
        };
      }
    },
    ui: {
      DialogAlert: (props) => {
        dialogAlertInvocations.push(props);
        return createComponent((p) => null as unknown as JSX.Element, props);
      },
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
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (cb: () => void) => {
        lifecycleDisposers.push(cb);
        return () => {};
      }
    }
  };

  await SddTuiModule.tui(mockApi, undefined, {} as never);

  // 2. Keymap Registration
  assert(layerRegistered, "api.keymap.registerLayer called");
  if (registeredLayer) {
    assert(registeredLayer.mode === "base", "layer mode is 'base'");
    assert(Array.isArray(registeredLayer.commands), "layer has commands array");
    const openCmd = registeredLayer.commands.find((c: { name?: string; run?: () => Promise<void> | void }) => c.name === "model-control-center.open");
    assert(Boolean(openCmd), "found 'model-control-center.open' command");
    
    assert(Array.isArray(registeredLayer.bindings), "layer has bindings array");
    const binding = registeredLayer.bindings.find((b: { key?: string; cmd?: string }) => b.key === "alt+shift+m");
    assert(Boolean(binding && binding.cmd === "model-control-center.open"), "binding 'alt+shift+m' points to open command");
    // Guard against silent revert: the legacy 'ctrl+alt+f' binding collides with the host's
    // built-in `messages_page_down` (OpenCode 1.18.4) and MUST NOT be re-introduced.
    const legacyCollision = registeredLayer.bindings.find((b: { key?: string; cmd?: string }) => b.key === "ctrl+alt+f");
    assert(!legacyCollision, "legacy 'ctrl+alt+f' binding is absent (collides with host messages_page_down)");

    // Test command execution
    if (openCmd && typeof openCmd.run === "function") {
      await openCmd.run();
      assert(navigatedRoute === "model-control-center", "running command navigates to 'model-control-center'");
    }
  }

  // 3. Route Registration
  assert(routeRegistered, "api.route.register called");
  const tuiRoute = registeredRoutes.find((r) => r.name === "model-control-center");
  assert(Boolean(tuiRoute), "route 'model-control-center' is registered");
  assert(typeof tuiRoute?.render === "function", "route has a render function");

  // 4. Render Output & Host-realistic Solid Route Lifecycle (Leave & Re-entry)
  if (tuiRoute && typeof tuiRoute.render === "function") {
    console.log("  Simulating route entry (Solid root mount)...");
    let disposeRouteRoot: (() => void) | null = null;
    let renderResult: ReturnType<typeof tuiRoute.render> | null = null;

    createRoot((dispose) => {
      disposeRouteRoot = dispose;
      renderResult = tuiRoute.render({ params: {} });
    });

    assert(modePushedCount === 1, "route render pushes route-specific mode on mount");
    assert(modePoppedCount === 0, "mode remains active while route is mounted");
    assert(dialogAlertInvocations.length === 1, "route render invoked api.ui.DialogAlert host component");
    const lastInvocation = dialogAlertInvocations[dialogAlertInvocations.length - 1];
    assert(
      lastInvocation?.title === "Model Control Center" &&
        Boolean(lastInvocation?.message?.includes("Models")),
      "DialogAlert received correct title and message props per host contract"
    );

    console.log("  Simulating route leave (Solid root cleanup)...");
    if (disposeRouteRoot) {
      (disposeRouteRoot as () => void)();
    }

    assert(modePoppedCount === 1, "leaving route invokes Solid onCleanup and pops mode");

    console.log("  Simulating route re-entry (second Solid root mount)...");
    let disposeReentryRoot: (() => void) | null = null;
    createRoot((dispose) => {
      disposeReentryRoot = dispose;
      tuiRoute.render({ params: {} });
    });

    assert(modePushedCount === 2, "re-entering route pushes mode again");
    assert(modePoppedCount === 1, "re-entered route mode active before cleanup");

    if (disposeReentryRoot) {
      (disposeReentryRoot as () => void)();
    }
    assert(modePoppedCount === 2, "leaving re-entered route pops mode again");
  }

  // 5. Direct helper render check
  dialogAlertInvocations = [];
  renderPlaceholderRoute(mockApi);
  assert(dialogAlertInvocations.length === 1, "renderPlaceholderRoute invoked api.ui.DialogAlert");
  const directInvocation = dialogAlertInvocations[0];
  assert(
    directInvocation?.title === "Model Control Center" &&
      directInvocation?.message === "Model Control Center placeholder view",
    "renderPlaceholderRoute passes correct host-contract props to DialogAlert"
  );

  // 6. Lifecycle disposal
  assert(lifecycleDisposers.length > 0, "disposers registered with api.lifecycle.onDispose");
  
  // Trigger plugin unload cleanup
  console.log("  Simulating plugin unload (triggering onDispose callbacks)...");
  for (const dispose of lifecycleDisposers) {
    dispose();
  }

  assert(layerDisposerCalled, "keymap layer disposer called on plugin unload");
  assert(routeDisposerCalled, "route registration disposer called on plugin unload");

  console.log("\n=== TUI TEST SUMMARY ===");
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
