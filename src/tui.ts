/**
 * TUI entrypoint for the OpenCode Plugin.
 * Hosts the Model Control Center as a host-native dialog overlay.
 *
 * Migration: `model-control-center-native-dialog`.
 * The Model Control Center is mounted via `api.ui.dialog.replace` inside
 * a Solid root we own (`createRoot`). Each open creates a per-instance
 * `DialogHandle` whose `onClose` closure captures its own scope, so a
 * delayed host callback cannot dispose a later dialog's resources.
 *
 * Detached-context invariant: the component tree inside the dialog
 * receives every dependency via props (api, ports, use cases, onClose).
 * It MUST NOT use `useContext` to resolve host providers — the root is
 * detached from the host owner tree.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createRoot } from "solid-js";
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
import { normalizePersistenceError } from "./infrastructure/prisma/error-normalization.js";
import {
  createPersistenceContext,
  type CreatePersistenceContextOptions,
  type PersistenceContext,
} from "./infrastructure/runtime/persistence-context.js";

/**
 * Re-exported production composition seam.
 *
 * The built bundle (`dist/tui.js`) exposes the same persistence wiring the
 * dialog uses, so an integration test can drive a real Save through the
 * production use case without reaching for raw database writes.
 */
export { createPersistenceContext };
export type { CreatePersistenceContextOptions, PersistenceContext };

export type TuiApi = TuiPluginApi;

export interface TuiOptions {
  [key: string]: unknown;
}

/**
 * Idempotent scope handle. Disposal converges from multiple paths
 * (per-instance onClose, internal requestClose, stale-scope net,
 * lifecycle.onDispose) and is safe to call more than once.
 */
interface DialogScope {
  dispose(): void;
}

/**
 * Per-open identity. The handle is created in the command run body
 * and its `onClose` closure captures THIS handle so a delayed host
 * callback cannot reach a later dialog's state.
 */
interface DialogHandle {
  scope: DialogScope | null;
}

/**
 * Port/use case bundle once-constructed at plugin init and shared by
 * every dialog mount.
 *
 * When persistence cannot be initialized every port stays `undefined` and
 * `persistenceUnavailableReason` carries the normalized root cause. Save then
 * fails loudly instead of degrading to a clean in-memory baseline.
 */
interface DialogDependencies {
  catalogPort: OpenCodeModelCatalogAdapter;
  detailQueryPort: PrismaModelRepositoryAdapter | undefined;
  saveDetailUseCase: SaveModelDetailUseCase | undefined;
  quarantinePort: PrismaModelRepositoryAdapter | undefined;
  listQuarantinesUseCase: ListQuarantinesUseCase | undefined;
  setQuarantineUseCase: SetQuarantineUseCase | undefined;
  releaseQuarantineUseCase: ReleaseQuarantineUseCase | undefined;
  /** Present only when persistence initialization failed. */
  persistenceUnavailableReason: string | undefined;
  disposePrisma?: (() => Promise<void>) | undefined;
}

/**
 * Module-scoped handle on the most recent tui() call's shutdown promise.
 * The host lifecycle contract only exposes a synchronous onDispose callback,
 * so the disposal itself is tracked as a single-flight Promise that callers
 * can await via {@link waitForTuiShutdown}.
 */
let pendingShutdownPromise: Promise<void> | null = null;

/**
 * Awaitable lifecycle shutdown gate.
 *
 * Returns null until host unload starts. Once the registered onDispose callback
 * runs, returns its exact Promise, which resolves after every tracked Prisma
 * client has disconnected. Idempotent: callers may invoke this multiple times
 * and each invocation returns the same Promise.
 */
export function waitForTuiShutdown(): Promise<void> | null {
  return pendingShutdownPromise;
}

/**
 * Module-scoped slot bound to the most recently mounted scope. Cleared
 * only under the identity guard `activeScope === handle.scope` so a
 * late onClose from a stale handle cannot null out the active slot.
 */
let activeScope: DialogScope | null = null;

/**
 * Build the standard port/use-case bundle used by every dialog mount.
 * Mirrors the original route-init wiring one-to-one.
 */
async function buildDialogDependencies(
  api: TuiPluginApi,
  options: CreatePersistenceContextOptions = {},
): Promise<DialogDependencies> {
  const catalogPort = new OpenCodeModelCatalogAdapter(api.client);

  try {
    const context = await createPersistenceContext(options);
    return {
      catalogPort,
      detailQueryPort: context.repository,
      saveDetailUseCase: context.saveDetailUseCase,
      quarantinePort: context.repository,
      listQuarantinesUseCase: context.listQuarantinesUseCase,
      setQuarantineUseCase: context.setQuarantineUseCase,
      releaseQuarantineUseCase: context.releaseQuarantineUseCase,
      persistenceUnavailableReason: undefined,
      disposePrisma: () => context.dispose(),
    };
  } catch (rawErr) {
    const err = normalizePersistenceError(rawErr);
    console.error(
      `[sdd-plugin.tui] Database initialization failed for path ${resolveDatabasePath()}: ${err.message}`,
      err,
    );
    return {
      catalogPort,
      detailQueryPort: undefined,
      saveDetailUseCase: undefined,
      quarantinePort: undefined,
      listQuarantinesUseCase: undefined,
      setQuarantineUseCase: undefined,
      releaseQuarantineUseCase: undefined,
      persistenceUnavailableReason: err.message,
      disposePrisma: undefined,
    };
  }
}

