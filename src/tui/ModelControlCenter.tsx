import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createSignal, createEffect, onCleanup, onMount } from "solid-js";
import { createComponent } from "solid-js/web";
import type { ModelCatalogPort } from "../ports/model-catalog.port.js";
import type { ModelDetailQueryPort } from "../ports/model-detail-query.port.js";
import type { ConnectedModelInfo } from "../domain/model/connected-model.js";
import {
  buildProviderSummaries,
  filterModels,
  type CatalogView,
} from "./catalog-view.js";
import MainMenu from "./MainMenu.js";
import ProvidersScreen from "./ProvidersScreen.js";
import ModelsScreen from "./ModelsScreen.js";
import ModelDetailScreen from "./ModelDetailScreen.js";
import {
  mergeModelDetail,
  createDraft,
  isDraftDirty,
  type LoadedDetail,
  type DetailDraft,
} from "./model-detail-view.js";
import { validateDraft, type ValidationResult } from "./detail-validation.js";
import {
  createInitialStack,
  handleNavigation,
  type NavigationEvent,
  type ScreenState,
} from "./navigation.js";

export interface ModelControlCenterProps {
  api: TuiPluginApi;
  catalog?: ModelCatalogPort | undefined;
  detailQuery?: ModelDetailQueryPort | undefined;
}

