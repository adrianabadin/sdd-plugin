/**
 * Unit & Integration test for TUI navigation reducer, main menu, keyboard keymap, and route root.
 */
import {
  DETAIL_TABS,
  MENU_OPTIONS,
  createInitialStack,
  transitionScreen,
  handleNavigation,
  pushScreen,
  popScreen,
  type ScreenState,
  type NavigationEvent,
  type DetailTab,
} from "../src/tui/navigation.js";
import ModelControlCenter from "../src/tui/ModelControlCenter.js";
import MainMenu from "../src/tui/MainMenu.js";
import SddTuiModule from "../src/tui.js";
import type { TuiPluginApi, TuiRouteDefinition } from "@opencode-ai/plugin/tui";
import { createRoot } from "solid-js";

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
  console.log("\n--- TUI Navigation & Main Menu Test ---");

  // 1. Navigation Constants & Types
  console.log("\n1. Testing Navigation Constants...");
  assert(Array.isArray(DETAIL_TABS), "DETAIL_TABS is an array");
  assert(
    JSON.stringify(DETAIL_TABS) === JSON.stringify(["overview", "benchmarks", "pricing", "subscription"]),
    "DETAIL_TABS order is fixed: overview -> benchmarks -> pricing -> subscription"
  );
  assert(Array.isArray(MENU_OPTIONS), "MENU_OPTIONS is an array");
  assert(
    JSON.stringify(MENU_OPTIONS) === JSON.stringify(["models", "quarantines"]),
    "MENU_OPTIONS order is fixed: models -> quarantines"
  );

  // 2. Pure Transition Reducer - Main Menu Up/Down Cyclic Navigation
  console.log("\n2. Testing Main Menu Up/Down Cyclic Navigation...");
  const initialStack = createInitialStack();
  assert(initialStack.length === 1, "Initial stack has 1 screen");
  assert(
    initialStack[0]?.name === "main-menu" && initialStack[0]?.selectedIndex === 0,
    "Initial screen is main-menu with Models selected (index 0)"
  );

  let currentScreen: ScreenState = initialStack[0]!;

  // Down from index 0 -> index 1 (Quarantines)
  currentScreen = transitionScreen(currentScreen, { type: "down" });
  assert(
    currentScreen.name === "main-menu" && currentScreen.selectedIndex === 1,
    "Down from Models selects Quarantines (index 1)"
  );

  // Down from index 1 -> cyclic wrap to index 0 (Models)
  currentScreen = transitionScreen(currentScreen, { type: "down" });
  assert(
    currentScreen.name === "main-menu" && currentScreen.selectedIndex === 0,
    "Down from Quarantines wraps to Models (index 0)"
  );

  // Up from index 0 -> cyclic wrap to index 1 (Quarantines)
  currentScreen = transitionScreen(currentScreen, { type: "up" });
  assert(
    currentScreen.name === "main-menu" && currentScreen.selectedIndex === 1,
    "Up from Models wraps to Quarantines (index 1)"
  );

  // Up from index 1 -> index 0 (Models)
  currentScreen = transitionScreen(currentScreen, { type: "up" });
  assert(
    currentScreen.name === "main-menu" && currentScreen.selectedIndex === 0,
    "Up from Quarantines selects Models (index 0)"
  );

  // 3. Main Menu Activation (Enter) & Stack Operations
  console.log("\n3. Testing Activation (Enter) and Stack Operations...");
  let stack = createInitialStack();

  // Enter on Models (index 0) -> pushes providers
  let result = handleNavigation(stack, { type: "activate" });
  stack = result.stack;
  assert(!result.exited, "Enter on Models does not exit route");
  assert(stack.length === 2, "Stack height is 2 after Enter on Models");
  assert(stack[1]?.name === "providers", "Pushed screen is 'providers'");

  // Esc on providers -> pops back to main-menu with selectedIndex preserved
  result = handleNavigation(stack, { type: "back" });
  stack = result.stack;
  assert(!result.exited, "Esc on providers does not exit route");
  assert(stack.length === 1, "Stack height returned to 1");
  assert(
    stack[0]?.name === "main-menu" && stack[0]?.selectedIndex === 0,
    "Returned to main-menu with prior selection (0) preserved"
  );

  // Down to Quarantines (index 1) and Enter -> pushes quarantines
  stack = handleNavigation(stack, { type: "down" }).stack;
  result = handleNavigation(stack, { type: "activate" });
  stack = result.stack;
  assert(stack.length === 2, "Stack height is 2 after Enter on Quarantines");
  assert(stack[1]?.name === "quarantines", "Pushed screen is 'quarantines'");

  // Esc on quarantines -> pops back to main-menu with selectedIndex 1 preserved
  result = handleNavigation(stack, { type: "back" });
  stack = result.stack;
  assert(!result.exited, "Esc on quarantines does not exit route");
  assert(
    stack[0]?.name === "main-menu" && stack[0]?.selectedIndex === 1,
    "Returned to main-menu with prior selection (1) preserved"
  );

  // Esc on main-menu (root) -> route exit (exited: true)
  result = handleNavigation(stack, { type: "back" });
  assert(result.exited, "Esc on main-menu (root) signals route exit");
  assert(result.stack.length === 0, "Stack is empty after root Esc");

  // 4. Tab / Shift+Tab Navigation Rules
  console.log("\n4. Testing Tab / Shift+Tab Navigation Rules...");
  const mainMenuScreen: ScreenState = { name: "main-menu", selectedIndex: 0 };
  const tabNextOnMenu = transitionScreen(mainMenuScreen, { type: "tab-next" });
  const tabPrevOnMenu = transitionScreen(mainMenuScreen, { type: "tab-prev" });
  assert(
    JSON.stringify(tabNextOnMenu) === JSON.stringify(mainMenuScreen),
    "Tab on main menu is a no-op"
  );
  assert(
    JSON.stringify(tabPrevOnMenu) === JSON.stringify(mainMenuScreen),
    "Shift+Tab on main menu is a no-op"
  );

  let detailScreen: ScreenState = {
    name: "model-detail",
    providerId: "openai",
    modelId: "gpt-4o",
    tab: "overview",
  };

  // tab-next from overview -> benchmarks -> pricing -> subscription -> overview
  detailScreen = transitionScreen(detailScreen, { type: "tab-next" });
  assert(
    detailScreen.name === "model-detail" && detailScreen.tab === "benchmarks",
    "Tab-next advances overview -> benchmarks"
  );
  detailScreen = transitionScreen(detailScreen, { type: "tab-next" });
  assert(detailScreen.name === "model-detail" && detailScreen.tab === "pricing", "Tab-next advances benchmarks -> pricing");
  detailScreen = transitionScreen(detailScreen, { type: "tab-next" });
  assert(detailScreen.name === "model-detail" && detailScreen.tab === "subscription", "Tab-next advances pricing -> subscription");
  detailScreen = transitionScreen(detailScreen, { type: "tab-next" });
  assert(detailScreen.name === "model-detail" && detailScreen.tab === "overview", "Tab-next wraps subscription -> overview");

  // tab-prev from overview -> subscription -> pricing -> benchmarks -> overview
  detailScreen = transitionScreen(detailScreen, { type: "tab-prev" });
  assert(detailScreen.name === "model-detail" && detailScreen.tab === "subscription", "Tab-prev wraps overview -> subscription");
  detailScreen = transitionScreen(detailScreen, { type: "tab-prev" });
  assert(detailScreen.name === "model-detail" && detailScreen.tab === "pricing", "Tab-prev advances subscription -> pricing");

  // 5. MainMenu Component Render Structure
  console.log("\n5. Testing MainMenu Component Rendering...");
  let registeredLayer: any = null;
  let layerDisposed = false;
  let navigatedToRoute: string | null = null;

  const mockApi: TuiPluginApi = {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: (layer: any) => {
        registeredLayer = layer;
        return () => {
          layerDisposed = true;
        };
      },
    } as never,
    route: {
      register: () => () => {},
      navigate: (name: string) => {
        navigatedToRoute = name;
      },
      current: { name: "custom-previous-route" },
    },
    mode: {
      current: () => "model-control-center",
      push: () => () => {},
    },
    ui: {
      DialogAlert: (props: any) => props,
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
      onDispose: () => () => {},
    },
  };

  createRoot((dispose) => {
    const element0 = MainMenu({ selectedIndex: 0, api: mockApi });
    assert(Boolean(element0), "MainMenu renders element for index 0");
    const element1 = MainMenu({ selectedIndex: 1, api: mockApi });
    assert(Boolean(element1), "MainMenu renders element for index 1");
    dispose();
  });

  // 6. ModelControlCenter Component Lifecycle & Mode Keymap Registration
  console.log("\n6. Testing ModelControlCenter Component & Keymap Layer...");

  createRoot((dispose) => {
    const rootElement = ModelControlCenter({ api: mockApi });
    assert(Boolean(rootElement), "ModelControlCenter returns root element");
    assert(Boolean(registeredLayer), "Mode-scoped keymap layer was registered");
    assert(registeredLayer.mode === "model-control-center", "Keymap layer mode is 'model-control-center'");
    assert(Array.isArray(registeredLayer.commands), "Keymap layer has commands array");
    assert(Array.isArray(registeredLayer.bindings), "Keymap layer has bindings array");

    // Verify key bindings exist for required navigation actions
    const upBinding = registeredLayer.bindings.find((b: any) => b.key === "up");
    const downBinding = registeredLayer.bindings.find((b: any) => b.key === "down");
    const enterBinding = registeredLayer.bindings.find((b: any) => b.key === "enter");
    const escBinding = registeredLayer.bindings.find((b: any) => b.key === "esc");
    const tabBinding = registeredLayer.bindings.find((b: any) => b.key === "tab");
    const shiftTabBinding = registeredLayer.bindings.find((b: any) => b.key === "shift+tab");

    assert(Boolean(upBinding && upBinding.cmd === "mcc.nav.up"), "Binding 'up' -> 'mcc.nav.up'");
    assert(Boolean(downBinding && downBinding.cmd === "mcc.nav.down"), "Binding 'down' -> 'mcc.nav.down'");
    assert(Boolean(enterBinding && enterBinding.cmd === "mcc.nav.activate"), "Binding 'enter' -> 'mcc.nav.activate'");
    assert(Boolean(escBinding && escBinding.cmd === "mcc.nav.back"), "Binding 'esc' -> 'mcc.nav.back'");
    assert(Boolean(tabBinding && tabBinding.cmd === "mcc.nav.tab-next"), "Binding 'tab' -> 'mcc.nav.tab-next'");
    assert(Boolean(shiftTabBinding && shiftTabBinding.cmd === "mcc.nav.tab-prev"), "Binding 'shift+tab' -> 'mcc.nav.tab-prev'");

    // Test Esc at root navigates back to captured route ('custom-previous-route')
    const backCmd = registeredLayer.commands.find((c: any) => c.name === "mcc.nav.back");
    assert(Boolean(backCmd && typeof backCmd.run === "function"), "Found 'mcc.nav.back' command");
    if (backCmd && typeof backCmd.run === "function") {
      backCmd.run();
      assert(
        navigatedToRoute === "custom-previous-route",
        "Esc at main menu root navigates to captured entry route ('custom-previous-route')"
      );
    }

    dispose();
    assert(layerDisposed, "Keymap layer is disposed when ModelControlCenter unmounts (cleanup)");
  });

  // 7. Integrated Host Route Render
  console.log("\n7. Testing SddTuiModule Route Mounting...");
  let routeRegistered = false;
  let registeredRoutes: TuiRouteDefinition[] = [];
  const fullMockApi: TuiPluginApi = {
    ...mockApi,
    route: {
      register: (routes) => {
        routeRegistered = true;
        registeredRoutes = routes;
        return () => {};
      },
      navigate: () => {},
      current: { name: "home" },
    },
  };

  await SddTuiModule.tui(fullMockApi, undefined, {} as never);
  assert(routeRegistered, "TUI module registered route");
  const mccRoute = registeredRoutes.find((r) => r.name === "model-control-center");
  assert(Boolean(mccRoute), "Route 'model-control-center' registered");

  if (mccRoute && typeof mccRoute.render === "function") {
    createRoot((dispose) => {
      const element = mccRoute.render({ params: {} });
      assert(Boolean(element), "Route render returns component element");
      dispose();
    });
  }

  console.log("\n=== TUI NAVIGATION TEST SUMMARY ===");
  if (failures.length === 0) {
    console.log("All TUI navigation assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " assertion(s) failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("TUI navigation test crashed:", err);
  process.exit(1);
});
