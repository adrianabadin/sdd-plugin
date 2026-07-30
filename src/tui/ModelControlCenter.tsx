import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { createSignal, createEffect, createMemo, onCleanup, onMount } from "solid-js";
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
import QuarantinesScreen from "./QuarantinesScreen.js";
import {
  mergeModelDetail,
  createDraft,
  isDraftDirty,
  type LoadedDetail,
  type DetailDraft,
} from "./model-detail-view.js";
import {
  appendNumericEdit,
  backspaceNumericEdit,
  getNumericFieldDescriptor,
  parseNumericEdit,
  startNumericEdit,
  updateNumericDetailField,
  type NumericDetailTab,
  type NumericEditSession,
} from "./model-detail-numeric-edit.js";
import {
  startFieldEdit,
  appendFieldEdit,
  backspaceFieldEdit,
  commitFieldEdit,
  getSubscriptionFieldDescriptors,
  type FieldDescriptor,
  type FieldEditSession,
  ACTIVE_FIELD_EDIT_PRIORITY,
} from "./model-detail-field-edit.js";
import {
  type QuarantineOverlayState,
  type QuarantineOverlayFocus,
  createQuarantineOverlay,
  updateQuarantineOverlayBuffer,
  setQuarantineOverlayFocus,
  cycleQuarantineOverlayFocus,
  setQuarantineOverlayDuration,
  setQuarantineOverlayLevel,
  setQuarantineOverlayError,
  buildQuarantineDraft,
  validateQuarantineOverlayBuffers,
  buildQuarantineTarget,
} from "./quarantine-overlay.js";
import { deriveQuarantineView } from "./quarantine-view.js";
import { validateDraft, type ValidationResult } from "./detail-validation.js";
import {
  createInitialStack,
  handleNavigation,
  type NavigationEvent,
  type ScreenState,
} from "./navigation.js";

import type { SaveModelDetailUseCase } from "../application/save-model-detail/save-model-detail.use-case.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../ports/quarantine-write.port.js";
import type {
  ListQuarantinesUseCase,
  SetQuarantineUseCase,
  ReleaseQuarantineUseCase,
} from "../application/quarantine/index.js";
import type { QuarantineEntry } from "../domain/model/quarantine.js";

const NUMERIC_DIGIT_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export interface ModelControlCenterProps {
  api: TuiPluginApi;
  catalog?: ModelCatalogPort | undefined;
  detailQuery?: ModelDetailQueryPort | undefined;
  saveDetailUseCase?: SaveModelDetailUseCase | undefined;
  quarantinePort?: QuarantineWritePort | undefined;
  listQuarantinesUseCase?: ListQuarantinesUseCase | undefined;
  setQuarantineUseCase?: SetQuarantineUseCase | undefined;
  releaseQuarantineUseCase?: ReleaseQuarantineUseCase | undefined;
  /**
   * When persistence initialization failed the parent supplies a normalized
   * reason. Save is blocked and the rendered notice surfaces the actionable
   * cause. This avoids the silent in-memory fallback that would otherwise
   * make Save look successful without durable storage.
   */
  persistenceUnavailableReason?: string | undefined;
  /**
   * Optional close callback invoked when the user requests explicit close
   * (root Escape on the main menu). If omitted, the component falls back
   * to `api.ui.dialog.clear()` for the dialog stack to consume.
   * The host dialog `onClose` (not this callback) is what the
   * host invokes after the user closes the dialog via host means.
   */
  onClose?: () => void;
}

const PRINTABLE_CAPTURE_CHARS: readonly string[] = [
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  ..."0123456789".split(""),
  "space",
  "-",
  "_",
  ".",
  ",",
  "/",
  "@",
];

