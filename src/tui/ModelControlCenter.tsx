import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import { createComponent } from "solid-js/web";
import MainMenu from "./MainMenu.js";
import {
  createInitialStack,
  handleNavigation,
  type NavigationEvent,
  type ScreenState,
} from "./navigation.js";

export interface ModelControlCenterProps {
  api: TuiPluginApi;
}

export function ModelControlCenter(props: ModelControlCenterProps): JSX.Element {
  const [stack, setStack] = createSignal<ScreenState[]>(createInitialStack());
  const initialRouteName = props.api.route?.current?.name ?? "home";

  function dispatch(event: NavigationEvent): void {
    const result = handleNavigation(stack(), event);
    if (result.exited) {
      if (props.api.route?.navigate) {
        props.api.route.navigate(initialRouteName);
      }
    } else {
      setStack(result.stack);
    }
  }

  // Register mode-scoped keymap layer for Model Control Center TUI
  if (props.api.keymap?.registerLayer) {
    const layerDisposer = props.api.keymap.registerLayer({
      mode: "model-control-center",
      priority: 200,
      commands: [
        {
          name: "mcc.nav.up",
          title: "Move Selection Up",
          run: () => dispatch({ type: "up" }),
        },
        {
          name: "mcc.nav.down",
          title: "Move Selection Down",
          run: () => dispatch({ type: "down" }),
        },
        {
          name: "mcc.nav.activate",
          title: "Activate Selection",
          run: () => dispatch({ type: "activate" }),
        },
        {
          name: "mcc.nav.back",
          title: "Back / Exit Screen",
          run: () => dispatch({ type: "back" }),
        },
        {
          name: "mcc.nav.tab-next",
          title: "Next Detail Tab",
          run: () => dispatch({ type: "tab-next" }),
        },
        {
          name: "mcc.nav.tab-prev",
          title: "Previous Detail Tab",
          run: () => dispatch({ type: "tab-prev" }),
        },
      ],
      bindings: [
        { key: "up", cmd: "mcc.nav.up" },
        { key: "down", cmd: "mcc.nav.down" },
        { key: "enter", cmd: "mcc.nav.activate" },
        { key: "esc", cmd: "mcc.nav.back" },
        { key: "tab", cmd: "mcc.nav.tab-next" },
        { key: "shift+tab", cmd: "mcc.nav.tab-prev" },
      ],
    });

    onCleanup(() => {
      if (typeof layerDisposer === "function") {
        layerDisposer();
      }
    });
  }

  const currentScreen = (): ScreenState => {
    const currentStack = stack();
    return currentStack[currentStack.length - 1] ?? { name: "main-menu", selectedIndex: 0 };
  };

  const renderActiveScreen = (): JSX.Element => {
    const screen = currentScreen();
    switch (screen.name) {
      case "main-menu":
        return createComponent(MainMenu, { selectedIndex: screen.selectedIndex, api: props.api });

      case "providers":
        return createComponent(props.api.ui.DialogAlert, {
          title: "Providers",
          message: "Providers placeholder view (Task 3)",
        });

      case "quarantines":
        return createComponent(props.api.ui.DialogAlert, {
          title: "Quarantines",
          message: "Quarantines placeholder view (Task 5)",
        });

      case "models":
        return createComponent(props.api.ui.DialogAlert, {
          title: "Models",
          message: `Models placeholder view for ${screen.providerId} (Task 4)`,
        });

      case "model-detail":
        return createComponent(props.api.ui.DialogAlert, {
          title: "Model Detail",
          message: `Model detail placeholder view (${screen.modelId}, tab: ${screen.tab}) (Task 4)`,
        });
    }
  };

  return renderActiveScreen();
}

export default ModelControlCenter;
