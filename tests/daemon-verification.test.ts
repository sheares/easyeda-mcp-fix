import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowsRequests, createVerificationGate } from '../src/extension/daemon-verification';

// Manual timer so the timeout path is deterministic.
function manualTimers() {
	const pending: Array<{ fn: () => void; ms: number }> = [];
	return {
		schedule: (fn: () => void, ms: number) => {
			const h = { fn, ms };
			pending.push(h);
			return h;
		},
		cancel: (h: unknown) => {
			const i = pending.indexOf(h as any);
			if (i !== -1) pending.splice(i, 1);
		},
		fire: () => {
			const all = pending.splice(0);
			for (const p of all) p.fn();
		},
		count: () => pending.length,
	};
}

function makeGate(timers = manualTimers()) {
	const reasons: string[] = [];
	const gate = createVerificationGate({
		timeoutMs: 5000,
		onUnverified: (r) => reasons.push(r),
		schedule: timers.schedule,
		cancel: timers.cancel,
	});
	return { gate, reasons, timers };
}

test('happy path: challenge, hmac answer, good auth.ok → verified, no warning', async () => {
	const { gate, reasons, timers } = makeGate();
	assert.equal(gate.state(), 'idle');
	gate.challengeReceived();
	assert.equal(gate.state(), 'pending');
	const v = gate.verdict(); // a request arrives while pending: must wait
	assert.equal(timers.count(), 1, 'timeout armed at the challenge');
	gate.authOkChecked(true);
	assert.equal(await v, 'verified');
	assert.equal(timers.count(), 0, 'timer cancelled on settlement');
	assert.deepEqual(reasons, []);
	assert.equal(allowsRequests(gate.state()), true);
});

test('absent auth.ok (or a hung token read): timer expiry settles unverified and warns once', async () => {
	const { gate, reasons, timers } = makeGate();
	gate.challengeReceived();
	const v = gate.verdict();
	timers.fire();
	assert.equal(await v, 'unverified');
	assert.equal(reasons.length, 1);
	assert.match(reasons[0], /did not complete within 5000ms/);
	assert.equal(allowsRequests(gate.state()), false);
});

test('a MAC-verified auth.ok after the timeout upgrades to verified and reports the earlier reason', async () => {
	const late: Array<string | null> = [];
	const timers = manualTimers();
	const gate = createVerificationGate({
		timeoutMs: 5000,
		onVerifiedLate: (r) => late.push(r),
		schedule: timers.schedule,
		cancel: timers.cancel,
	});
	gate.challengeReceived();
	timers.fire();
	assert.equal(gate.state(), 'unverified');
	gate.authOkChecked(true);
	assert.equal(gate.state(), 'verified');
	assert.equal(gate.reason(), null);
	assert.equal(late.length, 1);
	assert.match(late[0] ?? '', /did not complete/);
	assert.equal(await gate.verdict(), 'verified');
});

test('a valid auth.ok also upgrades a legacy-peer or bad-MAC verdict; nothing downgrades verified', async () => {
	const { gate } = makeGate();
	gate.challengeReceived();
	gate.legacyPeer();
	assert.equal(gate.state(), 'unverified');
	gate.authOkChecked(true);
	assert.equal(gate.state(), 'verified');
	// Once verified, a later bad or absent proof is ignored.
	gate.authOkChecked(false);
	assert.equal(gate.state(), 'verified');

	const second = makeGate();
	second.gate.challengeReceived();
	second.gate.authOkChecked(false);
	assert.equal(second.gate.state(), 'unverified');
	second.gate.authOkChecked(true);
	assert.equal(second.gate.state(), 'verified');
});

test('a valid auth.ok does not touch not-applicable', async () => {
	const { gate } = makeGate();
	gate.challengeReceived();
	gate.tokenUnreadable();
	gate.authOkChecked(true);
	assert.equal(gate.state(), 'not-applicable');
});

test('bad auth.ok settles unverified', async () => {
	const { gate, reasons } = makeGate();
	gate.challengeReceived();
	gate.authOkChecked(false);
	assert.equal(gate.state(), 'unverified');
	assert.match(gate.reason() ?? '', /failed the mutual auth check/);
	assert.equal(reasons.length, 1);
});

test('token unreadable: not-applicable, requests allowed, no warning', async () => {
	const { gate, reasons } = makeGate();
	gate.challengeReceived();
	gate.tokenUnreadable();
	assert.equal(await gate.verdict(), 'not-applicable');
	assert.equal(allowsRequests('not-applicable'), true);
	assert.deepEqual(reasons, []);
});

test('legacy peer with readable token: unverified with an actionable reason', async () => {
	const { gate, reasons } = makeGate();
	gate.challengeReceived();
	gate.legacyPeer();
	assert.equal(gate.state(), 'unverified');
	assert.match(reasons[0], /bridge_restart/);
});

test('request before any challenge resolves idle immediately and is refused', async () => {
	const { gate } = makeGate();
	assert.equal(await gate.verdict(), 'idle');
	assert.equal(allowsRequests('idle'), false);
});

test('reset cancels the timer, wakes waiters with reset (not idle), and forgets the verdict', async () => {
	const { gate, timers } = makeGate();
	gate.challengeReceived();
	const v = gate.verdict();
	gate.reset();
	assert.equal(await v, 'reset');
	assert.equal(allowsRequests('reset'), false);
	assert.equal(timers.count(), 0);
	assert.equal(gate.state(), 'idle');
	assert.equal(gate.reason(), null);
	// The fresh socket's own challenge arms a fresh timer; firing it settles
	// only the new exchange.
	gate.challengeReceived();
	assert.equal(timers.count(), 1);
	timers.fire();
	assert.equal(gate.state(), 'unverified');
});

test('a throwing onUnverified callback does not break settlement', async () => {
	const timers = manualTimers();
	const gate = createVerificationGate({
		timeoutMs: 1,
		onUnverified: () => { throw new Error('toast exploded'); },
		schedule: timers.schedule,
		cancel: timers.cancel,
	});
	gate.challengeReceived();
	timers.fire();
	assert.equal(gate.state(), 'unverified');
});

test('a refused challenge (bad token path) settles unverified instead of hanging', async () => {
	const { gate, reasons } = makeGate();
	gate.challengeReceived();
	const v = gate.verdict();
	gate.challengeRefused('path outside the bridge state dir');
	assert.equal(await v, 'unverified');
	assert.match(reasons[0], /auth challenge refused: path outside/);
});
