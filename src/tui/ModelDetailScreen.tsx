import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import type { DetailTab } from "./navigation.js";
import type { DetailDraft, LoadedDetail } from "./model-detail-view.js";
import { isTabDirty, isDraftDirty } from "./model-detail-view.js";
import type { ValidationResult } from "./detail-validation.js";
import {
  getNumericFieldDescriptors,
  getPricingCurrencyFieldIndex,
  getSubscriptionFieldDescriptors,
  type NumericDetailTab,
  type FieldDescriptor,
} from "./model-detail-field-edit.js";

export interface ModelDetailScreenProps {
  api: TuiPluginApi;
  providerId: string;
  modelId: string;
  tab: DetailTab;
  focus?: { area: "tabs" } | { area: "fields"; index: number } | undefined;
  baseline: LoadedDetail;
  draft: DetailDraft;
  validation?: ValidationResult | undefined;
  notice?: string | undefined;
  numericEdit?: {
    tab: NumericDetailTab;
    index: number;
    buffer: string;
    error?: string;
  } | undefined;
  fieldEdit?: {
    descriptor: FieldDescriptor<unknown>;
    buffer: string;
    error?: string;
  } | undefined;
}

const TAB_LIST: readonly DetailTab[] = ["overview", "benchmarks", "pricing", "subscription"];

type FieldEntry = {
  idx: number;
  label: string;
  val: string;
  tag?: string;
  validation?: { status: "ok" | "warn" | "error"; message?: string } | undefined;
};

