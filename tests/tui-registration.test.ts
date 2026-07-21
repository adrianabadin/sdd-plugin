/**
 * Test for TUI registration and keymap binding with the real OpenCode TUI contract.
 */
import SddTuiModule, { TuiApi } from "../src/tui.js";

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
  let registeredRoutes: any[] = [];
  let navigatedRoute: string | null = null;
  let modePushedCount = 0;
  let modeDisposeCalledCount = 0;
  let layerDisposerCalled = false;
  let routeDisposerCalled = false;
  let modeDisposerCalled = false;
  const lifecycleDisposers: Array<() => void> = [];

  const mockApi: TuiApi = {
    lifecycle: {
      onDispose: (cb: () => void) => {
        lifecycleDisposers.push(cb);
      }
    },
    keymap: {
      registerLayer: (layer) => {
        layerRegistered = true;
        registeredLayer = layer;
        return () => {
          layerDisposerCalled = true;
        };
      }
    },
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
      }
    },
    mode: {
      push: (name: string) => {
        modePushedCount++;
        return () => {
          modeDisposerCalled = true;
          modeDisposeCalledCount++;
        };
      }
    },
    ui: {
      DialogAlert: (props: any) => ({
        type: "DialogAlert",
        props
      })
    }
  };

  await SddTuiModule.tui(mockApi);

  // 2. Keymap Registration
  assert(layerRegistered, "api.keymap.registerLayer called");
  if (registeredLayer) {
    assert(registeredLayer.mode === "base", "layer mode is 'base'");
    assert(Array.isArray(registeredLayer.commands), "layer has commands array");
    const openCmd = registeredLayer.commands.find((c: any) => c.name === "model-control-center.open");
    assert(openCmd, "found 'model-control-center.open' command");
    
    assert(Array.isArray(registeredLayer.bindings), "layer has bindings array");
    const binding = registeredLayer.bindings.find((b: any) => b.key === "ctrl+alt+f");
    assert(binding && binding.cmd === "model-control-center.open", "binding 'ctrl+alt+f' points to open command");

    // Test command execution
    if (openCmd && typeof openCmd.run === "function") {
      await openCmd.run();
      assert(navigatedRoute === "model-control-center", "running command navigates to 'model-control-center'");
    }
  }

  // 3. Route Registration
  assert(routeRegistered, "api.route.register called");
  const tuiRoute = registeredRoutes.find(r => r.name === "model-control-center");
  assert(tuiRoute, "route 'model-control-center' is registered");
  assert(typeof tuiRoute?.render === "function", "route has a render function");

  // 4. Render Output & Mode Lifecycle
  if (tuiRoute && typeof tuiRoute.render === "function") {
    console.log("  Simulating first render...");
    const result1 = tuiRoute.render() as Record<string, any>;
    assert(modePushedCount === 1, "first render pushes the mode once");
    
    // Validate host-compatible render output: must return a valid Solid element / UI component result from createComponent
    assert(result1 !== null && typeof result1 === "object", "render returns a non-null element object");
    assert(Object.keys(result1).length > 0, "render result is not a plain empty object {}");
    assert(result1.type === "DialogAlert", "render produces DialogAlert element via createComponent");
    assert(result1.props?.title === "Model Control Center", "render component has expected title");
    assert(typeof result1.props?.message === "string", "render component has expected message");

    console.log("  Simulating second render (re-render)...");
    const result2 = tuiRoute.render() as Record<string, any>;
    assert(modePushedCount === 1, "second render DOES NOT push the mode again (idempotent)");
    assert(result2 !== null && typeof result2 === "object" && Object.keys(result2).length > 0, "second render result is valid component element");
  }

  // 5. Lifecycle disposal
  assert(lifecycleDisposers.length > 0, "disposers registered with api.lifecycle.onDispose");
  
  // Trigger cleanup
  console.log("  Simulating plugin unload (triggering onDispose callbacks)...");
  for (const dispose of lifecycleDisposers) {
    dispose();
  }

  assert(layerDisposerCalled, "keymap layer disposer called on plugin unload");
  assert(routeDisposerCalled, "route registration disposer called on plugin unload");
  assert(modeDisposerCalled, "mode push disposer called on plugin unload");

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
