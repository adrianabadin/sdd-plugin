import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_DDL } from '../src/infrastructure/runtime/schema-ddl.js';

console.log('--- PR2 RED: Schema DDL Drift Test ---');

const migrationPath = path.resolve('prisma/migrations/20260721000000_init/migration.sql');
assert.ok(fs.existsSync(migrationPath), 'Migration SQL file must exist at exact path prisma/migrations/20260721000000_init/migration.sql');

const migrationContent = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n').trim();
assert.equal(SCHEMA_DDL.trim(), migrationContent, 'Bundled SCHEMA_DDL must match exact migration.sql content');

console.log('  pass: SCHEMA_DDL matches exact migration.sql content');
