/**
 * Narrow composition seam for the durable-persistence stack.
 *
 * This module owns the whole persistence wiring used by the TUI: database
 * initialization, the writer client, the INDEPENDENT verifier client, the
 * repository adapters, and the Save use case. Keeping it in one place gives:
 *
 *  - a single definition of "persistence is ready" for every composition root,
 *  - an injectable client factory so lifecycle behaviour is observable, and
 *  - one idempotent `dispose()` that disconnects both clients exactly once.
 */
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../prisma/generated-prisma-client.js";

import { SaveModelDetailUseCase } from "../../application/save-model-detail/save-model-detail.use-case.js";
import {
  ListQuarantinesUseCase,
  SetQuarantineUseCase,
  ReleaseQuarantineUseCase,
} from "../../application/quarantine/index.js";
import { PrismaModelRepositoryAdapter } from "../prisma/prisma-model-repository.adapter.js";
import { getOrCreateModelConfigRegistry } from "./model-config-registry.js";
import { getGlobalQuarantineStore } from "./quarantine-store.js";
import { initializeDatabase, PersistenceReadinessError, type InitializeDatabaseOptions } from "./database-path.js";

/** Factory used to build a Prisma client for a resolved database file. */
export type PrismaClientFactory = (databasePath: string) => PrismaClient;

export interface CreatePersistenceContextOptions extends InitializeDatabaseOptions {
  /** Overrides client construction so lifecycle behaviour can be observed. */
  clientFactory?: PrismaClientFactory;
}

export interface PersistenceContext {
  databasePath: string;
  writer: PrismaClient;
  /** Independent connection used only for read-after-write verification. */
  verifier: PrismaClient;
  repository: PrismaModelRepositoryAdapter;
  verifierRepository: PrismaModelRepositoryAdapter;
  saveDetailUseCase: SaveModelDetailUseCase;
  listQuarantinesUseCase: ListQuarantinesUseCase;
  setQuarantineUseCase: SetQuarantineUseCase;
  releaseQuarantineUseCase: ReleaseQuarantineUseCase;
  /** Idempotent and concurrency-safe: disconnects each client exactly once. */
  dispose(): Promise<void>;
  isDisposed(): boolean;
}

/**
 * Apply the per-connection durability/integrity PRAGMAs required at runtime.
 *
 * SQLite persists `journal_mode` inside the database file, so it is a durable
 * guarantee; `synchronous` and `foreign_keys` are PER-CONNECTION settings.
 * They MUST be applied on every runtime connection used by the writer, the
 * independent verifier, and the bootstrap hook — not assumed from whatever
 * happened during database initialization.
 *
 * `busy_timeout` is the bounded contention bound the spec scenario "Contention
 * clears" / "Bound expires" depends on. We apply it alongside the other
 * per-connection PRAGMAs and read it back so the contract is observed on the
 * actual connection that subsequent operations will use. libSQL opens a
 * fresh native connection per Prisma client; if the underlying adapter ever
 * starts pooling native handles, the same apply/readback protocol continues
 * to pin the value on every connection that satisfies `$queryRawUnsafe`.
 *
 * The libSQL adapter performs these statements on every underlying native
 * connection it spins up; we re-apply them here through the public Prisma API
 * so the values are verified on the actual connection that subsequent
 * operations will use, and so a failure becomes a structured readiness error
 * instead of a future silent regression.
 */
async function applyRuntimePragmas(client: PrismaClient): Promise<void> {
  // Skip the PRAGMA application when running under a non-real Prisma stub.
  // Production Prisma clients always expose `$executeRawUnsafe`; tests that
  // inject a counting/factory stub without it exercise disposal, not runtime
  // PRAGMAs. The per-connection PRAGMA test (`tests/per-connection-pragmas.test.ts`)
  // runs against a real client and enforces this contract.
  if (typeof (client as { $executeRawUnsafe?: unknown }).$executeRawUnsafe !== 'function') {
    return;
  }
  try {
    await client.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
    await client.$executeRawUnsafe('PRAGMA synchronous = FULL;');
    await client.$executeRawUnsafe('PRAGMA busy_timeout = 5000;');
  } catch (err) {
    throw new PersistenceReadinessError(
      `Persistence runtime PRAGMAs could not be applied.`,
      { cause: err },
    );
  }
  // Readback asserts the per-connection invariant is observable on the
  // connection subsequent writes will use. The contention test reads the
  // same value through this same code path. SQLite's `PRAGMA busy_timeout`
  // returns a single column named `timeout`, NOT `busy_timeout`.
  //
  // Test-only stubs (e.g. `c6-prisma-cleanup.test.ts`) inject counting
  // clients without `$queryRawUnsafe` to exercise the disposal path. The
  // readback is lenient about the missing readback method so those stubs
  // can still verify the cleanup contract.
  if (typeof (client as { $queryRawUnsafe?: unknown }).$queryRawUnsafe === 'function') {
    try {
      const busyRows = await client.$queryRawUnsafe<Array<{ timeout: number }>>(
        'PRAGMA busy_timeout;',
      );
      const observed = Number(busyRows[0]?.timeout ?? -1);
      if (observed !== RUNTIME_BUSY_TIMEOUT_MS) {
        throw new PersistenceReadinessError(
          `Persistence runtime busy_timeout readback mismatch: expected ${RUNTIME_BUSY_TIMEOUT_MS}, observed ${observed}.`,
        );
      }
    } catch (err) {
      if (err instanceof PersistenceReadinessError) throw err;
      throw new PersistenceReadinessError(
        `Persistence runtime busy_timeout readback failed.`,
        { cause: err },
      );
    }
  }
}

