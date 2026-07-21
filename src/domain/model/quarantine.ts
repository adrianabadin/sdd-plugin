/**
 * Domain primitive: the lifetime of a quarantine at any level.
 *
 * - "ttl":      active until `quarantineUntil` (e.g. temporary outage).
 * - "permanent": never re-enabled until a human intervenes.
 *
 * This type is intentionally narrow (string literal union) so the use case
 * cannot accidentally persist a malformed value.
 */
export type QuarantineType = "ttl" | "permanent";
export type QuarantineLevel = "provider" | "model" | "modelProvider";

export interface QuarantineTarget {
  level: QuarantineLevel;
  providerId?: string;
  modelId?: string;
}

export interface QuarantineEntry {
  level: QuarantineLevel;
  providerId?: string;
  modelId?: string;
  type: QuarantineType;
  until?: Date | null;
}

export function isQuarantineActive(entry: QuarantineEntry, now: Date = new Date()): boolean {
  if (entry.type === "permanent") {
    return true;
  }
  if (entry.type === "ttl" && entry.until) {
    return now.getTime() < entry.until.getTime();
  }
  return false;
}

export function resolveQuarantinePrecedence(
  entries: QuarantineEntry[],
  providerId: string,
  modelId: string,
  now: Date = new Date(),
): QuarantineEntry | null {
  // Precedence order: provider > model > modelProvider
  const providerEntry = entries.find(
    (e) => e.level === "provider" && e.providerId === providerId && isQuarantineActive(e, now),
  );
  if (providerEntry) return providerEntry;

  const modelEntry = entries.find(
    (e) => e.level === "model" && e.modelId === modelId && isQuarantineActive(e, now),
  );
  if (modelEntry) return modelEntry;

  const connectionEntry = entries.find(
    (e) =>
      e.level === "modelProvider" &&
      e.providerId === providerId &&
      e.modelId === modelId &&
      isQuarantineActive(e, now),
  );
  if (connectionEntry) return connectionEntry;

  return null;
}

