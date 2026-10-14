// Fill and region create/modify: report what EasyEDA stored, not the echo of
// what was sent, and name the requested values that did not stick (3.2.206
// stores fills solid with a 0.2 outline and drops region names).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBackPrimitive } from '../src/extension/handlers/read-back';

const store = (stored: any) => ({ get: async (id: string) => (id === stored.primitiveId ? stored : undefined) });

test('returns the stored primitive and lists the values EasyEDA ignored', async () => {
	const echo = { primitiveId: 'f1', fillMode: 1, lineWidth: 10, net: 'GND', layer: 2 };
	const stored = { primitiveId: 'f1', fillMode: 0, lineWidth: 0.2, net: 'GND', layer: 2 };
	const out = await readBackPrimitive(store(stored), echo, { layer: 2, net: 'GND', fillMode: 1, lineWidth: 10 });
	assert.equal(out.fillMode, 0);
	assert.equal(out.lineWidth, 0.2);
	assert.deepEqual(out.notApplied, ['fillMode', 'lineWidth']);
});

test('no notApplied when everything stuck; rule-type order does not matter; unset values are skipped', async () => {
	const stored = { primitiveId: 'r1', ruleType: [6, 7], layer: 1, lineWidth: 0.2 };
	const out = await readBackPrimitive(store(stored), { primitiveId: 'r1' }, { ruleType: [7, 6], layer: 1, regionName: undefined });
	assert.equal(out, stored);
	assert.equal('notApplied' in out, false);
});

test('falls back to what create returned when there is no id or the read fails', async () => {
	const made = { fillMode: 1 };
	assert.equal(await readBackPrimitive(store({ primitiveId: 'x' }), made, { fillMode: 1 }), made);
	const withId = { primitiveId: 'gone', fillMode: 1 };
	assert.equal(await readBackPrimitive(store({ primitiveId: 'x' }), withId, { fillMode: 1 }), withId);
	const throwing = { get: async () => { throw new Error('boom'); } };
	assert.equal(await readBackPrimitive(throwing, withId, { fillMode: 1 }), withId);
});

test('reads the id through getState_PrimitiveId when there is no primitiveId field', async () => {
	const stored = { primitiveId: 'f2', fillMode: 0 };
	const made = { getState_PrimitiveId: () => 'f2' };
	const out = await readBackPrimitive(store(stored), made, { fillMode: 2 });
	assert.deepEqual(out.notApplied, ['fillMode']);
});
