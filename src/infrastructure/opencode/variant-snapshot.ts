/**
 * Variant snapshot — the only place that knows how a model's effort
 * variants are persisted to disk and walked off the OpenCode SDK.
 *
 *  - Generation time: `collectVariantsFromSdk` walks `provider.models`,
 *    extracts each model's `variants` object (the variant keys the
 *    runtime can dispatch against, gated by `capabilities.reasoning`),
 *    and `writeVariantSnapshot` persists the result to
 *    `.opencode/sdd-model-routing/variants.json`.
 *  - Dispatch time: `readVariantSnapshot` loads the file. On missing
 *    or corrupt input, returns an empty Map — the dispatch then treats
 *    every model as variant-less and routes to the base agent with
 *    a non-blocking warning. Routing NEVER breaks on a bad snapshot.
 *
 * The snapshot is keyed by canonical `provider/model` id.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { EffortLevelMapping } from "../../domain/model-routing/effort-levels.js";
import { normalizeEffortLevels } from "../../domain/model-routing/effort-levels.js";

import type { OpenCodeClient } from "./opencode-model-catalog.adapter.js";

export const ROUTING_RELATIVE_DIR = path.join(".opencode", "sdd-model-routing");
export const VARIANTS_RELATIVE = path.join(ROUTING_RELATIVE_DIR, "variants.json");

export interface VariantSnapshot {
  readonly levels: Partial<EffortLevelMapping>;
}

/**
 * Persisted file shape:
 *   { "provider/model": { "levels": { "low": "minimal", "high": "max" } } }
 *
 * Empty `levels` or absent entry means the model has no exposed variants.
 */
export type VariantSnapshotFile = Readonly<Record<string, { readonly levels: Partial<EffortLevelMapping> }>>;

/**
 * Read the on-disk snapshot. Returns an empty Map when the file is
 * missing or unparseable so dispatch never breaks.
 */
export function readVariantSnapshot(workspaceRoot: string): ReadonlyMap<string, VariantSnapshot> {
  const file = path.join(path.resolve(workspaceRoot), VARIANTS_RELATIVE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return new Map();
  }
  const map = new Map<string, VariantSnapshot>();
  for (const [canonical, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const levels = (value as { levels?: unknown }).levels;
    if (!levels || typeof levels !== "object") continue;
    const cleanLevels: Partial<EffortLevelMapping> = {};
    for (const level of ["low", "medium", "high"] as const) {
      const v = (levels as Record<string, unknown>)[level];
      if (typeof v === "string" && v.length > 0) {
        (cleanLevels as Record<string, string>)[level] = v;
      }
    }
    map.set(canonical, { levels: cleanLevels });
  }
  return map;
}

/** Persist a snapshot atomically (single write, parent dir auto-created). */
export function writeVariantSnapshot(
  workspaceRoot: string,
  data: ReadonlyMap<string, VariantSnapshot>,
): void {
  const file = path.join(path.resolve(workspaceRoot), VARIANTS_RELATIVE);
  mkdirSync(path.dirname(file), { recursive: true });
  const out: Record<string, { levels: Partial<EffortLevelMapping> }> = {};
  for (const [canonical, snap] of data.entries()) {
    out[canonical] = { levels: snap.levels };
  }
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
}

interface SdkProviderEntry {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly models?: unknown;
}

interface SdkModelEntry {
  readonly variants?: unknown;
  readonly capabilities?: { readonly reasoning?: unknown } | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Walk the OpenCode SDK providers/models tree and collect each model's
 * variant keys. A model's variants are considered only when
 * `capabilities.reasoning === true` (variant dispatch is a reasoning-
 * tier capability).
 *
 * Result: a Map keyed by `provider/model` -> list of variant keys
 * (the raw SDK keys, not the normalized levels).
 */
export async function collectVariantsFromSdk(
  client: OpenCodeClient,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const providersFn = client.config?.providers;
  if (typeof providersFn !== "function") return out;
  let raw: unknown;
  try {
    raw = await Promise.resolve(providersFn.call(client.config));
  } catch {
    return out;
  }
  if (!isPlainObject(raw)) return out;

  // The endpoint can return either { all: [...], providers: [...], default: ... } or a top-level array.
  const list: unknown[] = [];
  if (Array.isArray(raw)) {
    list.push(...raw);
  } else {
    for (const key of ["all", "providers", "data"] as const) {
      const v = (raw as Record<string, unknown>)[key];
      if (Array.isArray(v)) { list.push(...v); break; }
    }
    if (list.length === 0) {
      for (const v of Object.values(raw)) if (Array.isArray(v)) { list.push(...v); break; }
    }
  }

  for (const prov of list) {
    if (!isPlainObject(prov)) continue;
    const p = prov as SdkProviderEntry;
    const providerId = pickString(p.id) ?? pickString(p.name) ?? "unknown-provider";
    const models = isPlainObject(p.models) ? p.models : {};
    for (const [modelId, modelValue] of Object.entries(models)) {
      if (!isPlainObject(modelValue)) continue;
      const m = modelValue as SdkModelEntry;
      const reasoning = pickBoolean(m.capabilities?.reasoning);
      if (reasoning !== true) continue;
      if (!isPlainObject(m.variants)) continue;
      const variantKeys: string[] = [];
      for (const k of Object.keys(m.variants)) {
        if (typeof k === "string" && k.length > 0) variantKeys.push(k);
      }
      if (variantKeys.length > 0) {
        out.set(`${providerId}/${modelId}`, variantKeys);
      }
    }
  }
  return out;
}

/**
 * Build a `VariantSnapshot` map from raw SDK variant keys. Each
 * canonical id is normalized onto low/medium/high via
 * `normalizeEffortLevels`.
 */
export function buildVariantSnapshots(
  raw: ReadonlyMap<string, string[]>,
): Map<string, VariantSnapshot> {
  const out = new Map<string, VariantSnapshot>();
  for (const [canonical, keys] of raw.entries()) {
    out.set(canonical, { levels: normalizeEffortLevels(keys) });
  }
  return out;
}