export function extractCharacter(ctx: unknown): string {
  if (typeof ctx === "string") {
    if (ctx.length === 1) return ctx;
    if (ctx === "space") return " ";
    return "";
  }
  if (!ctx || typeof ctx !== "object") return "";

  const obj = ctx as Record<string, unknown>;

  const properties = ["ch", "char", "character", "sequence", "raw", "input", "data", "name"];
  for (const prop of properties) {
    const val = obj[prop];
    if (typeof val === "string") {
      if (val.length === 1) return val;
      if (val === "space") return " ";
    }
  }

  const subKeys = ["key", "event", "detail", "data", "input"];
  for (const subKey of subKeys) {
    const sub = obj[subKey];
    if (typeof sub === "string") {
      if (sub.length === 1) return sub;
      if (sub === "space") return " ";
    } else if (sub && typeof sub === "object") {
      const extracted = extractCharacter(sub);
      if (extracted) return extracted;
    }
  }

  return "";
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
  const [numericEdit, setNumericEdit] = createSignal<(
    NumericEditSession & { tab: NumericDetailTab; index: number }
  ) | null>(null);
  const [genericFieldEdit, setGenericFieldEdit] = createSignal<FieldEditSession<unknown> | null>(null);

  // Task 6 Quarantine signals
  const [quarantines, setQuarantines] = createSignal<QuarantineEntry[]>([]);
  const [quarantineLoading, setQuarantineLoading] = createSignal<boolean>(false);
  const [quarantineError, setQuarantineError] = createSignal<string | undefined>(undefined);
  const [quarantineNotice, setQuarantineNotice] = createSignal<string | undefined>(undefined);
  const [quarantineOverlay, setQuarantineOverlay] = createSignal<QuarantineOverlayState | null>(null);

  // NOTE: removed `initialRouteName` (route presentation migration). The
  // Model Control Center no longer captures a host route to return to;
  // root-exit calls `props.onClose` (or `api.ui.dialog.clear()` as a
  // fallback) so the host dialog stack handles the close surface.

  // Priority 300 active capture layer effect (field editing & quarantine overlay)
  createEffect(() => {
    const isEditingField = genericFieldEdit() !== null;
    const isOverlayActive = quarantineOverlay() !== null;

    if (!isEditingField && !isOverlayActive) return;
    if (!props.api.keymap?.registerLayer) return;

    const layerDisposer = props.api.keymap.registerLayer({
      priority: ACTIVE_FIELD_EDIT_PRIORITY,
      commands: [
        ...PRINTABLE_CAPTURE_CHARS.map((charKey) => ({
          name: `mcc.capture.explicit-${charKey}`,
          title: `Capture Printable ${charKey}`,
          run: () => {
            const ch = charKey === "space" ? " " : charKey;
            if (genericFieldEdit()) {
              setGenericFieldEdit((prev) => {
                if (!prev) return null;
                if (prev.descriptor.kind === "boolean" && charKey === "space") {
                  const lower = prev.buffer.toLowerCase();
                  const nextVal = lower === "true" || lower === "yes" ? "false" : "true";
                  return { ...prev, buffer: nextVal, error: undefined };
                }
                return appendFieldEdit(prev, ch);
              });
            } else if (quarantineOverlay()) {
              const ov = quarantineOverlay()!;
              if (ov.mode === "release") return;
              if (ov.focus === "scope") {
                const nextLevel = ov.level === "provider" ? "model" : "provider";
                setQuarantineOverlay(setQuarantineOverlayLevel(ov, nextLevel));
              } else if (ov.focus === "duration") {
                const nextDur = ov.durationKind === "permanent" ? "ttl" : "permanent";
                setQuarantineOverlay(setQuarantineOverlayDuration(ov, nextDur));
              } else if (ov.focus === "id") {
                const bufferKey = ov.level === "provider" ? "providerId" : "modelId";
                setQuarantineOverlay(updateQuarantineOverlayBuffer(ov, bufferKey, ch));
              } else if (ov.focus === "reason") {
                setQuarantineOverlay(updateQuarantineOverlayBuffer(ov, "reason", ch));
              } else if (ov.focus === "ttl") {
                setQuarantineOverlay(updateQuarantineOverlayBuffer(ov, "ttlHours", ch));
              }
            }
          },
        })),
        {
          name: "mcc.capture.char",
          title: "Capture Printable Input",
          run: (ctx?: unknown) => {
            const ch = extractCharacter(ctx);
            if (!ch) return;
            if (genericFieldEdit()) {
              setGenericFieldEdit((prev) => (prev ? appendFieldEdit(prev, ch) : null));
            } else if (quarantineOverlay()) {
              const ov = quarantineOverlay()!;
              if (ov.mode === "release") return;
              if (ov.focus === "scope") {
                const nextLevel = ov.level === "provider" ? "model" : "provider";
                setQuarantineOverlay(setQuarantineOverlayLevel(ov, nextLevel));
              } else if (ov.focus === "duration") {
                const nextDur = ov.durationKind === "permanent" ? "ttl" : "permanent";
                setQuarantineOverlay(setQuarantineOverlayDuration(ov, nextDur));
              } else if (ov.focus === "id") {
                const bufferKey = ov.level === "provider" ? "providerId" : "modelId";
                setQuarantineOverlay(updateQuarantineOverlayBuffer(ov, bufferKey, ch));
              } else if (ov.focus === "reason") {
                setQuarantineOverlay(updateQuarantineOverlayBuffer(ov, "reason", ch));
              } else if (ov.focus === "ttl") {
                setQuarantineOverlay(updateQuarantineOverlayBuffer(ov, "ttlHours", ch));
              }
            }
          },
        },
        {
          name: "mcc.capture.backspace",
          title: "Capture Backspace",
          run: () => {
            if (genericFieldEdit()) {
              setGenericFieldEdit((prev) => (prev ? backspaceFieldEdit(prev) : null));
            } else if (quarantineOverlay()) {
              const ov = quarantineOverlay()!;
              if (ov.mode === "release") return;
              if (ov.focus === "id") {
                const bufferKey = ov.level === "provider" ? "providerId" : "modelId";
                setQuarantineOverlay(updateQuarantineOverlayBuffer(ov, bufferKey, "<backspace>"));
              } else if (ov.focus === "reason") {
                setQuarantineOverlay(updateQuarantineOverlayBuffer(ov, "reason", "<backspace>"));
              } else if (ov.focus === "ttl") {
                setQuarantineOverlay(updateQuarantineOverlayBuffer(ov, "ttlHours", "<backspace>"));
              }
            }
          },
        },
        {
          name: "mcc.capture.tab",
          title: "Capture Tab / Focus Next",
          run: () => {
            if (quarantineOverlay()) {
              const ov = quarantineOverlay()!;
              setQuarantineOverlay(cycleQuarantineOverlayFocus(ov, "next"));
            }
          },
        },
        {
          name: "mcc.capture.shift-tab",
          title: "Capture Shift+Tab / Focus Prev",
          run: () => {
            if (quarantineOverlay()) {
              const ov = quarantineOverlay()!;
              setQuarantineOverlay(cycleQuarantineOverlayFocus(ov, "prev"));
            }
          },
        },
        {
          name: "mcc.capture.left",
          title: "Capture Left Arrow",
          run: () => {
            if (quarantineOverlay()) {
              const ov = quarantineOverlay()!;
              if (ov.focus === "scope") {
                const nextLevel = ov.level === "provider" ? "model" : "provider";
                setQuarantineOverlay(setQuarantineOverlayLevel(ov, nextLevel));
              } else if (ov.focus === "duration") {
                const nextDur = ov.durationKind === "permanent" ? "ttl" : "permanent";
                setQuarantineOverlay(setQuarantineOverlayDuration(ov, nextDur));
              }
            }
          },
        },
        {
          name: "mcc.capture.right",
          title: "Capture Right Arrow",
          run: () => {
            if (quarantineOverlay()) {
              const ov = quarantineOverlay()!;
              if (ov.focus === "scope") {
                const nextLevel = ov.level === "provider" ? "model" : "provider";
                setQuarantineOverlay(setQuarantineOverlayLevel(ov, nextLevel));
              } else if (ov.focus === "duration") {
                const nextDur = ov.durationKind === "permanent" ? "ttl" : "permanent";
                setQuarantineOverlay(setQuarantineOverlayDuration(ov, nextDur));
              }
            }
          },
        },
        {
          name: "mcc.capture.commit",
          title: "Commit Active Input",
          run: () => {
            if (genericFieldEdit()) {
              commitGenericFieldEditSession();
            } else if (quarantineOverlay()) {
              const ov = quarantineOverlay()!;
              if (ov.mode === "release") {
                const view = deriveQuarantineView(quarantines());
                const targetItem = ov.targetIndex !== undefined ? view.items[ov.targetIndex] : undefined;
                if (!targetItem) {
                  setQuarantineOverlay(null);
                  return;
                }
                const target = buildQuarantineTarget(ov, targetItem.entry);
                setQuarantineOverlay(null);
                setQuarantineLoading(true);

                const releaser = props.releaseQuarantineUseCase
                  ? props.releaseQuarantineUseCase.releaseFromTarget(target)
                  : props.quarantinePort
                    ? props.quarantinePort.releaseQuarantine(target)
                    : Promise.resolve();

                releaser
                  .then(() => {
                    setQuarantineNotice("Quarantine released");
                    const fetcher = props.listQuarantinesUseCase
                      ? props.listQuarantinesUseCase.execute()
                      : props.quarantinePort
                        ? props.quarantinePort.listQuarantines()
                        : Promise.resolve([]);
                    return fetcher.then((entries) => setQuarantines(entries));
                  })
                  .catch((err: unknown) => {
                    setQuarantineOverlay(setQuarantineOverlayError(ov, err instanceof Error ? err.message : String(err)));
                  })
                  .finally(() => setQuarantineLoading(false));
              } else {
                // create or modify mode
                try {
                  const draft = buildQuarantineDraft(ov);
                  const valRes = validateQuarantineOverlayBuffers(draft);
                  if (!valRes.ok) {
                    setQuarantineOverlay(setQuarantineOverlayError(ov, valRes.error));
                    return;
                  }
                  setQuarantineOverlay(null);
                  setQuarantineLoading(true);

                  const cmd: SetQuarantineCommand = {
                    level: valRes.draft.level,
                    type: valRes.draft.duration.kind,
                    reason: valRes.draft.reason,
                    ...(valRes.draft.providerId ? { providerId: valRes.draft.providerId } : {}),
                    ...(valRes.draft.modelId ? { modelId: valRes.draft.modelId } : {}),
                    ...(valRes.draft.duration.kind === "ttl" ? { until: new Date(Date.now() + valRes.draft.duration.hours * 3600000) } : {}),
                  };
                  const submitter = props.setQuarantineUseCase
                    ? props.setQuarantineUseCase.submitDraft(valRes.draft)
                    : props.quarantinePort
                      ? props.quarantinePort.setQuarantine(cmd)
                      : Promise.reject(new Error("No quarantine use case or port available"));

                  submitter
                    .then(() => {
                      setQuarantineNotice(ov.mode === "create" ? "Quarantine created" : "Quarantine modified");
                      const fetcher = props.listQuarantinesUseCase
                        ? props.listQuarantinesUseCase.execute()
                        : props.quarantinePort
                          ? props.quarantinePort.listQuarantines()
                          : Promise.resolve([]);
                      return fetcher.then((entries) => setQuarantines(entries));
                    })
                    .catch((err: unknown) => {
                      setQuarantineOverlay(setQuarantineOverlayError(ov, err instanceof Error ? err.message : String(err)));
                    })
                    .finally(() => setQuarantineLoading(false));
                } catch (err: unknown) {
                  setQuarantineOverlay(setQuarantineOverlayError(ov, err instanceof Error ? err.message : String(err)));
                }
              }
            }
          },
        },
        {
          name: "mcc.capture.cancel",
          title: "Cancel Active Input",
          run: () => {
            if (genericFieldEdit()) {
              setGenericFieldEdit(null);
            } else if (quarantineOverlay()) {
              setQuarantineOverlay(null);
            }
          },
        },
      ],
      bindings: [
        ...PRINTABLE_CAPTURE_CHARS.map((charKey) => ({
          key: charKey,
          cmd: `mcc.capture.explicit-${charKey}`,
        })),
        { key: "<character>", cmd: "mcc.capture.char" },
        { key: "backspace", cmd: "mcc.capture.backspace" },
        { key: "tab", cmd: "mcc.capture.tab" },
        { key: "shift+tab", cmd: "mcc.capture.shift-tab" },
        { key: "left", cmd: "mcc.capture.left" },
        { key: "right", cmd: "mcc.capture.right" },
        { key: "enter", cmd: "mcc.capture.commit" },
        { key: "esc", cmd: "mcc.capture.cancel" },
      ],
    });

    onCleanup(() => {
      if (typeof layerDisposer === "function") {
        layerDisposer();
      }
    });
  });
  createEffect(() => {
    const current = currentScreen();
    if (current.name === "quarantines") {
      setQuarantineLoading(true);
      setQuarantineError(undefined);

      const fetcher = props.listQuarantinesUseCase
        ? props.listQuarantinesUseCase.execute()
        : props.quarantinePort
          ? props.quarantinePort.listQuarantines()
          : Promise.resolve([]);

      fetcher
        .then((entries) => {
          setQuarantines(entries);
          setQuarantineLoading(false);
        })
        .catch((err: unknown) => {
          setQuarantineError(err instanceof Error ? err.message : String(err));
          setQuarantineLoading(false);
        });
    }
  });

  let activeModelKey = "";

  // Effect to load model detail state when entering model-detail screen
  createEffect(() => {
    const current = currentScreen();
    if (current.name === "model-detail") {
      const { providerId, modelId } = current;
      const modelKey = `${providerId}:${modelId}`;
      if (modelKey === activeModelKey) {
        return;
      }
      activeModelKey = modelKey;

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
            setNumericEdit(null);
            setGenericFieldEdit(null);
          })
          .catch((err: unknown) => {
            const merged = mergeModelDetail(catalogMatch, null, providerId, modelId);
            setLoadedBaseline(merged);
            setDetailDraft(createDraft(merged));
            setDetailNotice(`Error querying persisted detail: ${String(err)}`);
            setNumericEdit(null);
            setGenericFieldEdit(null);
          });
      } else {
        const merged = mergeModelDetail(catalogMatch, null, providerId, modelId);
        setLoadedBaseline(merged);
        setDetailDraft(createDraft(merged));
        setDetailNotice(undefined);
        setDetailValidation(undefined);
        setNumericEdit(null);
        setGenericFieldEdit(null);
      }
    } else {
      activeModelKey = "";
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
    if (screen.name === "quarantines") {
      return quarantines().length;
    }

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

async function handleSaveIntent(): Promise<void> {
    const draft = detailDraft();
    if (!draft) return;
    const res = validateDraft(draft);
    if (!res.isValid) {
      setDetailValidation(res);
      setDetailNotice(undefined);
      return;
    }

    // Persistence is unavailable: block Save entirely (no in-memory fallback).
    if (!props.saveDetailUseCase) {
      const why = props.persistenceUnavailableReason ?? 'Save use case is not wired';
      setDetailValidation(undefined);
      setDetailNotice(`Persistence unavailable: ${why}. Save is disabled.`);
      return;
    }

    const current = currentScreen();
    if (current.name !== "model-detail") return;
    const { providerId, modelId } = current;
    const base = loadedBaseline();

    try {
        const saveRes = await props.saveDetailUseCase.execute({
          providerId,
          modelId,
          providerName: draft.providerName,
          modelName: draft.modelName,
          isBlocked: draft.isBlocked,
          subscription: draft.subscriptionTier,
          planName: draft.planName || null,
          periodicCost: draft.periodicCost !== null ? Number(draft.periodicCost) : null,
          includedUsage: draft.includedUsage !== null ? Number(draft.includedUsage) : null,
          overageRate: draft.overageRate !== null ? Number(draft.overageRate) : null,
          contextWindow: draft.contextWindow !== null ? Number(draft.contextWindow) : null,
          maxOutputTokens: draft.maxOutputTokens !== null ? Number(draft.maxOutputTokens) : null,
          capabilities: Object.entries(draft.capabilities)
            .filter(([_, enabled]) => Boolean(enabled))
            .map(([cap]) => cap),
          benchmarks: {
            mmlu: draft.benchmarks.mmlu !== null ? Number(draft.benchmarks.mmlu) : null,
            humaneval: draft.benchmarks.humaneval !== null ? Number(draft.benchmarks.humaneval) : null,
            sweBench: draft.benchmarks.sweBench !== null ? Number(draft.benchmarks.sweBench) : null,
            gpqa: draft.benchmarks.gpqa !== null ? Number(draft.benchmarks.gpqa) : null,
            math: draft.benchmarks.math !== null ? Number(draft.benchmarks.math) : null,
            bbh: draft.benchmarks.bbh !== null ? Number(draft.benchmarks.bbh) : null,
            mtBench: draft.benchmarks.mtBench !== null ? Number(draft.benchmarks.mtBench) : null,
            multineedle: draft.benchmarks.multineedle !== null ? Number(draft.benchmarks.multineedle) : null,
          },
          pricing: {
            inputPerMillion: draft.inputPerMillion !== null ? Number(draft.inputPerMillion) : null,
            outputPerMillion: draft.outputPerMillion !== null ? Number(draft.outputPerMillion) : null,
            cachedPerMillion: draft.cachedPerMillion !== null ? Number(draft.cachedPerMillion) : null,
            currency: draft.currency || 'USD',
          },
          expectedEnvelopeHash: base?.metadataEnvelopeHash ?? null,
        });

        // Branch on the typed outcome. Verified swaps baseline/draft and
        // renders the success notice; committed-unverified KEEPS the prior
        // baseline/draft (no swap, no in-memory "clean" promotion), does
        // NOT publish to the runtime registry (the use case guarantees
        // that), and renders a truthful fix-forward warning with the
        // mismatches/guidance so the user can identify what committed.
        if (saveRes.outcome === 'verified') {
          const newBase: LoadedDetail = {
            ...draft,
            metadataEnvelopeHash: saveRes.envelopeHash,
            updatedAt: saveRes.updatedAt,
          };
          setLoadedBaseline(newBase);
          setDetailDraft(createDraft(newBase));
          setDetailValidation(undefined);
          setDetailNotice(
            saveRes.warning
              ? `Database persistence verified but live runtime application failed.`
              : `Persisted and verified`,
          );
        } else {
          // committed-unverified: prior baseline/draft remain unchanged.
          // Render the warning/guidance notice so the user can identify
          // what committed and what to reconcile.
          const mismatchLines = (saveRes.mismatches ?? []).slice(0, 3).join('; ');
          const more = (saveRes.mismatches ?? []).length > 3 ? '…' : '';
          const guidance = saveRes.guidance ?? 'Verification disagreed after commit.';
          const notice =
            `Save committed (hash ${saveRes.envelopeHash}) but verifier disagrees — no live publication.` +
            (mismatchLines ? ` Mismatches: ${mismatchLines}${more}.` : '') +
            ` ${guidance}`;
          setDetailValidation(undefined);
          setDetailNotice(notice);
        }
      } catch (err: any) {
        if (err.message && err.message.includes("Conflict")) {
          setDetailNotice("Conflict: state was modified by another operation. Re-reading...");
          // Conflict re-read
          if (props.detailQuery) {
            const reloaded = await props.detailQuery.findModelDetail(providerId, modelId);
            if (reloaded) {
              const catalogMatch = rawModels().find(m => m.providerId === providerId && m.modelId === modelId) ?? null;
              const merged = mergeModelDetail(catalogMatch, reloaded, providerId, modelId);
              setLoadedBaseline(merged);
              setDetailDraft(createDraft(merged));
            }
          }
        } else {
          setDetailNotice(`Save error: ${err.message}`);
        }
    }
  }

  function appendNumericInput(input: string): void {
    setNumericEdit((current) => {
      if (!current) return current;
      const next = appendNumericEdit(current, input);
      return { tab: current.tab, index: current.index, buffer: next.buffer };
    });
  }

  function deleteNumericInput(): void {
    setNumericEdit((current) => {
      if (!current) return current;
      const next = backspaceNumericEdit(current);
      return { tab: current.tab, index: current.index, buffer: next.buffer };
    });
  }

  function commitNumericEdit(): void {
    const edit = numericEdit();
    const draft = detailDraft();
    if (!edit || !draft) return;

    const parsed = parseNumericEdit(edit);
    if (!parsed.ok) {
      setNumericEdit({ ...edit, error: parsed.error });
      return;
    }

    setDetailDraft(updateNumericDetailField(draft, edit.tab, edit.index, parsed.value));
    setNumericEdit(null);
    setDetailValidation(undefined);
    setDetailNotice(undefined);
  }

  function commitGenericFieldEditSession(): boolean {
    const session = genericFieldEdit();
    if (!session) return true;

    const committed = commitFieldEdit(session);
    if (!committed.ok) {
      setGenericFieldEdit({ ...session, error: committed.error });
      return false;
    }

    const draft = detailDraft();
    if (draft) {
      setDetailDraft(session.descriptor.update(draft, committed.value));
    }
    setGenericFieldEdit(null);
    setDetailValidation(undefined);
    setDetailNotice(undefined);
    return true;
  }

  function dispatch(event: NavigationEvent): void {
    const current = currentScreen();

    if (genericFieldEdit()) {
      if (event.type === "activate") {
        commitGenericFieldEditSession();
        return;
      }
      if (event.type === "back") {
        setGenericFieldEdit(null);
        return;
      }
      if (event.type === "up" || event.type === "down" || event.type === "tab-next" || event.type === "tab-prev") {
        if (!commitGenericFieldEditSession()) {
          return;
        }
      }
    }

    if (numericEdit()) {
      if (event.type === "activate") {
        commitNumericEdit();
        return;
      }
      if (event.type === "back") {
        setNumericEdit(null);
        return;
      }
      if (event.type === "tab-next" || event.type === "tab-prev") {
        return;
      }
    }

    if (
      event.type === "activate" &&
      current.name === "model-detail" &&
      current.focus?.area === "fields"
    ) {
      const draft = detailDraft();
      if (draft) {
        if (current.tab === "subscription") {
          const descriptor = getSubscriptionFieldDescriptors()[current.focus.index];
          if (descriptor) {
            setGenericFieldEdit(startFieldEdit(descriptor as FieldDescriptor<unknown>, descriptor.read(draft)));
            return;
          }
        } else {
          const descriptor = getNumericFieldDescriptor(current.tab, current.focus.index);
          if (descriptor) {
            setNumericEdit({
              tab: descriptor.tab,
              index: descriptor.index,
              ...startNumericEdit(descriptor.read(draft)),
            });
            return;
          }
        }
      }
    }

    if (event.type === "save-intent") {
      if (current.name === "model-detail") {
        if (genericFieldEdit()) {
          const session = genericFieldEdit()!;
          const committed = commitFieldEdit(session);
          if (!committed.ok) {
            setGenericFieldEdit({ ...session, error: committed.error });
            return; // Invalid active generic buffer blocks Save
          }
          const draft = detailDraft();
          if (draft) {
            setDetailDraft(session.descriptor.update(draft, committed.value));
          }
          setGenericFieldEdit(null);
        } else if (numericEdit()) {
          commitNumericEdit();
          if (numericEdit()?.error) {
            return; // Invalid/incomplete active numeric buffer blocks Save
          }
        }
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
      // Root escape: ask the host to close the dialog. If the parent
      // (`tui.ts` renderDialog) provided an onClose, it owns the close
      // ordering (idempotent dispose + slot clear + dialog.clear()).
      // Otherwise fall back to clearing the host dialog stack directly.
      if (props.onClose) {
        props.onClose();
      } else if (props.api.ui?.dialog?.clear) {
        props.api.ui.dialog.clear();
      }
    } else {
      setStack(result.stack);
    }
  }

  // Register component-lifetime keymap layer (modeless, priority 200).
  // No `mode` field — the MCC layer preempts host default-priority
  // bindings for the component lifetime; host already owns the modal
  // surface (no competing mode push).
  if (props.api.keymap?.registerLayer) {
    const layerDisposer = props.api.keymap.registerLayer({
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
          name: "mcc.quarantine.create",
          title: "Create Quarantine Overlay",
          run: () => {
            const current = currentScreen();
            if (current.name === "quarantines" && !quarantineOverlay()) {
              setQuarantineOverlay(createQuarantineOverlay("create"));
            }
          },
        },
        {
          name: "mcc.quarantine.modify",
          title: "Modify Quarantine Overlay",
          run: () => {
            const current = currentScreen();
            if (current.name === "quarantines" && !quarantineOverlay()) {
              const view = deriveQuarantineView(quarantines());
              const selectedItem = view.items[current.selectedIndex];
              if (selectedItem) {
                setQuarantineOverlay(
                  createQuarantineOverlay("modify", current.selectedIndex, selectedItem.entry)
                );
              }
            }
          },
        },
        {
          name: "mcc.quarantine.release",
          title: "Release Quarantine Overlay",
          run: () => {
            const current = currentScreen();
            if (current.name === "quarantines" && !quarantineOverlay()) {
              const view = deriveQuarantineView(quarantines());
              const selectedItem = view.items[current.selectedIndex];
              if (selectedItem) {
                setQuarantineOverlay(
                  createQuarantineOverlay("release", current.selectedIndex, selectedItem.entry)
                );
              }
            }
          },
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
        ...NUMERIC_DIGIT_KEYS.map((digit) => ({
          name: `mcc.form.numeric-${digit}`,
          title: `Append Numeric Digit ${digit}`,
          run: () => appendNumericInput(digit),
        })),
        {
          name: "mcc.form.numeric-decimal",
          title: "Append Numeric Decimal Point",
          run: () => appendNumericInput("."),
        },
        {
          name: "mcc.form.numeric-backspace",
          title: "Delete Numeric Character",
          run: () => deleteNumericInput(),
        },
      ],
      bindings: [
        { key: "up", cmd: "mcc.nav.up" },
        { key: "down", cmd: "mcc.nav.down" },
        { key: "enter", cmd: "mcc.nav.activate" },
        { key: "c", cmd: "mcc.quarantine.create" },
        { key: "m", cmd: "mcc.quarantine.modify" },
        { key: "r", cmd: "mcc.quarantine.release" },
        { key: "esc", cmd: "mcc.nav.back" },
        { key: "/", cmd: "mcc.nav.search-start" },
        { key: "tab", cmd: "mcc.nav.tab-next" },
        { key: "shift+tab", cmd: "mcc.nav.tab-prev" },
        { key: "ctrl+s", cmd: "mcc.form.save" },
        ...NUMERIC_DIGIT_KEYS.map((digit) => ({
          key: digit,
          cmd: `mcc.form.numeric-${digit}`,
        })),
        { key: ".", cmd: "mcc.form.numeric-decimal" },
        { key: "backspace", cmd: "mcc.form.numeric-backspace" },
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

    // Plain non-focusable box/text JSX for loading/error states. Host
    // DialogAlert owns Return/Esc which would steal MCC keymap ownership.
    const plainStatus = (title: string, message: string, isError: boolean): JSX.Element =>
      jsxs("box", {
        flexDirection: "column",
        borderStyle: "single",
        padding: 1,
        children: [
          jsx("text", {
            bold: true,
            color: isError ? "red" : "yellow",
            children: title,
          }),
          jsx("text", { marginTop: 1, children: message }),
        ],
      });

    switch (screen.name) {
      case "main-menu":
        return createComponent(MainMenu, { selectedIndex: screen.selectedIndex, api: props.api });

      case "providers": {
        if (catState.status === "loading") {
          return plainStatus("Connected Providers", "Loading connected providers...", false);
        }
        if (catState.status === "error") {
          return plainStatus(
            "Connected Providers Error",
            `Error loading catalog: ${catState.message}`,
            true,
          );
        }
        return createComponent(ProvidersScreen, {
          api: props.api,
          providers: catState.providers,
          selectedIndex: screen.selectedIndex,
        });
      }

      case "quarantines": {
        const screenProps: Record<string, unknown> = {
          api: props.api,
          entries: quarantines(),
          selectedIndex: screen.selectedIndex,
          loading: quarantineLoading(),
          overlay: quarantineOverlay(),
        };
        if (quarantineError() !== undefined) screenProps.error = quarantineError();
        if (quarantineNotice() !== undefined) screenProps.notice = quarantineNotice();
        return createComponent(QuarantinesScreen, screenProps as never);
      }

      case "models": {
        if (catState.status === "loading") {
          return plainStatus(
            `Models (${screen.providerId})`,
            "Loading models...",
            false,
          );
        }
        if (catState.status === "error") {
          return plainStatus(
            `Models Error (${screen.providerId})`,
            `Error loading models: ${catState.message}`,
            true,
          );
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
          return plainStatus(
            `Model Detail (${screen.modelId})`,
            "Loading model detail...",
            false,
          );
        }
        const genericEdit = genericFieldEdit();
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
          numericEdit: numericEdit() ?? undefined,
          fieldEdit: genericEdit
            ? genericEdit.error !== undefined
              ? { descriptor: genericEdit.descriptor, buffer: genericEdit.buffer, error: genericEdit.error }
              : { descriptor: genericEdit.descriptor, buffer: genericEdit.buffer }
            : undefined,
        });
      }
    }
  };

  // Phase 4: active screen reactive inside this owned component
  // (component-lifetime reactive owner). The accessor body approach
  // (`createMemo(() => renderActiveScreen())`) was tested and the
  // OpenTUI renderer did NOT re-insert on signal change. Per the
  // design's explicit fallback, use a getter-based children prop so
  // the children expression is re-evaluated on signal change. The
  // Switch/Match wrapper and the explicit IIFE were also tried and
  // did not produce re-insertion in this renderer. Module-scope memo
  // or bare accessor root are FORBIDDEN.
  const activeScreen = createMemo(() => renderActiveScreen());

  return jsx("box", {
    flexDirection: "column",
    get children() {
      return activeScreen();
    },
  });
}

export default ModelControlCenter;
