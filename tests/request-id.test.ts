import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequestIdGenerator } from '../src/bridge-daemon/request-id';

test('generator produces d<nonce>-<n> with monotonically increasing n', () => {
	const next = createRequestIdGenerator('abc123');
	assert.equal(next(), 'dabc123-1');
	assert.equal(next(), 'dabc123-2');
	assert.equal(next(), 'dabc123-3');
});

test('two runs with different nonces produce disjoint id spaces', () => {
	// This is the failure mode WP2 fixes: without the nonce, the counter
	// resets to 0 every daemon run, so a stale "d5" from run A buffered by
	// the extension could alias the fresh "d5" of run B and be accepted as
	// its answer. With the nonce, ids from different runs never collide.
	const runA = createRequestIdGenerator('aaaaaa');
	const runB = createRequestIdGenerator('bbbbbb');

	const idsA = new Set<string>();
	const idsB = new Set<string>();
	for (let i = 0; i < 100; i++) {
		idsA.add(runA());
		idsB.add(runB());
	}
	for (const id of idsA) {
		assert.ok(!idsB.has(id), `id ${id} collided between runs`);
	}
});

test('same nonce is reproducible (for pinning in tests)', () => {
	const a1 = createRequestIdGenerator('same');
	const a2 = createRequestIdGenerator('same');
	assert.equal(a1(), a2());
	assert.equal(a1(), a2());
});
