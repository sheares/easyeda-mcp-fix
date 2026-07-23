// D4: mapWithConcurrency backs the connectivity pin sweep. Pins: order
// preservation, the concurrency ceiling, whole-call rejection on item
// failure, and edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../src/extension/handlers/concurrency';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

test('results preserve input order regardless of completion order', async () => {
	const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
	const p = mapWithConcurrency([0, 1, 2], 3, async (i) => {
		await gates[i].promise;
		return `item-${i}`;
	});
	// Complete in reverse order.
	gates[2].resolve();
	gates[1].resolve();
	gates[0].resolve();
	assert.deepEqual(await p, ['item-0', 'item-1', 'item-2']);
});

test('never exceeds the concurrency limit', async () => {
	let inFlight = 0;
	let peak = 0;
	const items = Array.from({ length: 40 }, (_, i) => i);
	const doubled = await mapWithConcurrency(items, 5, async (i) => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise((r) => setTimeout(r, 1 + (i % 3)));
		inFlight--;
		return i * 2;
	});
	assert.equal(peak <= 5, true, `peak concurrency ${peak} exceeded limit 5`);
	assert.equal(peak >= 2, true, 'work should actually run concurrently');
	assert.deepEqual(doubled, items.map((i) => i * 2));
});

test('a rejecting item rejects the whole call', async () => {
	await assert.rejects(
		() => mapWithConcurrency([1, 2, 3], 2, async (i) => {
			if (i === 2) throw new Error('pin fetch failed');
			return i;
		}),
		/pin fetch failed/,
	);
});

test('empty input resolves to an empty array without calling fn', async () => {
	let called = 0;
	const out = await mapWithConcurrency([], 4, async () => { called++; return 1; });
	assert.deepEqual(out, []);
	assert.equal(called, 0);
});

test('limit larger than the input is fine; invalid limit throws', async () => {
	assert.deepEqual(await mapWithConcurrency([1, 2], 100, async (i) => i), [1, 2]);
	await assert.rejects(() => mapWithConcurrency([1], 0, async (i) => i), /positive integer/);
});
