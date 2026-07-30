// Inspect the memories table schema.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(
  "C:\\Users\\aabad\\Documents\\CODE\\ia\\sdd-plugin2\\.planning\\project-memory-context\\memory-db.db",
  { readOnly: true },
);

const cols = db.prepare("PRAGMA table_info(memories)").all();
console.log("memories columns:");
for (const c of cols) {
  console.log(`  ${c.name} (${c.type})`);
}

const sample = db.prepare("SELECT * FROM memories LIMIT 3").all();
console.log("\nSample rows:");
for (const r of sample) {
  console.log(JSON.stringify(r, null, 2));
}

db.close();
