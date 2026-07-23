import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { matchesFilter } from '../src/extension/handlers/component-match';
import { resolveTemplateExpressions } from '../src/extension/handlers/sch-netlist-utils';

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

// Q9: sch_swap_supplier_part matches against RESOLVED template values. These
// pin the intended semantics: the raw stored `={...}` value does not match
// its resolved text; resolving on a shallow copy makes it match while the
// raw object (which the write path uses) stays untouched.
test('template semantics: raw ={...} value does not match its resolved text', () => {
	const raw = { designator: 'U3', manufacturerId: '={Manufacturer Part}' };
	assert.equal(matchesFilter(raw, { manufacturerId: 'MP1584EN' }), false);
	// The literal template string itself does still match, for callers who
	// deliberately target the stored value.
	assert.equal(matchesFilter(raw, { manufacturerId: '={Manufacturer Part}' }), true);
});

test('template semantics: matching a resolved copy works and leaves the raw object untouched', () => {
	const props = { 'Manufacturer Part': 'MP1584EN' };
	const raw: Record<string, any> = { designator: 'U3', manufacturerId: '={Manufacturer Part}' };
	const view: Record<string, any> = { ...raw };
	for (const key of Object.keys(view)) {
		if (typeof view[key] === 'string' && view[key].includes('={')) {
			view[key] = resolveTemplateExpressions(view[key], props);
		}
	}
	assert.equal(matchesFilter(view, { manufacturerId: 'MP1584EN' }), true);
	assert.equal(matchesFilter(view, { manufacturerId: 'MP1584*' }), true);
	assert.equal(raw.manufacturerId, '={Manufacturer Part}', 'raw stored value must not be mutated');
});

test('template semantics: unknown property resolves to the original template text', () => {
	assert.equal(resolveTemplateExpressions('={Nope}', {}), '={Nope}');
	assert.equal(resolveTemplateExpressions('={A} / ={B}', { A: 'x' }), 'x / ={B}');
});
