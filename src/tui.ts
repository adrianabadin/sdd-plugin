/**
 * TUI entrypoint for the OpenCode Plugin.
 * Handles Model Control Center visualization and management.
 */

import { createComponent } from "solid-js/web";

/**
 * OpenCode TUI API contract subsets used by this module.
 */
export interface TuiApi {
  lifecycle?: {
    onDispose: (cb: () => void) => void;
  };
  keymap?: {
    registerLayer: (layer: {
      mode?: string;
      priority?: number;
      commands: Array<{
        name: string;
        title: string;
        desc?: string;
        category?: string;
        run: () => void | Promise<void>;
      }>;
      bindings: Array<{
        key: string;
        cmd: string;
        desc?: string;
      }>;
    }) => () => void;
  };
  route?: {
    register: (routes: Array<{
      name: string;
      render: () => unknown;
    }>) => () => void;
    navigate: (name: string) => void;
  };
  mode?: {
    push: (name: string) => () => void;
  };
  ui?: {
    DialogAlert?: (props: {
      title: string;
      message: string;
      onConfirm?: () => void;
    }) => unknown;
    DialogSelect?: <Value = string>(props: {
      title: string;
      options: Array<{ title: string; value: Value; description?: string }>;
      onSelect?: (option: { title: string; value: Value }) => void;
      placeholder?: string;
    }) => unknown;
    dialog?: {
      replace: (render: () => unknown, onClose?: () => void) => void;
      clear: () => void;
    };
    toast?: (input: { variant?: "info" | "success" | "warning" | "error"; title?: string; message: string }) => void;
  };
}

export interface TuiOptions {
  [key: string]: unknown;
}

function DefaultPlaceholderComponent(props: { title: string; message: string }) {
  return {
    type: "element",
    name: "ModelControlCenterPlaceholder",
    props: {
      title: props.title,
      message: props.message
    }
  };
}

export function renderPlaceholderRoute(api: TuiApi): unknown {
  const Component = (api.ui?.DialogAlert ?? DefaultPlaceholderComponent) as never;
  return createComponent(Component, {
    title: "Model Control Center",
    message: "Model Control Center placeholder view"
  } as never);
}

export async function tui(api: TuiApi, _options?: TuiOptions) {
  // 1. Register Keymap Layer
  if (api.keymap?.registerLayer) {
    const layerDisposer = api.keymap.registerLayer({
      mode: "base",
      priority: 100,
      commands: [
        {
          name: "model-control-center.open",
          title: "Model Control Center",
          desc: "Open the Model Control Center TUI",
          category: "Plugin",
          run: () => {
            if (api.route?.navigate) {
              api.route.navigate("model-control-center");
            }
          }
        }
      ],
      bindings: [
        {
          key: "ctrl+alt+f",
          cmd: "model-control-center.open",
          desc: "Open Model Control Center"
        }
      ]
    });

    if (api.lifecycle?.onDispose) {
      api.lifecycle.onDispose(layerDisposer);
    }
  }

  // 2. Register Route
  if (api.route?.register) {
    /**
     * Module-level state to manage mode lifecycle across re-renders.
     * OpenCode route render() is called frequently (on every frame/update).
     */
    let activeModeDisposer: (() => void) | null = null;

    const routeDisposer = api.route.register([
      {
        name: "model-control-center",
        render: () => {
          // Task 1: Foundation registration.
          // Idempotent mode management: only push if not already active.
          if (!activeModeDisposer && api.mode?.push) {
            activeModeDisposer = api.mode.push("model-control-center");
            if (api.lifecycle?.onDispose) {
              api.lifecycle.onDispose(() => {
                if (activeModeDisposer) {
                  activeModeDisposer();
                  activeModeDisposer = null;
                }
              });
            }
          }

          return renderPlaceholderRoute(api);
        }
      }
    ]);

    if (api.lifecycle?.onDispose && typeof routeDisposer === "function") {
      api.lifecycle.onDispose(routeDisposer);
    }
  }
}

export default {
  id: "sdd-plugin.tui",
  tui
};
