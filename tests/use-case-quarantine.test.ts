import {
  SetQuarantineUseCase,
  ReleaseQuarantineUseCase,
  ListQuarantinesUseCase,
} from "../src/application/quarantine/index.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../src/ports/quarantine-write.port.js";
import type { QuarantineQueryPort, PersistedQuarantine } from "../src/ports/quarantine-query.port.js";
import type { QuarantineDraft, QuarantineEntry, QuarantineTarget } from "../src/domain/model/quarantine.js";
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
      reason: cmd.reason ?? null,
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

/**
 * Verifier-side read port. Mirrors the writer's persisted state by default
 * and lets a test inject "agree" / "disagree" / "null" / "throw" behaviour
 * to exercise the readback gate.
 */
class InMemoryQuarantineQueryPort implements QuarantineQueryPort {
  constructor(
    private readonly writer: InMemoryQuarantineWritePort,
    public behaviour:
      | { mode: "agree" }
      | { mode: "disagree" }
      | { mode: "null" }
      | { mode: "throw" } = { mode: "agree" },
  ) {}

  async findQuarantine(target: QuarantineTarget): Promise<PersistedQuarantine | null> {
    if (this.behaviour.mode === "throw") {
      throw new Error("Verifier connection lost");
    }
    if (this.behaviour.mode === "null") {
      return null;
    }
    const persisted = this.writer.entries.find(
      (e) => e.level === target.level && e.providerId === target.providerId && e.modelId === target.modelId,
    );
    if (!persisted) {
      return null;
    }
    if (this.behaviour.mode === "disagree") {
      return {
        level: persisted.level,
        providerId: persisted.providerId,
        modelId: persisted.modelId,
        type: persisted.type,
        until: persisted.until ?? null,
        reason: persisted.reason ? `${persisted.reason} (stale-readback)` : "stale-readback",
      };
    }
    return {
      level: persisted.level,
      providerId: persisted.providerId,
      modelId: persisted.modelId,
      type: persisted.type,
      until: persisted.until ?? null,
      reason: persisted.reason ?? null,
    };
  }
}

