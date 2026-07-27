import type { BenchmarkScores } from "../domain/benchmark/benchmark-scores.js";
import { updateField, type DetailDraft } from "./model-detail-view.js";
import type { DetailTab } from "./navigation.js";

export type FieldKind = "text" | "enum" | "boolean" | "numeric";
export type FieldParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export interface FieldDescriptor<T> {
  readonly tab: DetailTab;
  readonly index: number;
  readonly path: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly validationKey: string;
  readonly options?: readonly string[];
  read(draft: DetailDraft): T | null;
  update(draft: DetailDraft, value: T): DetailDraft;
  accept(buffer: string, input: string): string | null;
  parse(buffer: string): FieldParseResult<T>;
}

export interface FieldDescriptorConfig<T> {
  readonly tab: DetailTab;
  readonly index: number;
  readonly path: string;
  readonly label: string;
  readonly validationKey: string;
  readonly read: (draft: DetailDraft) => T | null;
  readonly update: (draft: DetailDraft, value: T) => DetailDraft;
}

export interface FieldEditSession<T> {
  readonly descriptor: FieldDescriptor<T>;
  readonly buffer: string;
  // `| undefined` is required so PR2's persistence-tests project (which
  // enables `exactOptionalPropertyTypes`) accepts the explicit clear pattern
  // used by `appendFieldEdit` and `backspaceFieldEdit` below. Behavior is
  // identical to the optional `string` declaration.
  readonly error?: string | undefined;
}

export type FieldEditCommit<T> = FieldParseResult<T>;
export interface FieldEditBinding {
  readonly key: "<character>" | "backspace" | "enter" | "esc";
  readonly action: "append" | "backspace" | "commit" | "cancel";
}

export interface FieldEditCaptureLayer {
  readonly priority: number;
  readonly bindings: readonly FieldEditBinding[];
}

export const BASE_NAVIGATION_PRIORITY = 200;
export const ACTIVE_FIELD_EDIT_PRIORITY = 300;

const FIELD_EDIT_BINDINGS: readonly FieldEditBinding[] = [
  { key: "<character>", action: "append" },
  { key: "backspace", action: "backspace" },
  { key: "enter", action: "commit" },
  { key: "esc", action: "cancel" },
];

function descriptor<T>(
  config: FieldDescriptorConfig<T>,
  kind: FieldKind,
  accept: (buffer: string, input: string) => string | null,
  parse: (buffer: string) => FieldParseResult<T>,
  options?: readonly string[],
): FieldDescriptor<T> {
  return { ...config, kind, accept, parse, ...(options ? { options } : {}) };
}

export function createTextFieldDescriptor(
  config: FieldDescriptorConfig<string>,
): FieldDescriptor<string> {
  return descriptor(
    config,
    "text",
    (buffer, input) => (input.length > 0 ? buffer + input : null),
    (buffer) => {
      const trimmed = buffer.trim();
      return trimmed.length > 0
        ? { ok: true, value: trimmed }
        : { ok: false, error: "Enter a non-empty value" };
    },
  );
}

export function createEnumFieldDescriptor(
  config: FieldDescriptorConfig<string> & { readonly options: readonly string[] },
): FieldDescriptor<string> {
  return descriptor(
    config,
    "enum",
    (buffer, input) => {
      if (input.length === 0) return null;
      const candidate = buffer + input;
      return config.options.some((option) => option.startsWith(candidate)) ? candidate : null;
    },
    (buffer) =>
      config.options.includes(buffer)
        ? { ok: true, value: buffer }
        : { ok: false, error: `Choose one of: ${config.options.join(", ")}` },
    config.options,
  );
}

export function createBooleanFieldDescriptor(
  config: FieldDescriptorConfig<boolean>,
): FieldDescriptor<boolean> {
  return descriptor(
    config,
    "boolean",
    (buffer, input) => {
      if (input.length === 0) return null;
      const candidate = (buffer + input).toLowerCase();
      return ["true", "false"].some((value) => value.startsWith(candidate)) ? candidate : null;
    },
    (buffer) => {
      if (buffer.toLowerCase() === "true") return { ok: true, value: true };
      if (buffer.toLowerCase() === "false") return { ok: true, value: false };
      return { ok: false, error: "Enter true or false" };
    },
  );
}

