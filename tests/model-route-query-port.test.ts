/**
 * RED-first contract tests for `ModelRouteCatalogPort` against the
 * Prisma/SQLite adapter. Identity-only projection: the adapter never
 * exposes benchmark/pricing/subscription columns on candidate rows
 * (authoritative design c96148ae-04f9-468f-9ca7-e14456dc1513).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaModelRouteCatalogAdapter } from "../src/infrastructure/prisma/model-route-catalog.adapter.js";

// Inlined (not the broader temp-database helper) to avoid pulling
// `node:sqlite` types into the strict typecheck allowlist.
function ensureSchema(dbPath: string): void {
  const prismaCli = path.resolve("node_modules", "prisma", "build", "index.js");
  execFileSync(
    process.execPath,
    [prismaCli, "db", "push", "--accept-data-loss", "--url", `file:${dbPath}`],
    { stdio: "ignore", env: { ...process.env, DATABASE_URL: `file:${dbPath}` } },
  );
}

async function runTests(): Promise<void> {
  console.log("--- model-route catalog query port contract ---");

  const dbPath = path.resolve("opencode-models.test-route-catalog.db");
  ensureSchema(dbPath);
  const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${dbPath}` }) });

  await prisma.modelProviderPricing.deleteMany({});
  await prisma.modelProvider.deleteMany({});
  await prisma.model.deleteMany({});
  await prisma.provider.deleteMany({});

  await prisma.provider.create({ data: { id: "google", name: "Google" } });
  await prisma.provider.create({ data: { id: "openai", name: "OpenAI" } });
  await prisma.provider.create({ data: { id: "anthropic", name: "Anthropic" } });
  await prisma.model.create({ data: { id: "gpt-4o", name: "GPT-4o" } });
  await prisma.model.create({ data: { id: "gpt-4o-mini", name: "GPT-4o mini" } });
  await prisma.model.create({ data: { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" } });
  await prisma.model.create({ data: { id: "antigravity-gemini-3.6-flash-tiered", name: "Gemini 3.6 Flash Tiered" } });
  await prisma.model.create({ data: { id: "gemini-1-5-pro", name: "Gemini 1.5 Pro" } });
  await prisma.modelProvider.create({ data: { providerId: "openai", modelId: "gpt-4o" } });
  await prisma.modelProvider.create({ data: { providerId: "openai", modelId: "gpt-4o-mini" } });
  await prisma.modelProvider.create({ data: { providerId: "anthropic", modelId: "claude-3-5-sonnet" } });
  await prisma.modelProvider.create({ data: { providerId: "google", modelId: "antigravity-gemini-3.6-flash-tiered" } });
  await prisma.modelProvider.create({ data: { providerId: "google", modelId: "gemini-1-5-pro" } });

  const adapter = new PrismaModelRouteCatalogAdapter(prisma);

  // existsCanonical: present + absent.
  assert.equal(await adapter.existsCanonical("openai", "gpt-4o"), true, "openai/gpt-4o present");
  assert.equal(
    await adapter.existsCanonical("google", "antigravity-gemini-3.6-flash-tiered"),
    true,
    "google/antigravity-gemini-3.6-flash-tiered present",
  );
  assert.equal(await adapter.existsCanonical("openai", "gpt-5"), false, "absent model id");
  assert.equal(await adapter.existsCanonical("acme", "gpt-4o"), false, "absent provider id");
  assert.equal(await adapter.existsCanonical("", ""), false, "empty pair");
  console.log("  pass: existsCanonical returns true/false correctly");

  // searchNormalized: identity-only projection.
  const hits = await adapter.searchNormalized("gpt-4o", 8);
  assert.ok(hits.length >= 2, `expected >=2 gpt-4o hits, got ${hits.length}`);
  for (const hit of hits) {
    for (const forbidden of ["pricing", "benchmark", "subscription"]) {
      assert.equal(
        (hit as unknown as Record<string, unknown>)[forbidden],
        undefined,
        `candidate rows must not expose ${forbidden}`,
      );
    }
  }
  console.log("  pass: searchNormalized returns identity-only candidates");

  // Case-insensitive over providerId/modelId/modelName.
  const lowerHits = await adapter.searchNormalized("GEMINI", 8);
  assert.ok(lowerHits.some((c) => c.providerId === "google"), "uppercase term matches google/*");
  assert.ok(
    lowerHits.some((c) => c.modelId === "antigravity-gemini-3.6-flash-tiered" || c.modelId === "gemini-1-5-pro"),
    "uppercase term matches gemini-* modelIds",
  );
  console.log("  pass: searchNormalized is case-insensitive across identity columns");

  // Bounded by limit.
  assert.equal((await adapter.searchNormalized("gpt", 1)).length, 1, "limit=1 returns 1 candidate");
  console.log("  pass: searchNormalized honors the limit parameter");

  // Zero matches.
  assert.equal((await adapter.searchNormalized("no-such-model-zzz", 8)).length, 0, "unknown term returns 0");
  console.log("  pass: searchNormalized returns 0 for unknown terms");

  await prisma.$disconnect();
  console.log("✅ All model-route catalog query port contract tests passed.");
}

runTests().catch((err) => { console.error("Test failed:", err); process.exit(1); });