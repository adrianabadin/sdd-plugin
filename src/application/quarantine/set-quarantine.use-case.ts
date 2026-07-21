import type { QuarantineEntry } from "../../domain/model/quarantine.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../../ports/quarantine-write.port.js";
import type { QuarantineStore } from "../../infrastructure/runtime/quarantine-store.js";

export class SetQuarantineUseCase {
  constructor(
    private readonly port: QuarantineWritePort,
    private readonly store?: QuarantineStore,
  ) {}

  async execute(cmd: SetQuarantineCommand): Promise<QuarantineEntry> {
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
    if (cmd.type === "ttl" && (!cmd.until || isNaN(cmd.until.getTime()))) {
      throw new Error("Invalid quarantine command: until date is required for ttl quarantine.");
    }

    const entry = await this.port.setQuarantine(cmd);
    if (this.store) {
      try {
        this.store.publish(entry);
      } catch {
        // Runtime publish failure keeps database commit
      }
    }
    return entry;
  }
}
