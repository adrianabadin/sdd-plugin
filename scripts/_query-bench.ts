import { resolveDatabasePath, initializeDatabase } from '../src/infrastructure/runtime/database-path.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const dbPath = resolveDatabasePath();
console.log('DB PATH:', dbPath);
initializeDatabase({ projectDbPath: dbPath });
const db = new DatabaseSync(dbPath);

const rows = db.prepare(`
  SELECT m.id AS modelId, m.name AS modelName, m.mmlu, m.humaneval, m.sweBench, m.gpqa, m.math, m.bbh, m.mtBench, m.multineedle,
         m.quarantineType, p.id AS providerId
  FROM Model m
  LEFT JOIN ModelProvider mp ON mp.modelId = m.id
  LEFT JOIN Provider p ON p.id = mp.providerId
  ORDER BY m.id
`).all();

for (const r of rows) {
  const b = [r.mmlu, r.humaneval, r.sweBench, r.gpqa, r.math, r.bbh, r.mtBench, r.multineedle];
  console.log([r.modelId, r.modelName, r.providerId ?? '-', r.quarantineType ?? 'active'].join(' | ') + ' :: ' + b.map((v) => (v ?? 'NULL')).join(','));
}
console.log('TOTAL', rows.length);