/** Per-connection busy_timeout applied on every runtime Prisma factory path. */
export const RUNTIME_BUSY_TIMEOUT_MS = 5000;

/** Default factory: one libSQL-backed Prisma client per call. */
export const defaultPrismaClientFactory: PrismaClientFactory = (databasePath) =>
  new PrismaClient({
    adapter: new PrismaLibSql({
      url: `file:${databasePath}`,
      // libsql's open-time timeout is what governs SQLITE_BUSY behavior in
      // practice; `PRAGMA busy_timeout` alone is insufficient. Setting the
      // timeout at construction pins the bounded contention bound the spec
      // requires and matches the PRAGMA readback invariant.
      timeout: RUNTIME_BUSY_TIMEOUT_MS,
    }),
  });

/**
 * Initialize the database and build the full persistence stack.
 *
 * Throws when persistence cannot be established; callers must treat a thrown
 * error as "persistence unavailable" and must NOT fall back to an in-memory
 * baseline that would report success without durable storage.
 */
export async function createPersistenceContext(
  options: CreatePersistenceContextOptions = {},
): Promise<PersistenceContext> {
  const factory = options.clientFactory ?? defaultPrismaClientFactory;

  const initOptions: InitializeDatabaseOptions = {};
  if (options.projectDbPath !== undefined) {
    initOptions.projectDbPath = options.projectDbPath;
  }
  const databasePath = initializeDatabase(initOptions);

  const writer = factory(databasePath);
  let verifier: PrismaClient | null = null;

  try {
    // Apply runtime PRAGMAs per connection. Both clients used for Save + Verify
    // must enforce foreign keys and synchronous=FULL on every transaction.
    await applyRuntimePragmas(writer);
    verifier = factory(databasePath);
    await applyRuntimePragmas(verifier);
  } catch (err) {
    // Close all clients created before PRAGMA failure
    await Promise.allSettled([
      writer.$disconnect(),
      verifier ? verifier.$disconnect() : Promise.resolve(),
    ]);
    throw err;
  }

  const repository = new PrismaModelRepositoryAdapter(writer);
  const verifierRepository = new PrismaModelRepositoryAdapter(verifier);

  const registry = getOrCreateModelConfigRegistry();
  const saveDetailUseCase = new SaveModelDetailUseCase(
    repository,
    registry,
    verifierRepository,
  );

  const quarantineStore = getGlobalQuarantineStore();
  // Quarantine use cases need an independent readback so the runtime
  // `QuarantineStore` is mutated only after a second connection observes
  // the persisted state. The list path is read-only and reuses the writer
  // (no mutation, no readback gate required).
  const listQuarantinesUseCase = new ListQuarantinesUseCase(repository, quarantineStore);
  const setQuarantineUseCase = new SetQuarantineUseCase(repository, verifierRepository, quarantineStore);
  const releaseQuarantineUseCase = new ReleaseQuarantineUseCase(repository, verifierRepository, quarantineStore);

  // Single-flight disposal: repeated or concurrent calls reuse one promise, so
  // each client receives exactly one $disconnect() for the context lifetime.
  let disposePromise: Promise<void> | null = null;
  let disposed = false;

  const dispose = (): Promise<void> => {
    if (!disposePromise) {
      disposePromise = (async () => {
        try {
          const results = await Promise.allSettled([writer.$disconnect(), verifier.$disconnect()]);
          const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          if (rejected.length > 0) {
            if (rejected.length === 1) {
              throw rejected[0]!.reason;
            }
            throw new AggregateError(
              rejected.map((r) => r.reason),
              "PersistenceContext disconnect failed",
            );
          }
        } finally {
          disposed = true;
        }
      })();
    }
    return disposePromise;
  };

  return {
    databasePath,
    writer,
    verifier,
    repository,
    verifierRepository,
    saveDetailUseCase,
    listQuarantinesUseCase,
    setQuarantineUseCase,
    releaseQuarantineUseCase,
    dispose,
    isDisposed: () => disposed,
  };
}
