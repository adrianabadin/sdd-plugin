import type { QuarantineTarget } from "../../domain/model/quarantine.js";
import type { QuarantineWritePort } from "../../ports/quarantine-write.port.js";
import type { QuarantineStore } from "../../infrastructure/runtime/quarantine-store.js";

export class ReleaseQuarantineUseCase {
  constructor(
    private readonly port: QuarantineWritePort,
    private readonly store?: QuarantineStore,
  ) {}

  async execute(target: QuarantineTarget): Promise<void> {
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
    if (this.store) {
      try {
        this.store.release(target);
      } catch {
        // Runtime store release failure keeps database commit
      }
    }
  }
}
