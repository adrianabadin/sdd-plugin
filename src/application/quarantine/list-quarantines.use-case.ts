import type { QuarantineEntry } from "../../domain/model/quarantine.js";
import type { QuarantineWritePort } from "../../ports/quarantine-write.port.js";
import type { QuarantineStore } from "../../infrastructure/runtime/quarantine-store.js";

export class ListQuarantinesUseCase {
  constructor(
    private readonly port: QuarantineWritePort,
    private readonly store?: QuarantineStore,
  ) {}

  async execute(): Promise<QuarantineEntry[]> {
    const entries = await this.port.listQuarantines();
    if (this.store) {
      try {
        this.store.hydrate(entries);
      } catch {
        // Runtime store hydration failure keeps query results
      }
    }
    return entries;
  }
}
