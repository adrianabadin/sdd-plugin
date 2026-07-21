/**
 * Test for TUI registration and keymap binding.
 * 
 * Goals:
 * 1. SddTuiPlugin registers a Ctrl+Alt+F keymap layer.
 * 2. SddTuiPlugin registers a route for /model-control-center.
 */
import { SddTuiPlugin } from "../src/tui.js";

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
  console.log("\n--- TUI Registration Test ---");

  let layerRegistered = false;
  let routeRegistered = false;
  let registeredLayer: any = null;
  let registeredRoute: any = null;

  const mockClient = {
    api: {
      keymap: {
        registerLayer: (layer: any) => {
          layerRegistered = true;
          registeredLayer = layer;
        }
      },
      router: {
        register: (route: any) => {
          routeRegistered = true;
          registeredRoute = route;
        }
      }
    }
  };

  const ctx: any = {
    project: "tui-test",
    client: mockClient,
    directory: "/test"
  };

  await SddTuiPlugin(ctx);

  assert(layerRegistered, "Ctrl+Alt+F keymap layer registered");
  if (registeredLayer) {
    assert(registeredLayer.key === "f", "key is 'f'");
    assert(Array.isArray(registeredLayer.mod) && registeredLayer.mod.includes("ctrl") && registeredLayer.mod.includes("alt"), "modifiers include ctrl and alt");
  }

  assert(routeRegistered, "Model Control Center route registered");
  if (registeredRoute) {
    assert(registeredRoute.path === "/model-control-center", "route path is '/model-control-center'");
  }

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
