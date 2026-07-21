/**
 * TUI entrypoint for the OpenCode Plugin.
 * Handles Model Control Center visualization and management.
 */

export const SddTuiPlugin = async (ctx: any) => {
  const { client } = ctx;
  const api = client?.api;

  if (api) {
    // Register Ctrl+Alt+F to navigate to Model Control Center
    if (api.keymap?.registerLayer) {
      api.keymap.registerLayer({
        key: "f",
        mod: ["ctrl", "alt"],
        command: "model-control-center.open",
        description: "Open Model Control Center"
      });
    }

    // Register the route
    if (api.router?.register) {
      api.router.register({
        path: "/model-control-center",
        title: "Model Control Center",
        component: "ModelControlCenter", // Placeholder for next tasks
        onMount: (params: any) => {
          if (api.mode?.set) {
            api.mode.set("model-control-center");
          }
        },
        onUnmount: () => {
          if (api.mode?.clear) {
            api.mode.clear();
          }
        }
      });
    }
  }

  return {
    "commands": {
      "model-control-center.open": () => {
        if (api?.router?.navigate) {
          api.router.navigate("/model-control-center");
        }
      }
    }
  };
};

export default SddTuiPlugin;
