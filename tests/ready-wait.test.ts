import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeReadyWait, waitUntilReady, type ReadyBreaker } from '../src/extension/ready-wait';

// A fake clock so the guard timer is deterministic: scheduled callbacks run
// only when the test fires them.
function fakeTimers() {
	let t = 0;
	const pending: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
	return {
		now: () => t,
		schedule: (fn: () => void, ms: number) => {
			const h = { fn, at: t + ms, cancelled: false };
			pending.push(h);
			return h;
		},
		cancel: (h: unknown) => {
			(h as { cancelled: boolean }).cancelled = true;
		},
		advance(ms: number) {
			t += ms;
			for (const h of pending) if (!h.cancelled && h.at <= t) h.fn();
		},
		live: () => pending.filter((h) => !h.cancelled).length,
	};
}

test('waitUntilReady reports unsupported when the runtime lacks the API', async () => {
	const r = await waitUntilReady(undefined, { guardMs: 1000 });
	assert.equal(r.outcome, 'unsupported');
	assert.equal(describeReadyWait('document x', r), null);
});

test('waitUntilReady maps true and false to ready and not-ready', async () => {
	const clock = fakeTimers();
	const opts = { guardMs: 1000, now: clock.now, schedule: clock.schedule, cancel: clock.cancel };
	assert.equal((await waitUntilReady(async () => true, opts)).outcome, 'ready');
	assert.equal((await waitUntilReady(async () => false, opts)).outcome, 'not-ready');
	assert.equal(clock.live(), 0, 'guard timers are cancelled once the wait settles');
});

test('waitUntilReady treats an undefined answer as unsupported, with detail', async () => {
	const r = await waitUntilReady(async () => undefined, { guardMs: 1000 });
	assert.equal(r.outcome, 'unsupported');
	assert.equal(r.detail, 'returned undefined');
	assert.match(describeReadyWait('project', r) ?? '', /unsupported .*returned undefined/);
});

test('waitUntilReady never rejects: a throwing or rejecting call is reported as error', async () => {
	const thrown = await waitUntilReady(() => { throw new Error('boom'); }, { guardMs: 1000 });
	assert.equal(thrown.outcome, 'error');
	assert.equal(thrown.detail, 'boom');
	const rejected = await waitUntilReady(() => Promise.reject('nope'), { guardMs: 1000 });
	assert.equal(rejected.outcome, 'error');
	assert.equal(rejected.detail, 'nope');
});

test('a wait that never settles hits the guard and trips the breaker', async () => {
	const clock = fakeTimers();
	const breaker: ReadyBreaker = { tripped: false };
	const opts = { guardMs: 8000, breaker, now: clock.now, schedule: clock.schedule, cancel: clock.cancel };
	let calls = 0;
	const never = () => { calls += 1; return new Promise<boolean>(() => {}); };

	const pending = waitUntilReady(never, opts);
	await Promise.resolve();
	clock.advance(8000);
	const r = await pending;
	assert.equal(r.outcome, 'timeout');
	assert.equal(r.elapsedMs, 8000);
	assert.equal(breaker.tripped, true);
	assert.match(describeReadyWait('document p1', r) ?? '', /timeout after 8000 ms; further waits/);

	// The next wait is skipped outright, so a page walk does not stall per page.
	const skipped = await waitUntilReady(never, opts);
	assert.equal(skipped.outcome, 'disabled');
	assert.equal(calls, 1);
	assert.equal(describeReadyWait('document p2', skipped), null);
});

test('describeReadyWait stays quiet for a fast ready and logs a slow one', () => {
	assert.equal(describeReadyWait('document a', { outcome: 'ready', elapsedMs: 12 }), null);
	assert.equal(
		describeReadyWait('document a', { outcome: 'ready', elapsedMs: 1800 }),
		'ready-wait document a: ready after 1800 ms',
	);
	assert.match(describeReadyWait('project', { outcome: 'not-ready', elapsedMs: 6000 }) ?? '', /not-ready after 6000 ms/);
});
