import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, BridgeUserError } from '../src/extension/diag';

test('describeError appends cause and own properties for "[object Object]" errors', () => {
	const err: any = new Error({ code: 42, reason: 'bad layer' } as any);
	assert.equal(err.message, '[object Object]');
	err.cause = { code: 42, reason: 'bad layer' };
	err.detailField = 'xyz';
	const out = describeError(err);
	assert.match(out, /bad layer/);
	assert.match(out, /detailField/);
});

test('describeError handles an empty message without detail', () => {
	assert.match(describeError(new Error('')), /no cause or extra properties/);
});

test('describeError caps the detail size', () => {
	const err: any = new Error('[object Object]');
	err.cause = { blob: 'x'.repeat(10000) };
	assert.ok(describeError(err).length < 6000);
});

test('describeError leaves ordinary errors alone', () => {
	const out = describeError(new Error('plain'));
	assert.ok(!out.includes('detail:'));
	assert.equal(describeError(new BridgeUserError('nope')), 'nope');
});
