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

export type QuarantineDuration =
  | { readonly kind: "permanent" }
  | { readonly kind: "ttl"; readonly hours: number };

export interface QuarantineTarget {
  level: QuarantineLevel;
  providerId?: string;
  modelId?: string;
}

export interface QuarantineDraft extends QuarantineTarget {
  reason: string;
  duration: QuarantineDuration;
}

export type QuarantineDraftValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface QuarantineEntry {
  level: QuarantineLevel;
  providerId?: string;
  modelId?: string;
  type: QuarantineType;
  until?: Date | null;
  reason?: string | null;
}

const INVALID_TTL_ERROR = "TTL hours must be a positive finite number";

export function ttlHoursToUntil(
  input: number | null | undefined | QuarantineDuration,
  now: Date = new Date(),
): Date | null {
  const hours =
    input !== null && typeof input === "object"
      ? input.kind === "permanent"
        ? null
        : input.hours
      : input;

  if (hours === null || hours === undefined) return null;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) {
    throw new RangeError(INVALID_TTL_ERROR);
  }

  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

export function validateQuarantineDraft(draft: QuarantineDraft): QuarantineDraftValidation {
  if (typeof draft.reason !== "string" || draft.reason.trim().length === 0) {
    return { ok: false, error: "Quarantine reason must not be empty" };
  }

  if (draft.level === "provider" && !draft.providerId?.trim()) {
    return { ok: false, error: "Provider quarantines require a provider id" };
  }
  if (draft.level === "model" && !draft.modelId?.trim()) {
    return { ok: false, error: "Model quarantines require a model id" };
  }
  if (draft.level === "modelProvider" && (!draft.providerId?.trim() || !draft.modelId?.trim())) {
    return { ok: false, error: "Model-provider quarantines require provider and model ids" };
  }

  if (draft.duration.kind === "permanent") return { ok: true };
  if (
    draft.duration.kind !== "ttl" ||
    typeof draft.duration.hours !== "number" ||
    !Number.isFinite(draft.duration.hours) ||
    draft.duration.hours <= 0
  ) {
    return { ok: false, error: INVALID_TTL_ERROR };
  }

  return { ok: true };
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

