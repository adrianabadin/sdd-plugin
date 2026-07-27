import {
  acceptNumericBuffer,
  getNumericFieldDescriptor as getFieldDescriptor,
  getNumericFieldDescriptors as getFieldDescriptors,
  getPricingCurrencyFieldIndex as getPricingIndex,
  parseNumericBuffer,
  updateNumericDetailField,
} from "./model-detail-field-edit.js";
import type { NumericDetailTab } from "./model-detail-field-edit.js";

export type { NumericDetailTab };

export interface NumericFieldDescriptor {
  readonly tab: NumericDetailTab;
  readonly index: number;
  readonly path: string;
  readonly label: string;
  readonly validationKey: string;
  read(draft: import("./model-detail-view.js").DetailDraft): number | null;
  update(draft: import("./model-detail-view.js").DetailDraft, value: number): import("./model-detail-view.js").DetailDraft;
}

export interface NumericEditSession {
  readonly buffer: string;
  readonly error?: string;
}

export function getNumericFieldDescriptors(
  tab: NumericDetailTab,
): readonly NumericFieldDescriptor[] {
  return getFieldDescriptors(tab);
}

export function getPricingCurrencyFieldIndex(): number {
  return getPricingIndex();
}

export function getNumericFieldDescriptor(
  tab: string,
  index: number,
): NumericFieldDescriptor | undefined {
  return getFieldDescriptor(tab, index);
}

export { updateNumericDetailField };

export function startNumericEdit(value: number | null): NumericEditSession {
  return { buffer: value === null ? "" : String(value) };
}

export function appendNumericEdit(session: NumericEditSession, input: string): NumericEditSession {
  const buffer = acceptNumericBuffer(session.buffer, input);
  return buffer === null ? session : { buffer };
}

export function backspaceNumericEdit(session: NumericEditSession): NumericEditSession {
  return { buffer: session.buffer.slice(0, -1) };
}

export function parseNumericEdit(
  session: NumericEditSession,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string } {
  return parseNumericBuffer(session.buffer);
}