async function runTests() {
  console.log("--- Quarantine Use Cases Unit Tests ---");

  const port = new InMemoryQuarantineWritePort();
  const verifier = new InMemoryQuarantineQueryPort(port);
  const store = new QuarantineStoreImpl();

  const setUseCase = new SetQuarantineUseCase(port, verifier, store);
  const releaseUseCase = new ReleaseQuarantineUseCase(port, verifier, store);
  const listUseCase = new ListQuarantinesUseCase(port, store);

  // 1. Blank reason rejected with no write, no readback, no publish
  const blankDraft: QuarantineDraft = {
    level: "provider",
    providerId: "openai",
    reason: "   ",
    duration: { kind: "permanent" },
  };
  let blankThrew = false;
  try {
    await setUseCase.executeFromDraft(verifier, blankDraft);
  } catch (err) {
    blankThrew = true;
  }
  console.assert(blankThrew, "blank reason must throw before any write");
  console.assert(port.entries.length === 0, "blank reason must not write to persistence");
  console.assert(store.snapshot().length === 0, "blank reason must not publish to runtime store");

  // 2. Invalid TTL rejected with no write, no readback, no publish
  const invalidTtlDraft: QuarantineDraft = {
    level: "provider",
    providerId: "openai",
    reason: "rate limit",
    duration: { kind: "ttl", hours: 0 },
  };
  let ttlThrew = false;
  try {
    await setUseCase.executeFromDraft(verifier, invalidTtlDraft);
  } catch (err) {
    ttlThrew = true;
  }
  console.assert(ttlThrew, "zero TTL must throw before any write");
  console.assert(port.entries.length === 0, "zero TTL must not write to persistence");
  console.assert(store.snapshot().length === 0, "zero TTL must not publish to runtime store");

  // 3. Set Quarantine Valid -> write -> verifier matches -> store publish
  const future = new Date(Date.now() + 60000);
  const entry = await setUseCase.execute({
    level: "provider",
    providerId: "openai",
    type: "ttl",
    until: future,
    reason: "  rate limit  ",
  });
  console.assert(entry.level === "provider", "Entry level set correctly");
  console.assert(entry.reason === "rate limit", "Entry reason trimmed");
  console.assert(store.snapshot().length === 1, "Entry published to runtime store after verified readback");
  console.assert(
    store.snapshot()[0]?.reason === "rate limit",
    "Published entry carries the trimmed reason",
  );

  // 4. Set Quarantine Invalid Target (rejects before any IO)
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

  // 5. Set Quarantine DB Failure -> no publish
  port.shouldFail = true;
  let dbThrew = false;
  try {
    await setUseCase.execute({
      level: "model",
      modelId: "gpt-4o",
      type: "permanent",
      reason: "down",
    });
  } catch (err) {
    dbThrew = true;
  }
  console.assert(dbThrew, "DB failure must throw");
  console.assert(store.snapshot().length === 1, "Runtime store unchanged on DB failure");
  port.shouldFail = false;

  // 6. Verifier disagrees -> no publish, prior projection intact
  const disagreeVerifier = new InMemoryQuarantineQueryPort(port, { mode: "disagree" });
  const priorStoreCount = store.snapshot().length;
  let disagreeThrew = false;
  try {
    await setUseCase.execute({
      level: "modelProvider",
      providerId: "openai",
      modelId: "gpt-4o",
      type: "permanent",
      reason: "should not publish",
    }, disagreeVerifier);
  } catch (err) {
    disagreeThrew = true;
  }
  console.assert(disagreeThrew, "verifier mismatch must surface as an error");
  console.assert(
    store.snapshot().length === priorStoreCount,
    "Runtime store unchanged when verifier disagrees",
  );
  const storedButNotPublished = port.entries.find(
    (e) => e.level === "modelProvider" && e.providerId === "openai" && e.modelId === "gpt-4o",
  );
  console.assert(
    storedButNotPublished !== undefined,
    "Durable write remains even when verifier disagrees (committed-unverified)",
  );
  console.assert(
    !store.snapshot().some(
      (e) => e.level === "modelProvider" && e.providerId === "openai" && e.modelId === "gpt-4o",
    ),
    "Runtime store never receives a non-verified entry",
  );

  // 7. Verifier returns null -> no publish
  const nullVerifier = new InMemoryQuarantineQueryPort(port, { mode: "null" });
  const countBeforeNull = store.snapshot().length;
  let nullThrew = false;
  try {
    await setUseCase.execute({
      level: "model",
      modelId: "other-model",
      type: "permanent",
      reason: "should not publish",
    }, nullVerifier);
  } catch (err) {
    nullThrew = true;
  }
  console.assert(nullThrew, "null readback must surface as an error");
  console.assert(
    store.snapshot().length === countBeforeNull,
    "Runtime store unchanged when verifier returns null",
  );

  // 8. Set operates as idempotent update/extension (same target, new reason + TTL)
  const extended = await setUseCase.execute({
    level: "provider",
    providerId: "openai",
    type: "ttl",
    until: new Date(Date.now() + 120000),
    reason: "extended",
  });
  console.assert(extended.reason === "extended", "idempotent update returns the new reason");
  const providerEntries = port.entries.filter(
    (e) => e.level === "provider" && e.providerId === "openai",
  );
  console.assert(
    providerEntries.length === 1,
    "Idempotent set keeps exactly one row per target",
  );
  console.assert(providerEntries[0]?.reason === "extended", "Idempotent set overwrites the prior reason");

  // 9. Release: write -> verifier confirms cleared state -> store release
  const releaseCountBefore = store.snapshot().length;
  await releaseUseCase.execute({ level: "provider", providerId: "openai" });
  console.assert(
    store.snapshot().length === releaseCountBefore - 1,
    "Release removes the entry from the runtime store after readback confirms",
  );
  const readbackAfterRelease = await verifier.findQuarantine({
    level: "provider",
    providerId: "openai",
  });
  console.assert(readbackAfterRelease === null, "Readback returns null after release");

  // 10. Release: readback failure leaves prior runtime projection intact
  // Seed a new quarantine and try to release it through a verifier that throws.
  await setUseCase.execute({
    level: "model",
    modelId: "gpt-4o",
    type: "permanent",
    reason: "before-fail",
  });
  const snapshotBeforeFailedRelease = store.snapshot().length;
  const throwVerifier = new InMemoryQuarantineQueryPort(port, { mode: "throw" });
  let failedReleaseThrew = false;
  try {
    await releaseUseCase.execute({ level: "model", modelId: "gpt-4o" }, throwVerifier);
  } catch (err) {
    failedReleaseThrew = true;
  }
  console.assert(failedReleaseThrew, "verifier failure must surface as an error");
  console.assert(
    store.snapshot().length === snapshotBeforeFailedRelease,
    "Runtime store unchanged when verifier throws during release",
  );
  const stillPresent = store.snapshot().some(
    (e) => e.level === "model" && e.modelId === "gpt-4o",
  );
  console.assert(stillPresent, "Quarantine still present in runtime store after failed release");

  // 11. List Quarantines Use Case (legacy path: no verifier)
  const list = await listUseCase.execute();
  console.assert(list.length >= 1, "List use case returns entries");
  console.assert(store.snapshot().length >= 1, "List use case hydrates runtime store");

  console.log("✅ All Quarantine Use Cases unit tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
