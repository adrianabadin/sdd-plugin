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
import type { JSX } from "@opentui/solid";
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

/**
 * OpenTUI's real intrinsic elements (`jsx("box"/"text")`) require the
 * native FFI renderer, which is only available under Bun. This process
 * runs under Node (`tsx`), so directly invoking MainMenu/ModelControlCenter
 * (which construct plain-JSX production content) throws here by design —
 * it is NOT a lifecycle or keymap-contract bug. Keymap layer registration
 * happens synchronously BEFORE the JSX construction point inside these
 * components, so registration/binding assertions remain valid even when
 * this guard swallows the downstream content-construction error. Content
 * correctness is proven by `test:tui:bun` and the real-host PTY gate.
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

  // 4b. Task 3 Reducer Extension: Providers, Models, Search Events, Esc Dual-Role, '/' Key
  console.log("\n4b. Testing Task 3 Reducer Extension & Esc Dual-Role...");
  let provScreen: ScreenState = { name: "providers", selectedIndex: 0 };

  // Up/down cyclic on providers screen
  provScreen = transitionScreen(provScreen, { type: "down" }, 3);
  assert(provScreen.name === "providers" && provScreen.selectedIndex === 1, "Down on providers advances selectedIndex");
  provScreen = transitionScreen(provScreen, { type: "up" }, 3);
  assert(provScreen.name === "providers" && provScreen.selectedIndex === 0, "Up on providers decreases selectedIndex");

  // '/' on providers screen is a no-op
  const provSlash = transitionScreen(provScreen, { type: "search-start" });
  assert(JSON.stringify(provSlash) === JSON.stringify(provScreen), "'/' (search-start) on providers screen is a no-op");

  // Models screen state with searchActive and query
  let modScreen: ScreenState = {
    name: "models",
    providerId: "openai",
    selectedIndex: 0,
    query: "",
    searchActive: false,
  };

  // '/' (search-start) on models screen activates search mode
  modScreen = transitionScreen(modScreen, { type: "search-start" });
  assert(
    modScreen.name === "models" && modScreen.searchActive === true,
    "'/' (search-start) on models screen sets searchActive to true"
  );

  // search-input updates query
  modScreen = transitionScreen(modScreen, { type: "search-input", query: "gpt" });
  assert(
    modScreen.name === "models" && modScreen.query === "gpt",
    "search-input updates model search query to 'gpt'"
  );

  // Esc when searchActive=true triggers search-stop (exits search mode KEEPING query)
  modScreen = transitionScreen(modScreen, { type: "search-stop" });
  assert(
    modScreen.name === "models" && modScreen.searchActive === false && modScreen.query === "gpt",
    "search-stop (Esc) exits search mode while preserving query ('gpt')"
  );

  // Back handling in handleNavigation: when searchActive=true, back event emits search-stop instead of popping stack
  let modStack: ScreenState[] = [
    { name: "main-menu", selectedIndex: 0 },
    { name: "providers", selectedIndex: 0 },
    { name: "models", providerId: "openai", selectedIndex: 0, query: "gpt", searchActive: true },
  ];

  let navRes = handleNavigation(modStack, { type: "back" });
  assert(navRes.stack.length === 3, "Esc with searchActive=true does NOT pop stack (height remains 3)");
  const topScreen = navRes.stack[navRes.stack.length - 1];
  assert(
    topScreen?.name === "models" && topScreen.searchActive === false && topScreen.query === "gpt",
    "Esc with searchActive=true exits search mode and preserves query 'gpt'"
  );

  // Esc again (searchActive=false) pops stack to providers
  navRes = handleNavigation(navRes.stack, { type: "back" });
  assert(navRes.stack.length === 2, "Esc with searchActive=false pops stack (height becomes 2)");
  assert(navRes.stack[1]?.name === "providers", "Returned to providers screen");

  // 4c. Task 4 Focus & Detail Screen Navigation Rules
  console.log("\n4c. Testing Task 4 Focus & Detail Screen Navigation Rules...");
  let detailFocusScreen: ScreenState = {
    name: "model-detail",
    providerId: "openai",
    modelId: "gpt-4o",
    tab: "overview",
    focus: { area: "tabs" },
  };

  // Enter on tabs focus moves focus to fields area index 0
  detailFocusScreen = transitionScreen(detailFocusScreen, { type: "activate" });
  assert(
    detailFocusScreen.name === "model-detail" &&
      detailFocusScreen.focus?.area === "fields" &&
      detailFocusScreen.focus.index === 0,
    "Enter on tab strip enters field focus area (index 0)"
  );

  // Tab-next in field focus advances field index
  detailFocusScreen = transitionScreen(detailFocusScreen, { type: "tab-next" });
  assert(
    detailFocusScreen.name === "model-detail" &&
      detailFocusScreen.focus?.area === "fields" &&
      detailFocusScreen.focus.index === 1,
    "Tab-next in field focus advances field index to 1"
  );

  // Esc / back when in fields focus exits back to tabs focus (area: 'tabs'), keeping screen
  let detailStack: ScreenState[] = [
    { name: "main-menu", selectedIndex: 0 },
    { name: "providers", selectedIndex: 0 },
    { name: "models", providerId: "openai", selectedIndex: 0, query: "", searchActive: false },
    detailFocusScreen,
  ];

  const escRes = handleNavigation(detailStack, { type: "back" });
  const topFocusScreen = escRes.stack[escRes.stack.length - 1];
  assert(
    topFocusScreen?.name === "model-detail" && topFocusScreen.focus?.area === "tabs",
    "Esc in field focus exits field focus back to tabs focus"
  );
  console.log("\n5. Testing MainMenu Component Rendering...");
  let registeredLayer: any = null;
  let layerDisposed = false;
  let onCloseCallback: (() => void) | null = null;

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
      navigate: () => {},
      current: { name: "home" },
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
    try {
      const element0 = MainMenu({ selectedIndex: 0, api: mockApi });
      assert(Boolean(element0), "MainMenu renders element for index 0");
    } catch (err) {
      if (!isRendererUnavailable(err)) throw err;
      logRendererSkip("MainMenu renders element for index 0", err);
    }
    try {
      const element1 = MainMenu({ selectedIndex: 1, api: mockApi });
      assert(Boolean(element1), "MainMenu renders element for index 1");
    } catch (err) {
      if (!isRendererUnavailable(err)) throw err;
      logRendererSkip("MainMenu renders element for index 1", err);
    }
    dispose();
  });

  // 6. ModelControlCenter Component Lifecycle & Mode Keymap Registration
  console.log("\n6. Testing ModelControlCenter Component & Keymap Layer...");

  createRoot((dispose) => {
    try {
      const rootElement = ModelControlCenter({
        api: mockApi,
        onClose: () => {
          onCloseCallback = () => {};
          onCloseCallback();
        },
      });
      assert(Boolean(rootElement), "ModelControlCenter returns root element");
    } catch (err) {
      if (!isRendererUnavailable(err)) throw err;
      logRendererSkip("ModelControlCenter returns root element", err);
    }
    assert(Boolean(registeredLayer), "Component-lifetime keymap layer was registered");
    // After Phase 2: the MCC keymap layer is modeless (no `mode` field)
    // and priority-200. Host owns the modal surface; we do not push a
    // competing mode.
    assert(
      !("mode" in registeredLayer),
      "Keymap layer has NO 'mode' field (modeless; host owns modal)",
    );
    assert(registeredLayer.priority === 200, "Keymap layer priority is 200");
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

    // Test Esc at root invokes onClose (native dialog contract).
    let onCloseFired = false;
    try {
      const rootElement2 = ModelControlCenter({
        api: mockApi,
        onClose: () => {
          onCloseFired = true;
        },
      });
      assert(Boolean(rootElement2), "ModelControlCenter with onClose returns root element");
    } catch (err) {
      if (!isRendererUnavailable(err)) throw err;
      logRendererSkip("ModelControlCenter with onClose returns root element", err);
    }
    const backCmd = registeredLayer.commands.find((c: any) => c.name === "mcc.nav.back");
    assert(Boolean(backCmd && typeof backCmd.run === "function"), "Found 'mcc.nav.back' command");
    if (backCmd && typeof backCmd.run === "function") {
      backCmd.run();
      assert(onCloseFired, "Esc at main menu root invokes props.onClose (native dialog contract)");
    }

    dispose();
    assert(layerDisposed, "Keymap layer is disposed when ModelControlCenter unmounts (cleanup)");
  });

  // 7. Integrated Host Dialog Mounting (native dialog replacement for route mounting)
  console.log("\n7. Testing SddTuiModule Dialog Mounting (native dialog contract)...");
  let baseLayerRegistrations = 0;
  let componentLayerDisposals = 0;
  let dialogReplaceInvocations = 0;
  let dialogClearInvocations = 0;
  let capturedDialogRender: (() => JSX.Element) | null = null;
  let capturedDialogOnClose: (() => void) | null = null;
  const dialogMockApi: TuiPluginApi = {
    ...mockApi,
    keymap: {
      registerLayer: (layer: any) => {
        if (layer.mode === "base") {
          baseLayerRegistrations++;
        }
        registeredLayer = layer;
        return () => {
          layerDisposed = true;
          if (layer.mode !== "base") {
            componentLayerDisposals++;
          }
        };
      },
    } as never,
    route: {
      register: () => () => {},
      navigate: () => {},
      current: { name: "home" },
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
      dialog: {
        replace: (render, onClose) => {
          dialogReplaceInvocations++;
          capturedDialogRender = render;
          capturedDialogOnClose = onClose ?? null;
        },
        clear: () => {
          dialogClearInvocations++;
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
  };

  await SddTuiModule.tui(dialogMockApi, undefined, {} as never);
  assert(baseLayerRegistrations === 1, "tui() registers the base keymap layer exactly once");
  // The open command is on the base layer; trigger it to call dialog.replace.
  const openCmd = registeredLayer?.commands?.find((c: any) => c.name === "model-control-center.open");
  assert(Boolean(openCmd && typeof openCmd.run === "function"), "open command is registered on the base layer");
  if (openCmd && typeof openCmd.run === "function") {
    (openCmd.run as () => void)();
    assert(dialogReplaceInvocations === 1, "open command invokes api.ui.dialog.replace");

    createRoot((dispose) => {
      try {
        (capturedDialogRender as (() => JSX.Element) | null)?.();
      } catch (err) {
        if (!isRendererUnavailable(err)) throw err;
        logRendererSkip("integrated root-Escape lifecycle", err);
      }

      const rootBackCmd = registeredLayer?.commands?.find((c: any) => c.name === "mcc.nav.back");
      assert(Boolean(rootBackCmd), "mounted dialog registers mcc.nav.back");
      assert(componentLayerDisposals === 0, "mounted dialog layer is active before root Escape");
      assert(dialogClearInvocations === 0, "dialog is not cleared before root Escape");

      rootBackCmd?.run();
      assert(componentLayerDisposals === 1, "root Escape synchronously disposes the instance layer once");
      assert(dialogClearInvocations === 1, "root Escape explicitly clears the host dialog once");

      capturedDialogOnClose?.();
      capturedDialogOnClose?.();
      assert(componentLayerDisposals === 1, "delayed/repeated host onClose remains idempotent");

      dispose();
      assert(componentLayerDisposals === 1, "outer disposal does not repeat the instance layer disposer");
    });

    const firstDialogRender = capturedDialogRender;
    (openCmd.run as () => void)();
    assert(dialogReplaceInvocations === 2, "reopen creates a fresh dialog replacement");
    assert(capturedDialogRender !== firstDialogRender, "reopen receives a fresh render closure");
    assert(componentLayerDisposals === 1, "reopen does not revive or redispose the prior layer");
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