export async function tui(api: TuiPluginApi, _options?: TuiOptions, _meta?: unknown) {
  const dependencies = await buildDialogDependencies(api);
  pendingShutdownPromise = null;

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
            openModelControlCenterDialog(api, dependencies);
          },
        },
      ],
      bindings: [
        {
          key: "alt+shift+m",
          cmd: "model-control-center.open",
          desc: "Open Model Control Center",
        },
      ],
    });

    if (api.lifecycle?.onDispose) {
      api.lifecycle.onDispose(layerDisposer);
    }
  }

  // 2. Plugin unload disposes any active dialog scope (defense-in-depth).
  //    The single-flight Promise below is exposed via `waitForTuiShutdown` so
  //    callers can deterministically await both Prisma disconnects before the
  //    process exits.
  let registeredShutdown: Promise<void> | null = null;
  if (api.lifecycle?.onDispose) {
    api.lifecycle.onDispose((): Promise<void> => {
      if (!registeredShutdown) {
        activeScope?.dispose();
        activeScope = null;
        registeredShutdown = dependencies.disposePrisma?.() ?? Promise.resolve();
        pendingShutdownPromise = registeredShutdown;
      }
      return registeredShutdown;
    });
  }

  // 3. No route registration. The Model Control Center is hosted through
  //    api.ui.dialog.replace inside our own createRoot (see
  //    openModelControlCenterDialog / renderDialog).
}

/**
 * Open (or re-open) the Model Control Center as a host-native dialog.
 *
 * Each invocation:
 *   1. Disposes a stale scope from a previous open (the stale-scope net).
 *   2. Creates a per-open DialogHandle with its own `onClose` closure.
 *   3. Calls `api.ui.dialog.replace(...)` with the render fn and the
 *      per-instance onClose. The host dialog stack drives the createRoot
 *      lifecycle through its render invocation.
 */
function openModelControlCenterDialog(
  api: TuiPluginApi,
  dependencies: DialogDependencies,
): void {
  if (!api.ui?.dialog?.replace) {
    return;
  }

  // Stale-scope net: dispose any scope that survived a previous open so
  // the new mount starts in a clean state. The slot is reset here; the
  // host's onClose path will run again on the new handle's disposal.
  activeScope?.dispose();
  activeScope = null;

  const handle: DialogHandle = { scope: null };

  api.ui.dialog.replace(
    () => renderDialog(api, handle, dependencies),
    () => onCloseFor(handle),
  );
}

/**
 * Module-scoped render fn. Creates an owned Solid root (no custom mode
 * push; the MCC keymap layer is modeless and priority-200) and mounts
 * the Model Control Center component. The handle's scope is set to the
 * root's dispose, so the per-instance onClose can dispose the same root.
 *
 * The root is detached from the host owner tree. The component tree
 * MUST receive every dependency via props (see ModelControlCenterProps).
 *
 * This is the host-dialog `render()` callback. It is invoked by the host
 * dialog stack synchronously per `replace`; the returned JSX element is
 * what the host renders inside the dialog frame.
 */
function renderDialog(
  api: TuiPluginApi,
  handle: DialogHandle,
  dependencies: DialogDependencies,
): JSX.Element {
  let element: JSX.Element | null = null;
  let rootDispose: (() => void) | null = null;

  createRoot((dispose) => {
    rootDispose = dispose;

    // No custom mode push: the MCC keymap layer is modeless and the
    // host already owns the modal surface. Priority-200 preempts host
    // default-priority bindings while mounted.

    // Install the per-instance scope. Idempotent: any later dispose
    // call is a no-op once the root is gone.
    let disposed = false;
    const scope: DialogScope = {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (rootDispose) rootDispose();
      },
    };
    handle.scope = scope;
    activeScope = scope;

    element = createComponent(ModelControlCenter, {
      api,
      catalog: dependencies.catalogPort,
      detailQuery: dependencies.detailQueryPort,
      saveDetailUseCase: dependencies.saveDetailUseCase,
      quarantinePort: dependencies.quarantinePort,
      listQuarantinesUseCase: dependencies.listQuarantinesUseCase,
      setQuarantineUseCase: dependencies.setQuarantineUseCase,
      releaseQuarantineUseCase: dependencies.releaseQuarantineUseCase,
      persistenceUnavailableReason: dependencies.persistenceUnavailableReason,
      onClose: () => requestClose(api, handle),
    });
  });

  return element as JSX.Element;
}

/**
 * Per-instance onClose bound by `api.ui.dialog.replace`. The handle
 * uniquely identifies this open, so a delayed host callback cannot
 * touch a later dialog's scope or slot.
 */
function onCloseFor(handle: DialogHandle): void {
  handle.scope?.dispose();
  // Clear the active slot only if we still own it. A stale handle
  // whose scope was already idempotent-disposed must NOT null out
  // an active dialog's slot.
  if (handle.scope && activeScope === handle.scope) {
    activeScope = null;
  }
}

/**
 * Internal close path invoked from inside the Model Control Center
 * (root Escape or explicit clear). Dispose synchronously FIRST, then
 * clear the slot under the identity guard, then ask the host to clear
 * the dialog. Ordering guarantees that a throwing `dialog.clear()`
 * cannot orphan the scope.
 */
function requestClose(api: TuiPluginApi, handle: DialogHandle): void {
  handle.scope?.dispose();
  if (handle.scope && activeScope === handle.scope) {
    activeScope = null;
  }
  if (api.ui?.dialog?.clear) {
    api.ui.dialog.clear();
  }
}

export default {
  id: "sdd-plugin.tui",
  tui,
};
