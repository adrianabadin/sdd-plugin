import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDatabasePath } from '../src/infrastructure/runtime/database-path.js';

console.log('--- Shared Database Path Resolver Test ---');

// RED phase test
const resolved = resolveDatabasePath();
assert.equal(typeof resolved, 'string');
assert.ok(resolved.endsWith('opencode-models.db'));
assert.ok(path.isAbsolute(resolved));
console.log('  pass: resolveDatabasePath returns valid absolute path');
