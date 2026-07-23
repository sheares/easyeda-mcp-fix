import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequestQueue } from '../src/extension/request-queue';

// Helper: a queue backed by a local tail promise (simulates globalThis storage).
function makeQueue(slotTimeoutMs: number, opts?: { onForceRelease?: () => void }) {
	let tail: Promise<void> = Promise.resolve();
	return createRequestQueue({
		slotTimeoutMs,
		getTail: () => tail,
		setTail: (t) => {
			tail = t;
		},
		onForceRelease: opts?.onForceRelease,
	});
}

function later<T>(ms: number, value: T): Promise<T> {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test('tasks run serially in enqueue order', async () => {
	const q = makeQueue(1_000);
	const order: string[] = [];
	q.enqueue(async () => {
		await later(30, 0);
		order.push('A');
	});
	q.enqueue(async () => {
		order.push('B');
	});
	q.enqueue(async () => {
		order.push('C');
	});
	await later(150, 0);
	assert.deepEqual(order, ['A', 'B', 'C']);
});

test('a task that resolves normally does NOT see isForceReleased=true', async () => {
	const q = makeQueue(1_000);
	let seen: boolean | undefined;
	q.enqueue(async (isForceReleased) => {
		await later(10, 0);
		seen = isForceReleased();
	});
	await later(50, 0);
	assert.equal(seen, false);
});

test('a wedged task: force-release fires, next task runs, wedged task learns of it on completion', async () => {
	const forceLogs: string[] = [];
	const q = makeQueue(30, { onForceRelease: () => forceLogs.push('released') });

	let wedgedSawForceReleased: boolean | undefined;
	let wedgedResponseSent = false;
	let secondRan = false;

	// Task A: hangs for 200ms while the 30ms slot timeout will fire.
	q.enqueue(async (isForceReleased) => {
		await later(200, 0);
		wedgedSawForceReleased = isForceReleased();
		// The caller (ws-client) inspects this flag and drops any response.
		// We simulate that here: if the slot was released, do NOT sendResponse.
		if (!isForceReleased()) {
			wedgedResponseSent = true;
		}
	});
	// Task B: queued behind A; should be released early by the force-release.
	q.enqueue(async () => {
		secondRan = true;
	});

	// After 100 ms the slot has been force-released and task B has run.
	await later(100, 0);
	assert.deepEqual(forceLogs, ['released']);
	assert.equal(secondRan, true, 'second task should run after force-release');
	// Task A hasn't finished yet.
	assert.equal(wedgedSawForceReleased, undefined);
	assert.equal(wedgedResponseSent, false);

	// Let Task A complete.
	await later(150, 0);
	assert.equal(wedgedSawForceReleased, true, 'wedged task must see isForceReleased=true');
	assert.equal(wedgedResponseSent, false, 'wedged task must NOT emit a late response');
});

test('force-release fires exactly once even if the task later resolves', async () => {
	const forceLogs: string[] = [];
	const q = makeQueue(20, { onForceRelease: () => forceLogs.push('released') });
	q.enqueue(async () => {
		await later(100, 0);
	});
	q.enqueue(async () => {
		// This one is fast, should not trigger another force-release.
	});
	await later(200, 0);
	assert.deepEqual(forceLogs, ['released']);
});

test('a task that throws does not stall the queue', async () => {
	const q = makeQueue(1_000);
	const order: string[] = [];
	q.enqueue(async () => {
		order.push('A');
		throw new Error('boom');
	});
	q.enqueue(async () => {
		order.push('B');
	});
	await later(50, 0);
	assert.deepEqual(order, ['A', 'B']);
});
