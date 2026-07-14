import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { matchesFilter } from '../src/extension/handlers/component-match';

test('exact match on a string field', () => {
	assert.equal(matchesFilter({ supplierId: 'C25804' }, { supplierId: 'C25804' }), true);
	assert.equal(matchesFilter({ supplierId: 'C25804' }, { supplierId: 'C14663' }), false);
});

test('AND across multiple conditions', () => {
	const item = { designator: 'R1', supplierId: 'C25804', manufacturer: 'YAGEO' };
	assert.equal(matchesFilter(item, { supplierId: 'C25804', manufacturer: 'YAGEO' }), true);
	assert.equal(matchesFilter(item, { supplierId: 'C25804', manufacturer: 'Rohm' }), false);
});

test('OR array: value must be one of the options', () => {
	assert.equal(matchesFilter({ supplierId: 'C25804' }, { supplierId: ['C25804', 'C14663'] }), true);
	assert.equal(matchesFilter({ supplierId: 'C99999' }, { supplierId: ['C25804', 'C14663'] }), false);
});

test('prefix glob on designator', () => {
	assert.equal(matchesFilter({ designator: 'R11' }, { designator: 'R*' }), true);
	assert.equal(matchesFilter({ designator: 'C1' }, { designator: 'R*' }), false);
	assert.equal(matchesFilter({ designator: 'R' }, { designator: 'R*' }), true);
});

test('prefix glob rejects non-string field values', () => {
	assert.equal(matchesFilter({ designator: 42 }, { designator: 'R*' }), false);
	assert.equal(matchesFilter({ designator: null }, { designator: 'R*' }), false);
});

test('missing field never matches (unless condition is undefined)', () => {
	assert.equal(matchesFilter({}, { supplierId: 'C25804' }), false);
	assert.equal(matchesFilter({}, { supplierId: ['C25804'] }), false);
});

test('empty filter passes everything', () => {
	assert.equal(matchesFilter({ anything: 1 }, {}), true);
	assert.equal(matchesFilter({}, {}), true);
});

test('safe on null/undefined item', () => {
	assert.equal(matchesFilter(null, { x: 1 }), false);
	assert.equal(matchesFilter(undefined, { x: 1 }), false);
	assert.equal(matchesFilter(null, {}), true);
});
