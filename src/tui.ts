/**
 * TUI entrypoint for the OpenCode Plugin.
 * Handles Model Control Center visualization and management.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { createComponent } from "solid-js/web";
import ModelControlCenter from "./tui/ModelControlCenter.js";
import { OpenCodeModelCatalogAdapter } from "./infrastructure/opencode/opencode-model-catalog.adapter.js";
import { PrismaModelRepositoryAdapter } from "./infrastructure/prisma/prisma-model-repository.adapter.js";
import { SaveModelDetailUseCase } from "./application/save-model-detail/save-model-detail.use-case.js";
import {
  ListQuarantinesUseCase,
  SetQuarantineUseCase,
  ReleaseQuarantineUseCase,
} from "./application/quarantine/index.js";
import { resolveDatabasePath } from "./infrastructure/runtime/database-path.js";
import { getOrCreateModelConfigRegistry } from "./infrastructure/runtime/model-config-registry.js";
import { getGlobalQuarantineStore } from "./infrastructure/runtime/quarantine-store.js";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

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

  // Build canonical OpenCodeModelCatalogAdapter from api.client
  const catalogPort = new OpenCodeModelCatalogAdapter(api.client);

  // Build additive Prisma detail query & write adapters using shared db authority
  let detailQueryPort: PrismaModelRepositoryAdapter | undefined;
  let saveDetailUseCase: SaveModelDetailUseCase | undefined;
  let quarantinePort: PrismaModelRepositoryAdapter | undefined;
  let listQuarantinesUseCase: ListQuarantinesUseCase | undefined;
  let setQuarantineUseCase: SetQuarantineUseCase | undefined;
  let releaseQuarantineUseCase: ReleaseQuarantineUseCase | undefined;
  try {
    const dbPath = resolveDatabasePath();
    process.env.DATABASE_URL = `file:${dbPath}`;
    const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
    const prisma = new PrismaClient({ adapter: prismaAdapter });
    const repositoryAdapter = new PrismaModelRepositoryAdapter(prisma);
    detailQueryPort = repositoryAdapter;
    quarantinePort = repositoryAdapter;

    const registry = getOrCreateModelConfigRegistry();
    saveDetailUseCase = new SaveModelDetailUseCase(repositoryAdapter, registry);

    const qStore = getGlobalQuarantineStore();
    listQuarantinesUseCase = new ListQuarantinesUseCase(repositoryAdapter, qStore);
    setQuarantineUseCase = new SetQuarantineUseCase(repositoryAdapter, qStore);
    releaseQuarantineUseCase = new ReleaseQuarantineUseCase(repositoryAdapter, qStore);
  } catch {
    detailQueryPort = undefined;
    saveDetailUseCase = undefined;
    quarantinePort = undefined;
    listQuarantinesUseCase = undefined;
    setQuarantineUseCase = undefined;
    releaseQuarantineUseCase = undefined;
  }

  // 2. Register Route
  if (api.route?.register) {
    const routeDisposer = api.route.register([
      {
        name: "model-control-center",
        render: () => {
          // Push mode inside Solid route render and register onCleanup to pop mode when leaving route.
          if (api.mode?.push) {
            const popMode = api.mode.push("model-control-center");
            onCleanup(() => {
              popMode();
            });
          }

          return createComponent(ModelControlCenter, {
            api,
            catalog: catalogPort,
            detailQuery: detailQueryPort,
            saveDetailUseCase: saveDetailUseCase,
            quarantinePort,
            listQuarantinesUseCase,
            setQuarantineUseCase,
            releaseQuarantineUseCase,
          });
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
