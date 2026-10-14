// pcb.pour.rebuild: per-pour instance method first, collection call as the
// fallback, ids and counts only in the result.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pourFillHandlers } from '../src/extension/handlers/pour-fill';

const g = globalThis as any;

function pour(id: string, rebuild?: () => Promise<unknown>) {
	const p: any = { getState_PrimitiveId: () => id };
	if (rebuild) p.rebuildCopperRegion = rebuild;
	return p;
}

let collectionCalls: Array<string[] | undefined>;
let pours: any[];
let collectionImpl: ((ids?: string[]) => Promise<unknown[]>) | undefined;

beforeEach(() => {
	collectionCalls = [];
	collectionImpl = undefined;
	pours = [];
	g.eda = {
		pcb_PrimitivePour: {
			getAll: async () => pours,
			get: async (ids: string[]) => pours.filter((p) => ids.includes(p.getState_PrimitiveId())),
			get rebuildCopperRegions() {
				return collectionImpl
					? async (ids?: string[]) => {
							collectionCalls.push(ids);
							return collectionImpl!(ids);
						}
					: undefined;
			},
		},
	};
});

test('rebuilds every pour via the instance method and reports ids and counts only', async () => {
	pours = [pour('a', async () => ({ geometry: 'big' })), pour('b', async () => ({ geometry: 'big' }))];
	const result = await pourFillHandlers['pcb.pour.rebuild']({});
	assert.deepEqual(result, { method: 'rebuildCopperRegion', rebuilt: ['a', 'b'], failed: [], pouredCount: 2 });
});

test('primitiveIds limits the pours rebuilt; per-pour failures are collected with a reason', async () => {
	pours = [
		pour('a', async () => ({})),
		pour('b', async () => {
			throw new Error('internal error');
		}),
		pour('c', async () => undefined),
	];
	collectionImpl = undefined;
	const result: any = await pourFillHandlers['pcb.pour.rebuild']({ primitiveIds: ['a', 'b'] });
	assert.equal(result.method, 'rebuildCopperRegion');
	assert.deepEqual(result.rebuilt, ['a']);
	assert.equal(result.failed.length, 1);
	assert.equal(result.failed[0].id, 'b');
	assert.match(result.failed[0].reason, /internal error/);
	assert.equal(result.pouredCount, 1);
});

test('falls back to rebuildCopperRegions when the instance method is missing', async () => {
	pours = [pour('a'), pour('b')];
	collectionImpl = async () => [{}, {}];
	const result: any = await pourFillHandlers['pcb.pour.rebuild']({ primitiveIds: ['a', 'b'] });
	assert.equal(result.method, 'rebuildCopperRegions');
	assert.deepEqual(result.rebuilt, ['a', 'b']);
	assert.equal(result.pouredCount, 2);
	assert.deepEqual(collectionCalls, [['a', 'b']]);
});

test('falls back when every per-pour call failed', async () => {
	pours = [
		pour('a', async () => {
			throw new Error('nope');
		}),
	];
	collectionImpl = async () => [{}];
	const result: any = await pourFillHandlers['pcb.pour.rebuild']({});
	assert.equal(result.method, 'rebuildCopperRegions');
	assert.deepEqual(result.rebuilt, ['a']);
	assert.deepEqual(collectionCalls, [undefined]);
});

test('reports failures when the fallback is absent or throws', async () => {
	pours = [
		pour('a', async () => {
			throw new Error('nope');
		}),
	];
	let result: any = await pourFillHandlers['pcb.pour.rebuild']({});
	assert.deepEqual(result.rebuilt, []);
	assert.equal(result.failed[0].id, 'a');

	collectionImpl = async () => {
		throw new Error('alpha broke');
	};
	result = await pourFillHandlers['pcb.pour.rebuild']({});
	assert.equal(result.failed.length, 2);
	assert.match(result.failed[1].reason, /alpha broke/);
	assert.match(result.note, /Shift\+B/);
});

test('a failure inside EasyEDA is reported by its first line, with no note when something was rebuilt', async () => {
	const inside = new TypeError("Cannot read properties of undefined (reading 'length')");
	inside.stack = `${inside.name}: ${inside.message}\n    at C3 (https://modules.lceda.cn/pro-api/api.js:38:75929)`;
	pours = [pour('a', async () => { throw inside; })];
	let result: any = await pourFillHandlers['pcb.pour.rebuild']({});
	assert.equal(result.failed[0].reason.includes('\n'), false);
	assert.match(result.failed[0].reason, /reading 'length'/);
	assert.match(result.note, /Shift\+B/);

	pours = [pour('a', async () => { throw inside; }), pour('b', async () => ({}))];
	result = await pourFillHandlers['pcb.pour.rebuild']({});
	assert.deepEqual(result.rebuilt, ['b']);
	assert.equal('note' in result, false);
});

test('no pours gives an empty result', async () => {
	const result: any = await pourFillHandlers['pcb.pour.rebuild']({});
	assert.deepEqual(result, { method: 'none', rebuilt: [], failed: [], pouredCount: 0 });
});