export function createNumericFieldDescriptor(
  config: FieldDescriptorConfig<number>,
): FieldDescriptor<number> {
  return descriptor(config, "numeric", acceptNumericBuffer, parseNumericBuffer);
}

export function acceptNumericBuffer(buffer: string, input: string): string | null {
  const isDigit = /^[0-9]$/.test(input);
  const isFirstDecimal = input === "." && !buffer.includes(".");
  return isDigit || isFirstDecimal ? buffer + input : null;
}

export function startFieldEdit<T>(
  descriptor: FieldDescriptor<T>,
  value: T | null,
): FieldEditSession<T> {
  return { descriptor, buffer: value === null ? "" : String(value) };
}

export function appendFieldEdit<T>(
  session: FieldEditSession<T>,
  input: string,
): FieldEditSession<T> {
  const buffer = session.descriptor.accept(session.buffer, input);
  return buffer === null ? session : { ...session, buffer, error: undefined };
}

export function backspaceFieldEdit<T>(session: FieldEditSession<T>): FieldEditSession<T> {
  return { ...session, buffer: session.buffer.slice(0, -1), error: undefined };
}

export function commitFieldEdit<T>(session: FieldEditSession<T>): FieldEditCommit<T> {
  return session.descriptor.parse(session.buffer);
}

export function cancelFieldEdit<T>(_session: FieldEditSession<T>): null {
  return null;
}

export function getFieldEditBindings<T>(
  session: FieldEditSession<T> | null,
): readonly FieldEditBinding[] {
  return session ? FIELD_EDIT_BINDINGS : [];
}

export function getFieldEditCaptureLayer<T>(
  session: FieldEditSession<T> | null,
): FieldEditCaptureLayer | null {
  return session
    ? { priority: ACTIVE_FIELD_EDIT_PRIORITY, bindings: FIELD_EDIT_BINDINGS }
    : null;
}

export function parseNumericBuffer(buffer: string): FieldParseResult<number> {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(buffer)) {
    return { ok: false, error: "Enter a finite non-negative number" };
  }

  const value = Number(buffer);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: "Enter a finite non-negative number" };
  }
  return { ok: true, value };
}

export type NumericDetailTab = "benchmarks" | "pricing" | "subscription";
export type NumericFieldDescriptor = FieldDescriptor<number> & { readonly tab: NumericDetailTab };
export type TextFieldDescriptor = FieldDescriptor<string> & { readonly tab: DetailTab };

/**
 * Subscription tab descriptors.
 *
 * The subscription tab is a typed editor surface that reuses the PR1
 * numeric accept/parse contract and the PR1 text accept/parse
 * contract. There are no new persistence columns: the descriptors
 * read/write `Provider.metadata` (planName / periodicCost / includedUsage
 * / overageRate) through the same envelope the existing SaveModelDetail
 * use case already round-trips.
 */
const PLAN_NAME_DESCRIPTOR: TextFieldDescriptor = createTextFieldDescriptor({
  tab: "subscription",
  index: 0,
  path: "planName",
  label: "Plan Name",
  validationKey: "planName",
  read: (draft) => draft.planName,
  update: (draft, value) => updateField(draft, "planName", value),
}) as TextFieldDescriptor;

const PERIODIC_COST_DESCRIPTOR: NumericFieldDescriptor = createNumericFieldDescriptor({
  tab: "subscription",
  index: 1,
  path: "periodicCost",
  label: "Periodic Cost",
  validationKey: "periodicCost",
  read: (draft) => draft.periodicCost,
  update: (draft, value) => updateField(draft, "periodicCost", value),
}) as NumericFieldDescriptor;

const INCLUDED_USAGE_DESCRIPTOR: NumericFieldDescriptor = createNumericFieldDescriptor({
  tab: "subscription",
  index: 2,
  path: "includedUsage",
  label: "Included Usage",
  validationKey: "includedUsage",
  read: (draft) => draft.includedUsage,
  update: (draft, value) => updateField(draft, "includedUsage", value),
}) as NumericFieldDescriptor;

