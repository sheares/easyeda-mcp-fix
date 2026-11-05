import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answersWithin, probeOnce, type ProbeOutcome } from '../src/extension/host-probe';
import { LocalJobStore, describeResult, LOCAL_JOB_PREFIX, NO_ANSWER_MS } from '../src/extension/handlers/auto-job-local';
import { waitUntilReady, describeReadyWait, type ReadyBreaker } from '../src/extension/ready-wait';
import { versionedShared } from '../src/extension/shared-state';

function manualTimers() {
	const pending: Array<{ fn: () => void; cancelled: boolean }> = [];
	return {
		schedule: (fn: () => void) => {
			const h = { fn, cancelled: false };
			pending.push(h);
			return h;
		},
		cancel: (h: unknown) => { (h as { cancelled: boolean }).cancelled = true; },
		fire() { for (const h of pending) if (!h.cancelled) h.fn(); },
		live: () => pending.filter((h) => !h.cancelled).length,
	};
}

const never = () => new Promise<unknown>(() => {});
const tick = () => new Promise((r) => setImmediate(r));

test('answersWithin: an answer, a rejection and silence', async () => {
	const t = manualTimers();
	assert.deepEqual(await answersWithin(async () => null, 1000, t), { answered: true });
	assert.deepEqual(await answersWithin(() => Promise.reject(new Error('bad id')), 1000, t), { answered: true, rejected: 'bad id' });
	assert.equal(t.live(), 0, 'guards are cancelled once the call settles');
	const silent = answersWithin(never, 1000, t);
	await tick();
	t.fire();
	assert.deepEqual(await silent, { answered: false });
});

test('answersWithin: a call that throws synchronously still counts as an answer', async () => {
	const r = await answersWithin(() => { throw new Error('sync'); }, 1000, manualTimers());
	assert.deepEqual(r, { answered: true, rejected: 'sync' });
});

test('probeOnce asks the host once per key and shares the answer', async () => {
	const cache = new Map<string, Promise<ProbeOutcome>>();
	let calls = 0;
	const call = async () => { calls += 1; return 'ok'; };
	const [a, b] = await Promise.all([probeOnce(cache, 'k', call, 1000), probeOnce(cache, 'k', call, 1000)]);
	assert.equal(calls, 1);
	assert.deepEqual(a, b);
	await probeOnce(cache, 'other', call, 1000);
	assert.equal(calls, 2);
});

test('ready-wait: a silent host fails the probe once, then the kind is off without another wait', async () => {
	const t = manualTimers();
	const breaker: ReadyBreaker = { tripped: false };
	let waits = 0;
	const call = async () => { waits += 1; return true; };
	const first = waitUntilReady(call, { guardMs: 8000, probe: never, probeMs: 1500, breaker, schedule: t.schedule, cancel: t.cancel });
	await tick();
	t.fire();
	const r = await first;
	assert.equal(r.outcome, 'unsupported');
	assert.match(r.detail ?? '', /did not answer the ready-state probe within 1500 ms/);
	assert.match(describeReadyWait('document x', r) ?? '', /skipped until EasyEDA restarts/);
	assert.equal(waits, 0, 'the wait itself is never called on a silent host');
	assert.equal(breaker.tripped, true);
	assert.equal((await waitUntilReady(call, { guardMs: 8000, probe: never, breaker })).outcome, 'disabled');
});

test('ready-wait: a host that answers the probe goes on to the real wait, and is probed only once', async () => {
	const breaker: ReadyBreaker = { tripped: false };
	let probes = 0;
	const probe = async () => { probes += 1; return 'ready'; };
	assert.equal((await waitUntilReady(async () => true, { guardMs: 8000, probe, breaker })).outcome, 'ready');
	assert.equal((await waitUntilReady(async () => false, { guardMs: 8000, probe, breaker })).outcome, 'not-ready');
	assert.equal(probes, 1);
	assert.equal(breaker.hostAnswers, true);
});

test('local job: runs in the background, then reports EasyEDA\'s routing result', async () => {
	let now = 1_000_000;
	const store = new LocalJobStore(() => now);
	let finish!: (v: unknown) => void;
	const { jobId } = store.start('routing', () => new Promise((r) => { finish = r; }), 'Autorouting started');
	assert.ok(jobId.startsWith(LOCAL_JOB_PREFIX));
	assert.ok(store.isLocal(jobId));
	assert.equal(store.isLocal('a1b2c3'), false);

	const running = store.status(jobId)!;
	assert.equal(running.state, 'running');
	assert.equal(running.progress, null);
	assert.equal(running.emulated, true);
	assert.equal(running.partial, false);

	now += 42_000;
	finish({ success: true, totalNetsCount: 40, successNetsCount: 38, failedNets: ['USB_DP', 'USB_DN'], duration: 41_500 });
	await tick();
	const done = store.status(jobId)!;
	assert.equal(done.state, 'completed');
	assert.equal(done.progress, 100);
	assert.equal(done.elapsedMs, 42_000);
	assert.deepEqual((done.result as any).failedNets, ['USB_DP', 'USB_DN']);
	const log = store.log(jobId)!;
	assert.equal(log.length, 2);
	assert.equal(log[1].level, 'warn');
	assert.match(log[1].message, /38 of 40 nets routed in 42 s; not routed: USB_DP, USB_DN/);
});

