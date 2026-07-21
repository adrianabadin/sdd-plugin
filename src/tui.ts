/**
 * TUI entrypoint for the OpenCode Plugin.
 * Handles Model Control Center visualization and management.
 */

export async function tui(api: any, options?: any) {
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

    // Register with host lifecycle if available
    if (api.lifecycle?.onDispose) {
      api.lifecycle.onDispose(layerDisposer);
    }
  }

  // 2. Register Route
  if (api.route?.register) {
    api.route.register([
      {
        name: "model-control-center",
        render: () => {
          // Task 1: Foundation registration.
          // Mode management is tied to the route lifecycle.
          let modeDisposer: (() => void) | null = null;
          
          if (api.mode?.push) {
            modeDisposer = api.mode.push("model-control-center");
          }

          // Return a placeholder or the component.
          // In a real implementation, we would return a UI element.
          // We also need a way to call modeDisposer when this route is "unmounted".
          // The OpenCode route contract usually supports a cleanup if render 
          // returns an object with a cleanup/dispose or if it uses a signal-based UI.
          
          return {
            title: "Model Control Center",
            terminate: () => {
              if (modeDisposer) modeDisposer();
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
