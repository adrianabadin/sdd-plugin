import assert from 'node:assert/strict';
import { parseNumericEdit, startNumericEdit, appendNumericEdit } from '../src/tui/model-detail-numeric-edit.js';

/**
 * SUPPLEMENTAL parser-level checks for the numeric edit buffer.
 *
 * These are NOT the proof of Ctrl+S behaviour. The primary proof lives in
 * tests/c9-ctrls-save.bun.test.ts, which drives the production registered
 * commands and asserts Save invocation counts and rendered state.
 */
console.log('--- C9 (supplemental): numeric buffer parser ---');

// Case 1: Valid active buffer (e.g. "88.5") parses cleanly for commit
const validSession = appendNumericEdit(appendNumericEdit(appendNumericEdit(startNumericEdit(null), '8'), '8'), '.');
const validSession2 = appendNumericEdit(validSession, '5');
const parsedValid = parseNumericEdit(validSession2);
assert.equal(parsedValid.ok, true);
assert.equal(parsedValid.value, 88.5);
console.log('  pass: Valid active numeric buffer parses for commit');

// Case 2: Incomplete/invalid active buffer (e.g. "12.") blocks commit
const invalidSession = appendNumericEdit(appendNumericEdit(appendNumericEdit(startNumericEdit(null), '1'), '2'), '.');
const parsedInvalid = parseNumericEdit(invalidSession);
assert.equal(parsedInvalid.ok, false);
assert.ok(parsedInvalid.error && parsedInvalid.error.length > 0);
console.log('  pass: Incomplete trailing decimal buffer correctly blocks commit');

console.log('Task C9 RED assertions complete.');
