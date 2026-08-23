import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateOversizedResult, OVERSIZED_RESULT_BYTES } from '../src/bridge-daemon/registry';

const small = { content: [{ type: 'text' as const, text: '{"ok":true}' }] };
const big = { content: [{ type: 'text' as const, text: 'x'.repeat(OVERSIZED_RESULT_BYTES + 1) }] };

test('small results pass through untouched (same object)', () => {
	assert.equal(annotateOversizedResult('pcb_get_all_nets', {}, small), small);
});

test('oversized results keep the first block byte-identical and append one note block', () => {
	const out = annotateOversizedResult('pcb_get_all_primitives', {}, big);
	assert.notEqual(out, big);
	assert.equal(out.content.length, 2);
	assert.equal(out.content[0], big.content[0]);
	const note = out.content[1] as { type: string; text: string };
	assert.equal(note.type, 'text');
	assert.match(note.text, /pcb_get_all_primitives returned about 100 KB/);
	assert.match(note.text, /fields, filter or limit/);
});

test('the hint changes when the caller already narrowed the call', () => {
	const out = annotateOversizedResult('pcb_get_all_primitives', { fields: ['primitiveId'] }, big);
	const note = out.content[1] as { type: string; text: string };
	assert.match(note.text, /already narrowed/);
});

test('non-text blocks are not counted and malformed results are left alone', () => {
	const image = { content: [{ type: 'image' as const, data: 'y'.repeat(OVERSIZED_RESULT_BYTES * 2), mimeType: 'image/png' }] };
	assert.equal(annotateOversizedResult('x', {}, image), image);
	const malformed = { content: undefined as any };
	assert.equal(annotateOversizedResult('x', {}, malformed), malformed);
});
