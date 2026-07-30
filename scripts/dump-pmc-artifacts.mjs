// Dump PMC memory artifacts by ID. Pass one or more memory IDs as CLI args;
// falls back to the natural-model-routing planning artifacts when none given.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(
  "C:\\Users\\aabad\\Documents\\CODE\\ia\\sdd-plugin2\\.planning\\project-memory-context\\memory-db.db",
  { readOnly: true },
);

const DEFAULT_IDS = [
  "aa40c70b-f635-4246-b94b-e065b0db688e",
  "dcf1d668-3349-4ac1-8d06-ce27a40174ef",
  "41aa141d-1bbf-4cd0-aba7-63f82f83fbd6",
  "1bf62713-dff6-4b0a-a680-f356fa20d13f",
  "d06bf17c-952e-4038-a118-eb3b19aab631",
  "c75cbde5-3588-4e82-99b4-6ff43d519f49",
];

const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_IDS;

for (const id of ids) {
  console.log(`\n=== ${id} ===`);
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  if (!row) {
    console.log("  (no row)");
    continue;
  }
  console.log(`category: ${row.category}`);
  console.log(`tags: ${row.tags}`);
  console.log(`status: ${row.status} / ${row.memory_state}`);
  console.log("--- content ---");
  console.log(row.content);
}

db.close();