const OVERAGE_RATE_DESCRIPTOR: NumericFieldDescriptor = createNumericFieldDescriptor({
  tab: "subscription",
  index: 3,
  path: "overageRate",
  label: "Overage Rate",
  validationKey: "overageRate",
  read: (draft) => draft.overageRate,
  update: (draft, value) => updateField(draft, "overageRate", value),
}) as NumericFieldDescriptor;

const SUBSCRIPTION_DESCRIPTORS: readonly (
  | TextFieldDescriptor
  | NumericFieldDescriptor
)[] = [
  PLAN_NAME_DESCRIPTOR,
  PERIODIC_COST_DESCRIPTOR,
  INCLUDED_USAGE_DESCRIPTOR,
  OVERAGE_RATE_DESCRIPTOR,
] as const;

/**
 * Stable, ordered list of the subscription-tab field descriptors.
 * The field cursor in `ModelDetailScreen` and the save command in
 * `ModelControlCenter` both rely on this order.
 */
export function getSubscriptionFieldDescriptors(): readonly (
  | TextFieldDescriptor
  | NumericFieldDescriptor
)[] {
  return SUBSCRIPTION_DESCRIPTORS;
}

export function getSubscriptionFieldDescriptor(
  index: number,
): TextFieldDescriptor | NumericFieldDescriptor | undefined {
  return SUBSCRIPTION_DESCRIPTORS[index];
}

const BENCHMARK_FIELDS = [
  "mmlu",
  "humaneval",
  "sweBench",
  "gpqa",
  "math",
  "bbh",
  "mtBench",
  "multineedle",
] as const satisfies ReadonlyArray<keyof BenchmarkScores>;

const PRICING_FIELDS = [
  { key: "inputPerMillion", label: "Input per 1M tokens" },
  { key: "outputPerMillion", label: "Output per 1M tokens" },
  { key: "cachedPerMillion", label: "Cached per 1M tokens" },
] as const satisfies ReadonlyArray<{
  key: "inputPerMillion" | "outputPerMillion" | "cachedPerMillion";
  label: string;
}>;

const BENCHMARK_DESCRIPTORS: readonly NumericFieldDescriptor[] = BENCHMARK_FIELDS.map((key, index) =>
  createNumericFieldDescriptor({
    tab: "benchmarks",
    index,
    path: `benchmarks.${key}`,
    label: key,
    validationKey: key,
    read: (draft) => draft.benchmarks[key] ?? null,
    update: (draft, value) => updateField(draft, "benchmarks", { ...draft.benchmarks, [key]: value }),
  }) as NumericFieldDescriptor,
);

const PRICING_DESCRIPTORS: readonly NumericFieldDescriptor[] = PRICING_FIELDS.map(({ key, label }, index) =>
  createNumericFieldDescriptor({
    tab: "pricing",
    index,
    path: key,
    label,
    validationKey: key,
    read: (draft) => draft[key],
    update: (draft, value) => updateField(draft, key, value),
  }) as NumericFieldDescriptor,
);

export function getNumericFieldDescriptors(tab: NumericDetailTab): readonly NumericFieldDescriptor[] {
  return tab === "benchmarks" ? BENCHMARK_DESCRIPTORS : PRICING_DESCRIPTORS;
}

export function getPricingCurrencyFieldIndex(): number {
  return PRICING_DESCRIPTORS.length;
}

export function getNumericFieldDescriptor(
  tab: string,
  index: number,
): NumericFieldDescriptor | undefined {
  if (tab !== "benchmarks" && tab !== "pricing") return undefined;
  return getNumericFieldDescriptors(tab).find((candidate) => candidate.index === index);
}

export function updateNumericDetailField(
  draft: DetailDraft,
  tab: string,
  index: number,
  value: number,
): DetailDraft {
  const candidate = getNumericFieldDescriptor(tab, index);
  return candidate ? candidate.update(draft, value) : draft;
}
