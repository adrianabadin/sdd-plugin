import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite');
const db = new DatabaseSync('C:/Users/aabad/AppData/Local/sdd-plugin/opencode-models.db', { readOnly: true });

console.log('--- modelos permanentes con benchmark REAL (no placeholder) ---');
const rows = db.prepare(`
  SELECT id, quarantineType, quarantineUntil, substr(quarantineReason,1,80) AS reason, mmlu, sweBench, gpqa
  FROM Model
  WHERE quarantineType = 'permanent' AND (mmlu IS NOT NULL OR sweBench IS NOT NULL OR gpqa IS NOT NULL)
  ORDER BY id
`).all();
for (const r of rows) console.log(`${r.id.padEnd(36)} | ${r.reason || ''}`);

console.log('\n--- conteo por quarantineReason ---');
const reasons = db.prepare(`SELECT quarantineReason, COUNT(*) AS c FROM Model WHERE quarantineType='permanent' GROUP BY quarantineReason`).all();
for (const r of reasons) console.log(`${String(r.c).padEnd(4)} | ${String(r.quarantineReason).slice(0, 90)}`);

console.log('\n--- total de modelos ---');
const total = db.prepare(`SELECT COUNT(*) AS c FROM Model`).get().c;
console.log('total:', total);