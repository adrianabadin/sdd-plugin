/**
 * Test for TUI registration and keymap binding with the real OpenCode TUI contract.
 */
import SddTuiModule from "../src/tui.js";

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
  let lifecycleDisposers: Array<() => void> = [];

  const mockApi = {
    keymap: {
      registerLayer: (layer: any) => {
        layerRegistered = true;
        registeredLayer = layer;
        return () => { /* layer disposer */ };
      }
    },
    route: {
      register: (routes: any[]) => {
        routeRegistered = true;
        registeredRoutes = routes;
      },
      navigate: (name: string) => {
        navigatedRoute = name;
      }
    },
    mode: {
      push: (name: string) => {
        modePushedCount++;
        return () => { modeDisposeCalledCount++; };
      }
    },
    lifecycle: {
      onDispose: (cb: () => void) => {
        lifecycleDisposers.push(cb);
      }
    }
  };

  await SddTuiModule.tui(mockApi as any);

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

  // 4. Mode Lifecycle (Corrected: No stacking on re-render)
  if (tuiRoute && typeof tuiRoute.render === "function") {
    console.log("  Simulating first render...");
    const result1 = tuiRoute.render();
    assert(modePushedCount === 1, "first render pushes the mode once");
    
    console.log("  Simulating second render (re-render)...");
    const result2 = tuiRoute.render();
    assert(modePushedCount === 1, "second render DOES NOT push the mode again (idempotent)");
    
    // Cleanup check: OpenCode TUI contract for route teardown 
    // is expected to be via a returned object or a specific lifecycle hook.
    // Based on review, if it's returning an object with 'onUnmount' or similar.
    if (result2 && typeof result2.onUnmount === "function") {
       result2.onUnmount();
       assert(modeDisposeCalledCount === 1, "onUnmount disposes the mode");
       
       console.log("  Simulating third render (after unmount)...");
       tuiRoute.render();
       assert(modePushedCount === 2, "rendering after unmount pushes the mode again");
    } else {
       // Check for alternative host cleanup (like a signal or returned disposer)
       assert(false, "Expected a route cleanup mechanism (e.g. onUnmount in render result)");
    }
  }

  // 5. Lifecycle registration (one-time TUI module cleanup)
  assert(lifecycleDisposers.length > 0, "disposer registered with api.lifecycle.onDispose");

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
