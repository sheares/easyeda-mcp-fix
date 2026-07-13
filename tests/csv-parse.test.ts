import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseCsv, csvToRows } from '../src/extension/handlers/csv';

test('parseCsv parses simple rows', () => {
	assert.deepEqual(parseCsv('a,b,c\n1,2,3'), [
		['a', 'b', 'c'],
		['1', '2', '3'],
	]);
});

test('parseCsv handles quoted fields containing commas', () => {
	assert.deepEqual(parseCsv('name,desc\nR1,"10k, 1%"'), [
		['name', 'desc'],
		['R1', '10k, 1%'],
	]);
});

test('parseCsv handles escaped double quotes', () => {
	assert.deepEqual(parseCsv('a\n"say ""hi"""'), [['a'], ['say "hi"']]);
});

test('parseCsv handles newlines inside quoted fields', () => {
	assert.deepEqual(parseCsv('a,b\n"line1\nline2",x'), [
		['a', 'b'],
		['line1\nline2', 'x'],
	]);
});

test('parseCsv handles CRLF line endings', () => {
	assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
		['a', 'b'],
		['1', '2'],
	]);
});

test('parseCsv strips a leading BOM character', () => {
	assert.deepEqual(parseCsv('\uFEFFa,b\n1,2'), [
		['a', 'b'],
		['1', '2'],
	]);
});

test('parseCsv ignores a trailing newline (no phantom row)', () => {
	assert.deepEqual(parseCsv('a,b\n1,2\n'), [
		['a', 'b'],
		['1', '2'],
	]);
});

test('parseCsv returns [] for empty input', () => {
	assert.deepEqual(parseCsv(''), []);
});

test('csvToRows maps rows by header', () => {
	assert.deepEqual(csvToRows('Designator,Quantity,Supplier Part\nR1,1,C25804\nC1,2,C1525'), [
		{ Designator: 'R1', Quantity: '1', 'Supplier Part': 'C25804' },
		{ Designator: 'C1', Quantity: '2', 'Supplier Part': 'C1525' },
	]);
});

test('csvToRows fills missing trailing cells with empty strings', () => {
	assert.deepEqual(csvToRows('a,b,c\n1,2'), [{ a: '1', b: '2', c: '' }]);
});

test('csvToRows returns [] for empty input and header-only input', () => {
	assert.deepEqual(csvToRows(''), []);
	assert.deepEqual(csvToRows('a,b,c\n'), []);
});