export function ModelDetailScreen(props: ModelDetailScreenProps): JSX.Element {
  // Plain non-focusable OpenTUI box/text JSX. The `api` prop is
  // retained for type compatibility but is not consulted here.
  void props.api;
  const currentTab = props.tab;
  const isFieldsFocus = props.focus?.area === "fields";
  const fieldIndex = props.focus?.area === "fields" ? props.focus.index : -1;

  // Build Tab Header
  const tabHeaders = TAB_LIST.map((t) => {
    const isActive = t === currentTab;
    const dirty = isTabDirty(t, props.baseline, props.draft);
    const star = dirty ? "*" : "";
    if (isActive) {
      return `[> ${t.toUpperCase()}${star} <]`;
    }
    return ` ${t}${star} `;
  });

  const activeEdit = props.fieldEdit
    ? props.fieldEdit
    : props.numericEdit?.tab === currentTab
      ? props.numericEdit
      : undefined;

  const focusNotice = activeEdit
    ? `[EDITING: ${'descriptor' in activeEdit ? activeEdit.descriptor.label : `Numeric field #${activeEdit.index + 1}`} (Enter to commit, Esc to cancel)]`
    : isFieldsFocus
    ? `[FOCUS: Form Fields (field #${fieldIndex + 1}, Tab/Shift+Tab to move, Esc to exit)]`
    : `[FOCUS: Tab Strip (Tab/Shift+Tab to change tab, Enter to edit fields)]`;

  const dirtyNotice = isDraftDirty(props.baseline, props.draft)
    ? `* UNSAVED DRAFT (Ctrl+S to validate, Esc on tabs to discard)`
    : `[Baseline clean]`;

  const userNotice = props.notice ? `NOTICE: ${props.notice}` : null;
  const errorSummary = props.validation?.errorSummary ? `ERROR: ${props.validation.errorSummary}` : null;

  // Build the active tab's field list (cursor/tag/validation semantics
  // preserved by `formatField` below).
  const fieldEntries: FieldEntry[] = [];
  switch (currentTab) {
    case "overview": {
      fieldEntries.push(
        { idx: 0, label: "Model ID (readonly)", val: props.draft.modelId },
        { idx: 1, label: "Display Name", val: props.draft.modelName },
        { idx: 2, label: "Provider Blocked", val: props.draft.isBlocked ? "Yes" : "No" },
        {
          idx: 3,
          label: "Context Window",
          val: props.draft.contextWindow !== null ? String(props.draft.contextWindow) : "null",
          tag: "pending schema (Task 5)",
          validation: props.validation?.fields["contextWindow"],
        },
        {
          idx: 4,
          label: "Max Output Tokens",
          val: props.draft.maxOutputTokens !== null ? String(props.draft.maxOutputTokens) : "null",
          tag: "pending schema (Task 5)",
          validation: props.validation?.fields["maxOutputTokens"],
        },
        {
          idx: 5,
          label: "Capabilities",
          val: `Vision:${props.draft.capabilities.vision ? "YES" : "NO"} Tools:${
            props.draft.capabilities.tools ? "YES" : "NO"
          } Reasoning:${props.draft.capabilities.reasoning ? "YES" : "NO"}`,
          tag: "pending schema (Task 5)",
        }
      );
      break;
    }

    case "benchmarks": {
      getNumericFieldDescriptors("benchmarks").forEach((descriptor) => {
        const val = descriptor.read(props.draft);
        const valStr = val !== null && val !== undefined ? String(val) : "null";
        fieldEntries.push({
          idx: descriptor.index,
          label: descriptor.label,
          val: valStr,
          validation: props.validation?.fields[descriptor.validationKey],
        });
      });
      break;
    }

    case "pricing": {
      getNumericFieldDescriptors("pricing").forEach((descriptor) => {
        const val = descriptor.read(props.draft);
        fieldEntries.push({
          idx: descriptor.index,
          label: descriptor.label,
          val: val !== null ? `$${val}` : "null",
          validation: props.validation?.fields[descriptor.validationKey],
        });
      });
      fieldEntries.push({
        idx: getPricingCurrencyFieldIndex(),
        label: "Currency",
        val: props.draft.currency,
        validation: props.validation?.fields["currency"],
      });
      break;
    }

    case "subscription": {
      fieldEntries.push(
        { idx: 0, label: "Subscription Enabled", val: props.draft.subscriptionEnabled ? "Yes" : "No" },
        { idx: 1, label: "Tier", val: props.draft.subscriptionTier ?? "null" },
      );
      getSubscriptionFieldDescriptors().forEach((descriptor) => {
        const val = descriptor.read(props.draft);
        let valStr = "null";
        if (val !== null && val !== undefined) {
          valStr = descriptor.kind === "numeric" ? `$${val}` : String(val);
        }
        fieldEntries.push({
          idx: descriptor.index + 2,
          label: descriptor.label,
          val: valStr,
          validation: props.validation?.fields[descriptor.validationKey],
        });
      });
      break;
    }
  }

  return jsxs("box", {
    flexDirection: "column",
    borderStyle: "single",
    padding: 1,
    children: [
      jsx("text", {
        bold: true,
        color: "cyan",
        children: `Model Detail: ${props.draft.modelName}`,
      }),
      jsx("text", { dimColor: true, children: `${props.draft.providerName} / ${props.draft.modelName} (${props.modelId})` }),
      jsxs("box", { flexDirection: "row", marginTop: 1, children: [
        ...tabHeaders.map((h, i) => {
          const isActive = i === TAB_LIST.indexOf(currentTab);
          return jsx("text", {
            color: isActive ? "green" : "white",
            bold: isActive,
            children: `${h}  `,
          });
        }),
      ] }),
      jsx("text", { dimColor: true, marginTop: 1, children: focusNotice }),
      jsx("text", {
        color: isDraftDirty(props.baseline, props.draft) ? "yellow" : "gray",
        children: dirtyNotice,
      }),
      userNotice ? jsx("text", { color: "cyan", children: userNotice }) : null,
      errorSummary ? jsx("text", { color: "red", children: errorSummary }) : null,
      jsx("text", { dimColor: true, children: "----------------------------------------------------------------" }),
      jsxs("box", {
        flexDirection: "column",
        marginTop: 1,
        children: fieldEntries.map((f) => {
          const isSelected = isFieldsFocus && f.idx === fieldIndex;
          const edit = props.fieldEdit && isSelected ? props.fieldEdit : (activeEdit && 'index' in activeEdit && activeEdit.index === f.idx ? activeEdit : undefined);
          const cursor = isSelected ? "> " : "  ";
          const tagStr = f.tag ? ` [${f.tag}]` : "";
          let statusStr = "";
          if (edit?.error) {
            statusStr = ` (ERROR: ${edit.error})`;
          } else if (f.validation?.status === "error") {
            statusStr = ` (ERROR: ${f.validation.message})`;
          } else if (f.validation?.status === "warn") {
            statusStr = ` (WARN: ${f.validation.message})`;
          }
          const displayedValue = edit ? `[EDIT: ${edit.buffer || "<empty>"}]` : f.val;
          return jsx("text", {
            color: isSelected ? "green" : "white",
            bold: isSelected,
            children: `${cursor}${f.label}: ${displayedValue}${tagStr}${statusStr}`,
          });
        }),
      }),
      jsx("text", {
        dimColor: true,
        marginTop: 1,
        children: activeEdit
          ? "0-9/. edit · Backspace delete · Enter commit · Esc cancel"
          : "Tab/Shift+Tab move · Enter edit · Ctrl+S save · Esc back",
      }),
    ],
  });
}

export default ModelDetailScreen;
