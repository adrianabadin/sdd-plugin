import type { QuarantineTarget } from "../../domain/model/quarantine.js";
import type { QuarantineWritePort } from "../../ports/quarantine-write.port.js";
import type { QuarantineQueryPort } from "../../ports/quarantine-query.port.js";
import type { QuarantineStore } from "../../infrastructure/runtime/quarantine-store.js";

/**
 * Release a quarantine.
 *
 * Mirrors `SetQuarantineUseCase`: the runtime projection is mutated only
 * after the durable release is confirmed by an independent readback. The
 * release path expects the verifier to observe either an empty row
 * (`findQuarantine` returns `null`) or a row whose `quarantineType` is
 * null — either signals the cleared state.
 */
export class ReleaseQuarantineUseCase {
  constructor(
    private readonly port: QuarantineWritePort,
    private readonly verifier: QuarantineQueryPort,
    private readonly store?: QuarantineStore,
  ) {}

  async execute(
    target: QuarantineTarget,
    verifier: QuarantineQueryPort = this.verifier,
  ): Promise<void> {
    if (target.level === "provider" && !target.providerId) {
      throw new Error("Invalid release target: providerId is required for provider level.");
    }
    if (target.level === "model" && !target.modelId) {
      throw new Error("Invalid release target: modelId is required for model level.");
    }
    if (target.level === "modelProvider" && (!target.providerId || !target.modelId)) {
      throw new Error("Invalid release target: providerId and modelId are required for modelProvider level.");
    }

    await this.port.releaseQuarantine(target);

    // Independent readback: confirm the row is in the cleared state. The
    // readback contract is "no quarantine row" or "row with no active
    // quarantine type". Any disagreement is reported as a failure and
    // leaves the prior runtime projection intact.
    const readback = await verifier.findQuarantine(target);
    if (readback !== null && readback.type !== null) {
      throw new Error(
        "Quarantine release verification failed: the read-after-write verifier still observes an active quarantine row. " +
          "The mutation was committed but the runtime projection was NOT updated.",
      );
    }

    if (this.store) {
      try {
        this.store.release(target);
      } catch {
        // Runtime store release failure keeps the verified database commit.
      }
    }
  }

  /**
   * Convenience entry point for the production release overlay. Uses
   * the constructor verifier (PR2 readback gate) so call sites do not
   * need to know about the verifier seam.
   */
  async releaseFromTarget(target: QuarantineTarget): Promise<void> {
    return this.execute(target, this.verifier);
  }
}
