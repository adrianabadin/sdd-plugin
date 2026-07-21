import {
  isQuarantineActive,
  resolveQuarantinePrecedence,
  type QuarantineEntry,
  type QuarantineTarget,
} from "../../domain/model/quarantine.js";

export interface QuarantineStore {
  hydrate(entries: QuarantineEntry[]): void;
  publish(entry: QuarantineEntry): void;
  release(target: QuarantineTarget): void;
  isActive(providerId: string, modelId: string, now?: Date): boolean;
  snapshot(): readonly QuarantineEntry[];
}

const QUARANTINE_STORE_SYMBOL = Symbol.for("sdd-plugin.quarantine-store.v1");

export class QuarantineStoreImpl implements QuarantineStore {
  private entries: QuarantineEntry[] = [];

  hydrate(entries: QuarantineEntry[]): void {
    this.entries = [...entries];
  }

  publish(entry: QuarantineEntry): void {
    // Remove existing entry for the exact same target if present
    this.entries = this.entries.filter((e) => !isSameTarget(e, entry));
    this.entries.push(entry);
  }

  release(target: QuarantineTarget): void {
    this.entries = this.entries.filter((e) => !isSameTarget(e, target));
  }

  isActive(providerId: string, modelId: string, now: Date = new Date()): boolean {
    const resolved = resolveQuarantinePrecedence(this.entries, providerId, modelId, now);
    return resolved !== null;
  }

  snapshot(): readonly QuarantineEntry[] {
    return Object.freeze([...this.entries]);
  }
}

function isSameTarget(
  a: QuarantineTarget | QuarantineEntry,
  b: QuarantineTarget | QuarantineEntry,
): boolean {
  if (a.level !== b.level) return false;
  if (a.level === "provider") return a.providerId === b.providerId;
  if (a.level === "model") return a.modelId === b.modelId;
  if (a.level === "modelProvider") return a.providerId === b.providerId && a.modelId === b.modelId;
  return false;
}

export function getGlobalQuarantineStore(): QuarantineStore {
  const g = globalThis as unknown as Record<symbol, QuarantineStore | undefined>;
  if (!g[QUARANTINE_STORE_SYMBOL]) {
    g[QUARANTINE_STORE_SYMBOL] = new QuarantineStoreImpl();
  }
  return g[QUARANTINE_STORE_SYMBOL]!;
}
