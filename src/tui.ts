/**
 * TUI entrypoint for the OpenCode Plugin.
 * Handles Model Control Center visualization and management.
 */

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
      render: () => any;
    }>) => void;
    navigate: (name: string) => void;
  };
  mode?: {
    push: (name: string) => () => void;
  };
}

export interface TuiOptions {
  [key: string]: unknown;
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

    api.route.register([
      {
        name: "model-control-center",
        render: () => {
          // Task 1: Foundation registration.
          // Idempotent mode management: only push if not already active.
          if (!activeModeDisposer && api.mode?.push) {
            activeModeDisposer = api.mode.push("model-control-center");
          }

          return {
            title: "Model Control Center",
            /**
             * OpenCode TUI host cleanup contract: the object returned by render()
             * can expose an onUnmount callback for teardown.
             */
            onUnmount: () => {
              if (activeModeDisposer) {
                activeModeDisposer();
                activeModeDisposer = null;
              }
            }
          };
        }
      }
    ]);
  }
}

export default {
  id: "sdd-plugin.tui",
  tui
};
