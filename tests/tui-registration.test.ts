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
  let modePushed: string | null = null;
  let modeDisposeCalled = false;
  let disposerReturnedByModePush = () => { modeDisposeCalled = true; };
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
        modePushed = name;
        return disposerReturnedByModePush;
      }
    },
    lifecycle: {
      onDispose: (cb: () => void) => {
        lifecycleDisposers.push(cb);
      }
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

  // 4. Mode Push and Disposal via route render/terminate
  if (tuiRoute && typeof tuiRoute.render === "function") {
    const renderResult = tuiRoute.render();
    assert(modePushed === "model-control-center", "rendering the route pushes the mode");
    
    if (renderResult && typeof renderResult.terminate === "function") {
      renderResult.terminate();
      assert(modeDisposeCalled, "calling terminate on the render result disposes the mode");
    } else {
      assert(false, "render result should have a terminate function for mode cleanup");
    }
  }

  // 5. Lifecycle registration
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
