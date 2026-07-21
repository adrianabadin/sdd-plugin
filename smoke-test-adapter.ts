import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, "opencode-models-smoke.db");
const databaseUrl = `file:${dbPath}`;

console.log("Using smoke DB path:", dbPath);
console.log("Database URL:", databaseUrl);

// Reset database file
for (const suffix of ["", "-journal", "-shm", "-wal"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

// Push schema to the smoke database
console.log("Running prisma db push...");
execSync(
  `npx prisma db push --schema="${path.resolve(__dirname, "prisma", "schema.prisma")}" --url="${databaseUrl}" --accept-data-loss`,
  { stdio: "inherit" }
);

// 1. Initialize Prisma with PrismaLibSql driver adapter
const adapter = new PrismaLibSql({
  url: databaseUrl,
});
const prisma = new PrismaClient({ adapter });

async function runSmokeTest() {
  console.log("Starting smoke test...");
  
  // Test simple upsert
  const providerId = "smoke-provider-" + Date.now();
  const provider = await prisma.provider.upsert({
    where: { id: providerId },
    update: { name: "Smoke Test Provider (Updated)" },
    create: { id: providerId, name: "Smoke Test Provider" },
  });
  
  console.log("Upserted provider:", provider);
  
  const found = await prisma.provider.findUnique({
    where: { id: providerId },
  });
  
  console.log("Found provider in DB:", found);
  if (!found || found.name !== "Smoke Test Provider") {
    throw new Error("Smoke test failed: Provider not found or name mismatch");
  }
  
  console.log("Smoke test passed successfully!");
}

runSmokeTest()
  .catch((err) => {
    console.error("Smoke test failed with error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
