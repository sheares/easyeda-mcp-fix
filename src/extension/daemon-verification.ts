// D1 follow-up (QA 2026-08-23, Major 2 and 3): the extension's view of
// whether the bridge daemon it is talking to has proven knowledge of the
// ws-token, and the policy for what to do with requests while it has not.
//
// The hmac-v1 exchange (auth-mac.ts) lets the daemon prove itself with an
// auth.ok MAC. Before this module, a bad auth.ok raised a toast but a MISSING
// auth.ok did nothing, and neither outcome stopped requests: a rogue listener
// on 16168 that copied the genuine auth.challenge shape and stayed silent
// was never flagged and could drive every handler. Now:
//
//   - a challenge marks the gate PENDING (synchronously, before the token
//     read, so a request that follows the challenge on the wire always waits
//     for the verdict) and arms ONE timer covering the whole exchange: token
//     read, our answer, the daemon's auth.ok. auth.ok settles it (verified /
//     unverified); expiry settles it unverified. Arming at the challenge
//     rather than at our answer matters because this codebase has a history
//     of EDA calls that never settle: a hung token read must not leave every
//     request waiting forever;
//   - a peer we cannot verify because WE cannot read the token (browser
//     build, external-interaction permission off) is NOT-APPLICABLE: the
//     daemon decides under its own policy, as before (Origin trust);
//   - a peer we could verify but which does not speak hmac-v1 (a daemon
//     older than 1.6.0, or a rogue fishing with the legacy challenge) is
//     UNVERIFIED;
//   - a request arriving before any challenge (IDLE) is refused: the real
//     daemon challenges first thing on every connection.
//
// verdict() is what the request pipeline awaits. allowsRequests() is the
// policy in one place. Pure module (no `eda` imports, injectable timers) so
// the state machine is unit-tested directly.

export type VerificationState = 'idle' | 'pending' | 'verified' | 'unverified' | 'not-applicable';

export interface VerificationGateOptions {
	/** How long to wait for auth.ok after sending an hmac answer. */
	timeoutMs: number;
	/** Called once per settlement into 'unverified', with a human reason. */
	onUnverified?: (reason: string) => void;
	schedule?: (fn: () => void, ms: number) => unknown;
	cancel?: (handle: unknown) => void;
}

export interface VerificationGate {
	/** The daemon sent auth.challenge. Call synchronously on receipt; arms the timeout. */
	challengeReceived(): void;
	/** auth.ok arrived and was checked. */
	authOkChecked(ok: boolean): void;
	/** We cannot verify this peer because we could not read the token. */
	tokenUnreadable(): void;
	/** We could read the token but the peer does not speak hmac-v1. */
	legacyPeer(): void;
	/** The challenge itself was unacceptable (e.g. a token path outside the state dir). */
	challengeRefused(reason: string): void;
	/** Resolves once the gate is settled; immediately if it already is. */
	verdict(): Promise<VerificationState>;
	state(): VerificationState;
	/** The reason recorded at the last 'unverified' settlement, if any. */
	reason(): string | null;
	/** Fresh socket: forget everything, cancel any timer. */
	reset(): void;
}

/** Policy: may a request run under this state? Only the two proven-or-unprovable outcomes. */
export function allowsRequests(state: VerificationState): boolean {
	return state === 'verified' || state === 'not-applicable';
}

export function createVerificationGate(opts: VerificationGateOptions): VerificationGate {
	const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

	let state: VerificationState = 'idle';
	let reason: string | null = null;
	let timer: unknown = null;
	let waiters: Array<(s: VerificationState) => void> = [];

	const clearTimer = (): void => {
		if (timer !== null) {
			cancel(timer);
			timer = null;
		}
	};

	const settle = (next: VerificationState, why: string | null): void => {
		// First settlement wins: a late auth.ok after the timeout must not
		// flip an 'unverified' verdict that callers have already acted on.
		if (state !== 'idle' && state !== 'pending') return;
		clearTimer();
		state = next;
		reason = why;
		if (next === 'unverified' && why) {
			try {
				opts.onUnverified?.(why);
			} catch { /* a failing warning must not break the gate */ }
		}
		const toWake = waiters;
		waiters = [];
		for (const w of toWake) w(next);
	};

	return {
		challengeReceived() {
			if (state !== 'idle') return;
			state = 'pending';
			timer = schedule(() => {
				timer = null;
				settle('unverified', `mutual auth did not complete within ${opts.timeoutMs}ms (no auth.ok from the daemon, or the token read never returned)`);
			}, opts.timeoutMs);
		},
		authOkChecked(ok) {
			settle(ok ? 'verified' : 'unverified', ok ? null : 'daemon failed the mutual auth check');
		},
		tokenUnreadable() {
			settle('not-applicable', null);
		},
		legacyPeer() {
			settle('unverified', 'bridge daemon does not support mutual auth; restart it (bridge_restart) or update the MCP server');
		},
		challengeRefused(why) {
			settle('unverified', `auth challenge refused: ${why}`);
		},
		verdict() {
			if (state !== 'idle' && state !== 'pending') return Promise.resolve(state);
			if (state === 'idle') {
				// No challenge has arrived. The real daemon challenges before
				// anything else, so a request here comes from a peer that
				// skipped the handshake. Do not wait for something that is
				// not coming.
				return Promise.resolve('idle');
			}
			return new Promise((resolve) => waiters.push(resolve));
		},
		state: () => state,
		reason: () => reason,
		reset() {
			clearTimer();
			state = 'idle';
			reason = null;
			const toWake = waiters;
			waiters = [];
			// Anything still waiting belonged to the old socket; let it see
			// 'idle' and refuse rather than hang.
			for (const w of toWake) w('idle');
		},
	};
}