test('local job: success false and a rejection both end as failed, with a code', async () => {
	const store = new LocalJobStore();
	const a = store.start('routing', async () => ({ success: false }), 'start');
	const b = store.start('layout', () => Promise.reject(new Error('no board outline')), 'start');
	const c = store.start('routing', () => { throw new Error('sync throw'); }, 'start');
	await tick();
	assert.equal(store.status(a.jobId)!.state, 'failed');
	assert.equal(store.status(a.jobId)!.error!.code, 'NOT_STARTED');
	assert.equal(store.status(b.jobId)!.error!.code, 'EASYEDA_ERROR');
	assert.equal(store.status(b.jobId)!.error!.message, 'no board outline');
	assert.equal(store.status(c.jobId)!.error!.message, 'sync throw');
	assert.notEqual(a.jobId, c.jobId, 'job ids are unique even within one millisecond');
});

test('local job: a blocking call that never answers is called hung after the ceiling, and a late answer is ignored', async () => {
	let now = 0;
	const store = new LocalJobStore(() => now);
	let finish!: (v: unknown) => void;
	const { jobId } = store.start('routing', () => new Promise((r) => { finish = r; }), 'start');
	now = NO_ANSWER_MS - 1;
	assert.equal(store.status(jobId)!.state, 'running');
	now = NO_ANSWER_MS;
	const hung = store.status(jobId)!;
	assert.equal(hung.state, 'failed');
	assert.equal(hung.error!.code, 'NO_ANSWER');
	finish({ success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 1 });
	await tick();
	assert.equal(store.status(jobId)!.state, 'failed', 'the verdict does not flip after it is reported');
});

test('local job: unknown ids read as undefined', () => {
	const store = new LocalJobStore();
	assert.equal(store.status(`${LOCAL_JOB_PREFIX}routing-x-1`), undefined);
	assert.equal(store.log(`${LOCAL_JOB_PREFIX}routing-x-1`), undefined);
});

test('describeResult summarises layout results', () => {
	assert.deepEqual(describeResult('layout', { success: true, totalComponentsCount: 70, successComponentsCount: 70, failedComponents: [], duration: 9000 }), { level: 'info', failed: false, message: '70 of 70 components placed' });
	assert.equal(describeResult('layout', { success: true, totalComponentsCount: 70, successComponentsCount: 68, failedComponents: ['a', 'b'] }).level, 'warn');
	assert.equal(describeResult('routing', undefined).message, 'finished');
});

test('versionedShared: the same version shares, a different or missing stamp rebuilds', () => {
	const store: Record<string, unknown> = {};
	let made = 0;
	const make = () => ({ n: ++made });
	const a = versionedShared(store, 'k', '1.7.3', make);
	assert.equal(versionedShared(store, 'k', '1.7.3', make), a, 'a re-evaluated module of the same version sees the same object');
	const b = versionedShared(store, 'k', '1.7.4', make);
	assert.notEqual(b, a, 'an upgrade starts fresh');
	assert.equal(made, 2);
	store.raw = { tripped: true };
	assert.deepEqual(versionedShared(store, 'raw', '1.7.3', () => ({ tripped: false })), { tripped: false }, 'an unstamped value from an older extension is replaced');
	store.nul = null;
	assert.deepEqual(versionedShared(store, 'nul', '1.7.3', () => 'x'), 'x');
});

test('ready-wait after an upgrade in the same window: the old tripped breaker no longer stops the probe', async () => {
	// What 1.7.0 to 1.7.2 left on globalThis: a bare, tripped breaker.
	const store: Record<string, unknown> = { __easyedaMcpDocReadyBreaker: { tripped: true } };
	const breaker = versionedShared<ReadyBreaker>(store, '__easyedaMcpDocReadyBreaker', '1.7.3', () => ({ tripped: false }));
	let probes = 0;
	const r = await waitUntilReady(async () => true, { guardMs: 8000, probe: async () => { probes += 1; return 'ready'; }, breaker });
	assert.equal(r.outcome, 'ready');
	assert.equal(probes, 1);
});
