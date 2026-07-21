/**
 * TUI entrypoint for the OpenCode Plugin.
 * Handles Model Control Center visualization and management.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { createComponent } from "solid-js/web";

export type TuiApi = TuiPluginApi;

export interface TuiOptions {
  [key: string]: unknown;
}

export function renderPlaceholderRoute(api: TuiPluginApi): JSX.Element {
  return createComponent(api.ui.DialogAlert, {
    title: "Model Control Center",
    message: "Model Control Center placeholder view",
  });
}

export async function tui(api: TuiPluginApi, _options?: TuiOptions, _meta?: unknown) {
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
          },
        },
      ],
      bindings: [
        {
          key: "ctrl+alt+f",
          cmd: "model-control-center.open",
          desc: "Open Model Control Center",
        },
      ],
    });

    if (api.lifecycle?.onDispose) {
      api.lifecycle.onDispose(layerDisposer);
    }
  }

  // 2. Register Route
  if (api.route?.register) {
    const routeDisposer = api.route.register([
      {
        name: "model-control-center",
        render: () => {
          // Task 1: Foundation registration.
          // Push mode inside Solid route render and register onCleanup to pop mode when leaving route.
          if (api.mode?.push) {
            const popMode = api.mode.push("model-control-center");
            onCleanup(() => {
              popMode();
            });
          }

          return renderPlaceholderRoute(api);
        },
      },
    ]);

    if (api.lifecycle?.onDispose && typeof routeDisposer === "function") {
      api.lifecycle.onDispose(routeDisposer);
    }
  }
}

export default {
  id: "sdd-plugin.tui",
  tui,
};
