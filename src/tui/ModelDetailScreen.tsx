import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import type { DetailTab } from "./navigation.js";
import type { DetailDraft, LoadedDetail } from "./model-detail-view.js";
import { isTabDirty, isDraftDirty } from "./model-detail-view.js";
import type { ValidationResult } from "./detail-validation.js";

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
}

const TAB_LIST: readonly DetailTab[] = ["overview", "benchmarks", "pricing", "subscription"];

export function ModelDetailScreen(props: ModelDetailScreenProps): JSX.Element {
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

  const focusNotice = isFieldsFocus
    ? `[FOCUS: Form Fields (field #${fieldIndex + 1}, Tab/Shift+Tab to move, Esc to exit)]`
    : `[FOCUS: Tab Strip (Tab/Shift+Tab to change tab, Enter to edit fields)]`;

  const dirtyNotice = isDraftDirty(props.baseline, props.draft)
    ? `* UNSAVED DRAFT (Ctrl+S to validate, Esc on tabs to discard)`
    : `[Baseline clean]`;

  const userNotice = props.notice ? `NOTICE: ${props.notice}` : null;
  const errorSummary = props.validation?.errorSummary ? `ERROR: ${props.validation.errorSummary}` : null;

  const lines: string[] = [
    `${props.draft.providerName} / ${props.draft.modelName} (${props.modelId})`,
    tabHeaders.join("  "),
    focusNotice,
    dirtyNotice,
    userNotice,
    errorSummary,
    "----------------------------------------------------------------",
  ].filter((l): l is string => Boolean(l));

  // Render active tab fields
  switch (currentTab) {
    case "overview": {
      lines.push(
        formatField(0, "Model ID (readonly)", props.draft.modelId, isFieldsFocus, fieldIndex),
        formatField(1, "Display Name", props.draft.modelName, isFieldsFocus, fieldIndex),
        formatField(2, "Provider Blocked", props.draft.isBlocked ? "Yes" : "No", isFieldsFocus, fieldIndex),
        formatField(
          3,
          "Context Window",
          props.draft.contextWindow !== null ? String(props.draft.contextWindow) : "null",
          isFieldsFocus,
          fieldIndex,
          "pending schema (Task 5)",
          props.validation?.fields["contextWindow"]
        ),
        formatField(
          4,
          "Max Output Tokens",
          props.draft.maxOutputTokens !== null ? String(props.draft.maxOutputTokens) : "null",
          isFieldsFocus,
          fieldIndex,
          "pending schema (Task 5)",
          props.validation?.fields["maxOutputTokens"]
        ),
        formatField(
          5,
          "Capabilities",
          `Vision:${props.draft.capabilities.vision ? "YES" : "NO"} Tools:${
            props.draft.capabilities.tools ? "YES" : "NO"
          } Reasoning:${props.draft.capabilities.reasoning ? "YES" : "NO"}`,
          isFieldsFocus,
          fieldIndex,
          "pending schema (Task 5)"
        )
      );
      break;
    }

    case "benchmarks": {
      const benchKeys = [
        "mmlu",
        "humaneval",
        "sweBench",
        "gpqa",
        "math",
        "bbh",
        "mtBench",
        "multineedle",
      ] as const;
      benchKeys.forEach((key, idx) => {
        const val = props.draft.benchmarks[key];
        const valStr = val !== null && val !== undefined ? String(val) : "null";
        lines.push(
          formatField(idx, key, valStr, isFieldsFocus, fieldIndex, undefined, props.validation?.fields[key])
        );
      });
      break;
    }

    case "pricing": {
      lines.push(
        formatField(
          0,
          "Input per 1M tokens",
          props.draft.inputPerMillion !== null ? `$${props.draft.inputPerMillion}` : "null",
          isFieldsFocus,
          fieldIndex,
          undefined,
          props.validation?.fields["inputPerMillion"]
        ),
        formatField(
          1,
          "Output per 1M tokens",
          props.draft.outputPerMillion !== null ? `$${props.draft.outputPerMillion}` : "null",
          isFieldsFocus,
          fieldIndex,
          undefined,
          props.validation?.fields["outputPerMillion"]
        ),
        formatField(
          2,
          "Cached per 1M tokens",
          props.draft.cachedPerMillion !== null ? `$${props.draft.cachedPerMillion}` : "null",
          isFieldsFocus,
          fieldIndex,
          undefined,
          props.validation?.fields["cachedPerMillion"]
        ),
        formatField(
          3,
          "Currency",
          props.draft.currency,
          isFieldsFocus,
          fieldIndex,
          undefined,
          props.validation?.fields["currency"]
        )
      );
      break;
    }

    case "subscription": {
      lines.push(
        formatField(
          0,
          "Subscription Enabled",
          props.draft.subscriptionEnabled ? "Yes" : "No",
          isFieldsFocus,
          fieldIndex
        ),
        formatField(1, "Tier", props.draft.subscriptionTier ?? "null", isFieldsFocus, fieldIndex),
        formatField(
          2,
          "Plan Name",
          props.draft.planName ?? "null",
          isFieldsFocus,
          fieldIndex,
          "pending schema (Task 5)"
        ),
        formatField(
          3,
          "Periodic Cost",
          props.draft.periodicCost !== null ? `$${props.draft.periodicCost}` : "null",
          isFieldsFocus,
          fieldIndex,
          "pending schema (Task 5)",
          props.validation?.fields["periodicCost"]
        ),
        formatField(
          4,
          "Included Usage",
          props.draft.includedUsage !== null ? `$${props.draft.includedUsage}` : "null",
          isFieldsFocus,
          fieldIndex,
          "pending schema (Task 5)",
          props.validation?.fields["includedUsage"]
        ),
        formatField(
          5,
          "Overage Rate",
          props.draft.overageRate !== null ? `$${props.draft.overageRate}` : "null",
          isFieldsFocus,
          fieldIndex,
          "pending schema (Task 5)",
          props.validation?.fields["overageRate"]
        )
      );
      break;
    }
  }

  return props.api.ui.DialogAlert({
    title: `Model Detail: ${props.draft.modelName}`,
    message: lines.join("\n"),
  });
}

function formatField(
  idx: number,
  label: string,
  val: string,
  isFieldsFocus: boolean,
  currentIdx: number,
  tag?: string,
  validation?: { status: "ok" | "warn" | "error"; message?: string }
): string {
  const isSelected = isFieldsFocus && idx === currentIdx;
  const cursor = isSelected ? "> " : "  ";
  const tagStr = tag ? ` [${tag}]` : "";
  let statusStr = "";
  if (validation?.status === "error") {
    statusStr = ` (ERROR: ${validation.message})`;
  } else if (validation?.status === "warn") {
    statusStr = ` (WARN: ${validation.message})`;
  }
  return `${cursor}${label}: ${val}${tagStr}${statusStr}`;
}

export default ModelDetailScreen;
