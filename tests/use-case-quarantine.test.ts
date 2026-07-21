import {
  SetQuarantineUseCase,
  ReleaseQuarantineUseCase,
  ListQuarantinesUseCase,
} from "../src/application/quarantine/index.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../src/ports/quarantine-write.port.js";
import type { QuarantineEntry, QuarantineTarget } from "../src/domain/model/quarantine.js";
import { QuarantineStoreImpl } from "../src/infrastructure/runtime/quarantine-store.js";

class InMemoryQuarantineWritePort implements QuarantineWritePort {
  entries: QuarantineEntry[] = [];
  shouldFail = false;

  async setQuarantine(cmd: SetQuarantineCommand): Promise<QuarantineEntry> {
    if (this.shouldFail) throw new Error("DB Error: write failed");
    const entry: QuarantineEntry = {
      level: cmd.level,
      providerId: cmd.providerId,
      modelId: cmd.modelId,
      type: cmd.type,
      until: cmd.until ?? null,
    };
    this.entries = this.entries.filter(
      (e) => !(e.level === cmd.level && e.providerId === cmd.providerId && e.modelId === cmd.modelId)
    );
    this.entries.push(entry);
    return entry;
  }

  async releaseQuarantine(target: QuarantineTarget): Promise<void> {
    if (this.shouldFail) throw new Error("DB Error: release failed");
    this.entries = this.entries.filter(
      (e) => !(e.level === target.level && e.providerId === target.providerId && e.modelId === target.modelId)
    );
  }

  async listQuarantines(): Promise<QuarantineEntry[]> {
    if (this.shouldFail) throw new Error("DB Error: list failed");
    return [...this.entries];
  }
}

async function runTests() {
  console.log("--- Quarantine Use Cases Unit Tests ---");

  const port = new InMemoryQuarantineWritePort();
  const store = new QuarantineStoreImpl();

  const setUseCase = new SetQuarantineUseCase(port, store);
  const releaseUseCase = new ReleaseQuarantineUseCase(port, store);
  const listUseCase = new ListQuarantinesUseCase(port, store);

  // 1. Set Quarantine Valid
  const future = new Date(Date.now() + 60000);
  const entry = await setUseCase.execute({
    level: "provider",
    providerId: "openai",
    type: "ttl",
    until: future,
  });
  console.assert(entry.level === "provider", "Entry level set correctly");
  console.assert(store.snapshot().length === 1, "Entry published to runtime store");

  // 2. Set Quarantine Invalid Target
  let threw = false;
  try {
    await setUseCase.execute({
      level: "provider",
      type: "permanent",
    });
  } catch (err: any) {
    threw = true;
    console.assert(err.message.includes("providerId"), "Error message mentions missing providerId");
  }
  console.assert(threw, "Must throw on missing providerId for provider level");

  // 3. Set Quarantine DB Failure
  port.shouldFail = true;
  let dbThrew = false;
  try {
    await setUseCase.execute({
      level: "model",
      modelId: "gpt-4o",
      type: "permanent",
    });
  } catch (err) {
    dbThrew = true;
  }
  console.assert(dbThrew, "DB failure must throw");
  console.assert(store.snapshot().length === 1, "Runtime store unchanged on DB failure");
  port.shouldFail = false;

  // 4. List Quarantines Use Case
  const list = await listUseCase.execute();
  console.assert(list.length === 1, "List use case returns entries");
  console.assert(store.snapshot().length === 1, "List use case hydrates runtime store");

  // 5. Release Quarantine
  await releaseUseCase.execute({
    level: "provider",
    providerId: "openai",
  });
  console.assert(store.snapshot().length === 0, "Release removes entry from store");
  const listAfterRelease = await listUseCase.execute();
  console.assert(listAfterRelease.length === 0, "Release removes entry from persistence");

  console.log("✅ All Quarantine Use Cases unit tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
