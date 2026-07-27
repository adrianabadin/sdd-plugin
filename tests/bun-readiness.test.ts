import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-bun-readiness-test-"));
const source = path.resolve("opencode-models.test.db");
const destination = path.join(root, "opencode-models.db");
fs.copyFileSync(source, destination);
process.env.SDD_PLUGIN_DB_PATH = destination;

try {
  for (const modulePath of ["../src/infrastructure/runtime/database-path.ts", "../dist/infrastructure/runtime/database-path.js"]) {
    const runtime = await import(modulePath);
    assert.equal(runtime.isValidSqliteDatabase(destination), true, `${modulePath} validates temp schema`);
    assert.equal(runtime.initializeDatabase(), path.resolve(destination), `${modulePath} initializes temp schema`);
    console.log(`  pass: ${modulePath} validates and initializes with Bun`);
  }
} finally {
  delete process.env.SDD_PLUGIN_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

console.log("Bun source + built readiness assertions passed.");
