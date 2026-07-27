import {
  ttlHoursToUntil,
  validateQuarantineDraft,
  type QuarantineDraft,
  type QuarantineEntry,
  type QuarantineTarget,
} from "../../domain/model/quarantine.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../../ports/quarantine-write.port.js";
import type { QuarantineQueryPort } from "../../ports/quarantine-query.port.js";
import type { QuarantineStore } from "../../infrastructure/runtime/quarantine-store.js";

/**
 * Set (create or extend) a quarantine.
 *
 * The runtime invariant the spec scenario "Verified publication" requires is
 * that the `QuarantineStore` projection is mutated only after the durable
 * write has been independently read back. The use case therefore depends on:
 *
 *   - a `QuarantineWritePort` (the Prisma writer, or a test stub) that
 *     performs the durable mutation, and
 *   - a `QuarantineQueryPort` (the Prisma verifier, or a test stub) used to
 *     confirm the row is observable on an independent read.
 *
 * The two ports are intentionally NOT merged: the writer adapter and the
 * verifier adapter are constructed against different Prisma clients in
 * `persistence-context.ts` so the readback exercises a real second
 * connection. PR1's `validateQuarantineDraft`/`ttlHoursToUntil` are reused
 * here; the use case does not duplicate validation.
 */
export class SetQuarantineUseCase {
  constructor(
    private readonly port: QuarantineWritePort,
    private readonly verifier: QuarantineQueryPort,
    private readonly store?: QuarantineStore,
  ) {}

  /**
   * Apply a domain `QuarantineDraft` after re-validating it through the
   * PR1 `validateQuarantineDraft` contract. No DB call is issued when
   * validation fails.
   */
  async executeFromDraft(verifier: QuarantineQueryPort, draft: QuarantineDraft): Promise<QuarantineEntry> {
    const validation = validateQuarantineDraft(draft);
    if (!validation.ok) {
      throw new Error(`Invalid quarantine draft: ${validation.error}`);
    }
    const until =
      draft.duration.kind === "ttl" ? ttlHoursToUntil(draft.duration.hours) : null;
    return this.execute(
      {
        level: draft.level,
        ...(draft.providerId !== undefined ? { providerId: draft.providerId } : {}),
        ...(draft.modelId !== undefined ? { modelId: draft.modelId } : {}),
        type: draft.duration.kind === "ttl" ? "ttl" : "permanent",
        until,
        reason: draft.reason.trim(),
      },
      verifier,
    );
  }

  /**
   * Convenience entry point for the production overlay. The PR2 readback
   * gate is preserved end-to-end: the constructor verifier
   * (`this.verifier`) is used so the test seam in `executeFromDraft` is
   * not required to wire every production call site.
   */
  async submitDraft(draft: QuarantineDraft): Promise<QuarantineEntry> {
    return this.executeFromDraft(this.verifier, draft);
  }

  async execute(
    cmd: SetQuarantineCommand,
    verifier: QuarantineQueryPort = this.verifier,
  ): Promise<QuarantineEntry> {
    if (cmd.level === "provider" && !cmd.providerId) {
      throw new Error("Invalid quarantine command: providerId is required for provider-level quarantine.");
    }
    if (cmd.level === "model" && !cmd.modelId) {
      throw new Error("Invalid quarantine command: modelId is required for model-level quarantine.");
    }
    if (cmd.level === "modelProvider" && (!cmd.providerId || !cmd.modelId)) {
      throw new Error(
        "Invalid quarantine command: providerId and modelId are required for modelProvider-level quarantine.",
      );
    }
    if (cmd.type === "ttl") {
      if (!cmd.until || isNaN(cmd.until.getTime())) {
        throw new Error("Invalid quarantine command: until date is required for ttl quarantine.");
      }
      if (cmd.until.getTime() <= Date.now()) {
        throw new Error("Invalid quarantine command: until date must be in the future.");
      }
    }
    // Reason trim and re-validation: the spec requires a non-empty trimmed
    // reason. We re-validate here so a port implementation that bypasses
    // validation still cannot publish a blank reason to the runtime store.
    const reason = typeof cmd.reason === "string" ? cmd.reason.trim() : null;
    if (reason === null || reason.length === 0) {
      throw new Error("Invalid quarantine command: reason must be a non-empty trimmed string.");
    }

    // Durable write first; the verifier exists to prove the row is
    // observable on a second connection, so any writer failure short-
    // circuits before readback.
    const entry = await this.port.setQuarantine({ ...cmd, reason });

    // Independent readback on the verifier. The use case NEVER publishes
    // to the runtime store when the verifier disagrees, returns null, or
    // throws. The spec scenario "Verification failure" requires this.
    const target: QuarantineTarget = {
      level: cmd.level,
      ...(cmd.providerId !== undefined ? { providerId: cmd.providerId } : {}),
      ...(cmd.modelId !== undefined ? { modelId: cmd.modelId } : {}),
    };
    const readback = await verifier.findQuarantine(target);
    if (
      !readback ||
      readback.type !== entry.type ||
      readback.reason !== entry.reason ||
      !sameUntil(readback.until, entry.until)
    ) {
      throw new Error(
        "Quarantine verification failed: the read-after-write verifier did not observe the persisted row. " +
          "The mutation was committed but the runtime projection was NOT updated.",
      );
    }

    if (this.store) {
      try {
        this.store.publish(entry);
      } catch {
        // Runtime publish failure keeps the verified database commit.
      }
    }
    return entry;
  }
}

function sameUntil(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return a.getTime() === b.getTime();
}
