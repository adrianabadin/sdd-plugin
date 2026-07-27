import assert from 'node:assert/strict';
import { normalizePersistenceError } from '../src/infrastructure/prisma/error-normalization.js';

console.log('--- Task 2: Persistence Error Normalization Test ---');

// Test 1: Standard Error object returns normalized error with stack and cause
const causeErr = new Error('SQLITE_ERROR: no such table: main.ModelProvider');
const origErr = new Error('DriverAdapterError: Failed to run query');
(origErr as any).cause = causeErr;

const norm1 = normalizePersistenceError(origErr);
assert.equal(norm1.message, 'DriverAdapterError: Failed to run query (Cause: SQLITE_ERROR: no such table: main.ModelProvider)');
assert.ok(norm1.stack?.includes('DriverAdapterError'));
assert.equal((norm1 as any).cause, causeErr);
console.log('  pass: Standard Error object with cause normalized preserving stack and cause');

// Test 2: Non-Error string or object (e.g. Bun DriverAdapter raw string/object)
const norm2 = normalizePersistenceError('SQLITE_ERROR: raw string error');
assert.equal(norm2.message, 'SQLITE_ERROR: raw string error');
assert.ok(norm2.stack?.length! > 0);
console.log('  pass: Raw string error converted to Error with stack');

// Test 3: Object with message property
const norm3 = normalizePersistenceError({ message: 'Custom object error', code: 500 });
assert.equal(norm3.message, 'Custom object error');
assert.ok(norm3.stack?.length! > 0);
console.log('  pass: Custom object error converted preserving message');

console.log('All error normalization assertions passed!');