export function ModelControlCenter(props: ModelControlCenterProps): JSX.Element {
  const [stack, setStack] = createSignal<ScreenState[]>(createInitialStack());
  const [catalogState, setCatalogState] = createSignal<CatalogView>({ status: "loading" });
  const [rawModels, setRawModels] = createSignal<ReadonlyArray<ConnectedModelInfo>>([]);

  // Task 4 Detail signals
  const [loadedBaseline, setLoadedBaseline] = createSignal<LoadedDetail | null>(null);
  const [detailDraft, setDetailDraft] = createSignal<DetailDraft | null>(null);
  const [detailNotice, setDetailNotice] = createSignal<string | undefined>(undefined);
  const [detailValidation, setDetailValidation] = createSignal<ValidationResult | undefined>(undefined);

  const initialRouteName = props.api.route?.current?.name ?? "home";

  // Effect to load model detail state when entering model-detail screen
  createEffect(() => {
    const current = currentScreen();
    if (current.name === "model-detail") {
      const { providerId, modelId } = current;
      const catalogModels = rawModels();
      const catalogMatch = catalogModels.find(
        (m) => m.providerId === providerId && m.modelId === modelId
      ) ?? null;

      if (props.detailQuery) {
        props.detailQuery
          .findModelDetail(providerId, modelId)
          .then((persisted) => {
            const merged = mergeModelDetail(catalogMatch, persisted, providerId, modelId);
            setLoadedBaseline(merged);
            setDetailDraft(createDraft(merged));
            setDetailNotice(persisted ? undefined : "No saved metadata record; showing catalog defaults.");
            setDetailValidation(undefined);
          })
          .catch((err: unknown) => {
            const merged = mergeModelDetail(catalogMatch, null, providerId, modelId);
            setLoadedBaseline(merged);
            setDetailDraft(createDraft(merged));
            setDetailNotice(`Error querying persisted detail: ${String(err)}`);
          });
      } else {
        const merged = mergeModelDetail(catalogMatch, null, providerId, modelId);
        setLoadedBaseline(merged);
        setDetailDraft(createDraft(merged));
        setDetailNotice(undefined);
        setDetailValidation(undefined);
      }
    }
  });

  onMount(() => {
    if (!props.catalog) {
      setCatalogState({ status: "ready", providers: [], modelsByProvider: new Map() });
      return;
    }

    props.catalog
      .getConnectedModels()
      .then((models) => {
        setRawModels(models);
        const providers = buildProviderSummaries(models);
        const modelsByProvider = new Map<string, ConnectedModelInfo[]>();
        for (const prov of providers) {
          const provModels = models.filter((m) => m.providerId === prov.providerId);
          modelsByProvider.set(prov.providerId, provModels);
        }
        setCatalogState({
          status: "ready",
          providers,
          modelsByProvider,
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setCatalogState({ status: "error", message: msg });
      });
  });

  function getVisibleCount(screen: ScreenState): number {
    const state = catalogState();
    if (state.status !== "ready") return 0;

    if (screen.name === "providers") {
      return state.providers.length;
    }
    if (screen.name === "models") {
      const allForProv = state.modelsByProvider.get(screen.providerId) ?? [];
      const visible = filterModels(allForProv, screen.query);
      return visible.length;
    }
    return 0;
  }

  function getSelectedIds(screen: ScreenState): { providerId?: string; modelId?: string } {
    const state = catalogState();
    if (state.status !== "ready") return {};

    if (screen.name === "providers") {
      const prov = state.providers[screen.selectedIndex];
      return prov ? { providerId: prov.providerId } : {};
    }
    if (screen.name === "models") {
      const allForProv = state.modelsByProvider.get(screen.providerId) ?? [];
      const visible = filterModels(allForProv, screen.query);
      const mod = visible[screen.selectedIndex];
      return mod
        ? { providerId: screen.providerId, modelId: mod.modelId }
        : { providerId: screen.providerId };
    }
    return {};
  }

  function handleSaveIntent(): void {
    const draft = detailDraft();
    if (!draft) return;
    const res = validateDraft(draft);
    if (res.isValid) {
      setLoadedBaseline(draft);
      setDetailNotice("Validated — persistence lands in Task 5");
      setDetailValidation(undefined);
    } else {
      setDetailValidation(res);
      setDetailNotice(undefined);
    }
  }

  function dispatch(event: NavigationEvent): void {
    const current = currentScreen();

    if (event.type === "save-intent") {
      if (current.name === "model-detail") {
        handleSaveIntent();
      }
      return;
    }

    if (event.type === "back" && current.name === "model-detail") {
      const base = loadedBaseline();
      const draft = detailDraft();

      if (current.focus?.area === "tabs" && base && draft && isDraftDirty(base, draft)) {
        setDetailDraft(createDraft(base));
        setDetailNotice("Draft discarded");
        setDetailValidation(undefined);
        return;
      }
    }

    const maxIndex = getVisibleCount(current);
    const { providerId, modelId } = getSelectedIds(current);

    const result = handleNavigation(stack(), event, maxIndex, providerId, modelId);
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
          name: "mcc.nav.search-start",
          title: "Search Models",
          run: () => dispatch({ type: "search-start" }),
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
        {
          name: "mcc.form.save",
          title: "Validate / Save Draft Intent",
          run: () => dispatch({ type: "save-intent" }),
        },
      ],
      bindings: [
        { key: "up", cmd: "mcc.nav.up" },
        { key: "down", cmd: "mcc.nav.down" },
        { key: "enter", cmd: "mcc.nav.activate" },
        { key: "esc", cmd: "mcc.nav.back" },
        { key: "/", cmd: "mcc.nav.search-start" },
        { key: "tab", cmd: "mcc.nav.tab-next" },
        { key: "shift+tab", cmd: "mcc.nav.tab-prev" },
        { key: "ctrl+s", cmd: "mcc.form.save" },
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
    const catState = catalogState();

    switch (screen.name) {
      case "main-menu":
        return createComponent(MainMenu, { selectedIndex: screen.selectedIndex, api: props.api });

      case "providers": {
        if (catState.status === "loading") {
          return createComponent(props.api.ui.DialogAlert, {
            title: "Connected Providers",
            message: "Loading connected providers...",
          });
        }
        if (catState.status === "error") {
          return createComponent(props.api.ui.DialogAlert, {
            title: "Connected Providers Error",
            message: `Error loading catalog: ${catState.message}`,
          });
        }
        return createComponent(ProvidersScreen, {
          api: props.api,
          providers: catState.providers,
          selectedIndex: screen.selectedIndex,
        });
      }

      case "quarantines":
        return createComponent(props.api.ui.DialogAlert, {
          title: "Quarantines",
          message: "Quarantines placeholder view (Task 5)",
        });

      case "models": {
        if (catState.status === "loading") {
          return createComponent(props.api.ui.DialogAlert, {
            title: `Models (${screen.providerId})`,
            message: "Loading models...",
          });
        }
        if (catState.status === "error") {
          return createComponent(props.api.ui.DialogAlert, {
            title: `Models Error (${screen.providerId})`,
            message: `Error loading models: ${catState.message}`,
          });
        }
        const allForProv = catState.modelsByProvider.get(screen.providerId) ?? [];
        const visibleModels = filterModels(allForProv, screen.query);

        return createComponent(ModelsScreen, {
          api: props.api,
          providerId: screen.providerId,
          models: visibleModels,
          selectedIndex: screen.selectedIndex,
          query: screen.query,
          searchActive: screen.searchActive,
        });
      }

      case "model-detail": {
        const base = loadedBaseline();
        const draft = detailDraft();
        if (!base || !draft) {
          return createComponent(props.api.ui.DialogAlert, {
            title: `Model Detail (${screen.modelId})`,
            message: "Loading model detail...",
          });
        }
        return createComponent(ModelDetailScreen, {
          api: props.api,
          providerId: screen.providerId,
          modelId: screen.modelId,
          tab: screen.tab,
          focus: screen.focus,
          baseline: base,
          draft,
          validation: detailValidation(),
          notice: detailNotice(),
        });
      }
    }
  };

  return renderActiveScreen();
}

export default ModelControlCenter;
