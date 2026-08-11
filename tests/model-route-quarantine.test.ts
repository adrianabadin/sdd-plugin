/**
 * Unit 5 (RED) — quarantine adapter contract tests.
 *
 * Reads every active quarantine row from the live Prisma catalog and
 * reconciles the global quarantine store. Identity-only projection (the
 * use case graph only needs providerId/modelId for the deterministic
 * routing gate; metadata is never consulted here).
 *
 * Design: 0695919c-2264-4e0d-a3fb-f7d4190661fc.
 * Spec:   1ab4a8ef-2004-4dd6-9721-4fd1e18eff2f.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaLibSql } from "@prisma/adapter-libsql";

import { PrismaModelRouteQuarantineAdapter } from "../src/infrastructure/prisma/model-route-quarantine.adapter.js";

function ensureSchema(dbPath: string): void {
  const prismaCli = path.resolve("node_modules", "prisma", "build", "index.js");
  execFileSync(process.execPath, [prismaCli, "db", "push", "--accept-data-loss", "--url", `file:${dbPath}`], { stdio: "ignore", env: { ...process.env, DATABASE_URL: `file:${dbPath}` } });
}

async function sleep(ms: number): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, ms)); }
async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(50 * (attempt + 1)); }
  }
}

async function run(): Promise<void> {
  console.log("--- model-route quarantine adapter (RED) ---");

  const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-q-"));
  const dbPath = path.join(tmp, "opencode-models.db");
  ensureSchema(dbPath);
  const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${dbPath}` }) });

  try {
    const adapter = new PrismaModelRouteQuarantineAdapter(prisma);
    assert.deepEqual(await adapter.listActive(), [], "empty DB returns empty active list");

    await prisma.provider.create({ data: { id: "openai", name: "OpenAI", quarantineType: "permanent", quarantineReason: "vendor incident" } });
    await prisma.model.create({ data: { id: "gpt-4o", name: "GPT-4o" } });
    await prisma.modelProvider.create({ data: { providerId: "openai", modelId: "gpt-4o" } });

    const active = await adapter.listActive();
    assert.equal(active.length, 1, "one permanent provider quarantine");
    assert.equal(active[0]?.level, "provider");
    assert.equal(active[0]?.providerId, "openai");
    assert.equal(active[0]?.type, "permanent");
    assert.equal(active[0]?.reason, "vendor incident");
    assert.equal(active[0]?.until, null);

    // Released quarantine is excluded.
    await prisma.provider.update({ where: { id: "openai" }, data: { quarantineType: null, quarantineReason: null } });
    assert.deepEqual(await adapter.listActive(), [], "released provider quarantine is excluded");

    // Future TTL is included.
    const future = new Date(Date.now() + 60_000);
    await prisma.provider.update({ where: { id: "openai" }, data: { quarantineType: "ttl", quarantineUntil: future, quarantineReason: "rate-limit" } });
    const ttlActive = await adapter.listActive();
    assert.equal(ttlActive.length, 1);
    assert.equal(ttlActive[0]?.type, "ttl");
    assert.equal(ttlActive[0]?.until?.getTime(), future.getTime());

    // Expired TTL is excluded.
    await prisma.provider.update({ where: { id: "openai" }, data: { quarantineType: "ttl", quarantineUntil: new Date(Date.now() - 60_000) } });
    assert.deepEqual(await adapter.listActive(), [], "expired TTL is excluded");

    // Model scope.
    await prisma.provider.update({ where: { id: "openai" }, data: { quarantineType: null, quarantineReason: null, quarantineUntil: null } });
    await prisma.model.update({ where: { id: "gpt-4o" }, data: { quarantineType: "permanent", quarantineReason: "model-pinned" } });
    const modelActive = await adapter.listActive();
    assert.equal(modelActive.length, 1);
    assert.equal(modelActive[0]?.level, "model");
    assert.equal(modelActive[0]?.modelId, "gpt-4o");
    assert.equal(modelActive[0]?.providerId, undefined);

    // modelProvider scope.
    await prisma.model.update({ where: { id: "gpt-4o" }, data: { quarantineType: null, quarantineReason: null } });
    await prisma.modelProvider.update({ where: { modelId_providerId: { modelId: "gpt-4o", providerId: "openai" } }, data: { quarantineType: "permanent", quarantineReason: "model-provider-pinned" } });
    const mpActive = await adapter.listActive();
    assert.equal(mpActive.length, 1);
    assert.equal(mpActive[0]?.level, "modelProvider");
    assert.equal(mpActive[0]?.providerId, "openai");
    assert.equal(mpActive[0]?.modelId, "gpt-4o");
    assert.equal(mpActive[0]?.reason, "model-provider-pinned");

    // Identity-only projection.
    for (const entry of mpActive) {
      for (const forbidden of ["benchmark", "pricing", "subscription", "capabilities", "contextWindow"]) {
        assert.equal((entry as unknown as Record<string, unknown>)[forbidden], undefined, `quarantine entry must not expose ${forbidden}`);
      }
    }

    // Reconciled store observes the same canonical entries.
    const { QuarantineStoreImpl } = await import("../src/infrastructure/runtime/quarantine-store.js");
    const store = new QuarantineStoreImpl();
    store.reconcile([...mpActive]);
    assert.equal(store.isActive("openai", "gpt-4o"), true, "reconciled store sees modelProvider quarantine");
    assert.equal(store.isActive("openai", "gpt-4-turbo"), false, "store does not invent scopes");

    console.log("All quarantine adapter assertions passed.");
  } finally {
    await prisma.$disconnect();
    await cleanupDir(tmp);
  }
}

run().catch((err: unknown) => { console.error(err); process.exit(1); });
