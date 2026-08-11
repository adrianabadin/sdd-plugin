import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite');
const db = new DatabaseSync('C:/Users/aabad/AppData/Local/sdd-plugin/opencode-models.db', { readOnly: true });

const cols = ['mmlu', 'humaneval', 'sweBench', 'gpqa', 'math', 'bbh', 'mtBench', 'multineedle'];
const rows = db.prepare(`SELECT id, ${cols.join(', ')} FROM Model WHERE quarantineType IS NULL ORDER BY id`).all();
console.log(`${rows.length} modelos activos (sin quarantine)`);
for (const r of rows) {
  const vals = cols.map(c => (r[c] === null ? '-'.padEnd(5) : String(r[c]).padEnd(5))).join(' | ');
  console.log(`${r.id.padEnd(36)} ${vals}`);
}
const total = db.prepare(`SELECT COUNT(*) AS c FROM Model`).get().c;
const perm = db.prepare(`SELECT COUNT(*) AS c FROM Model WHERE quarantineType='permanent'`).get().c;
console.log(`total: ${total} | permanent: ${perm} | active: ${rows.length}`);