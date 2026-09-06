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
//     daemon challenges first thing on every connection;
//   - a MAC-verified auth.ok that arrives AFTER the gate settled unverified
//     (a benign overrun: EasyEDA's main process busy so the token read over
//     IPC stalled, or the daemon's event loop busy) upgrades the verdict to
//     verified. A rogue cannot forge that MAC, so the upgrade is safe, and
//     without it a transient stall would leave the bridge refusing every
//     request until the socket happened to drop (QA 2026-09-06, Major 1).
//     Bad or absent proof never downgrades an earlier 'verified'.
//
// verdict() is what the request pipeline awaits. allowsRequests() is the
// policy in one place. Pure module (no `eda` imports, injectable timers) so
// the state machine is unit-tested directly.

export type VerificationState = 'idle' | 'pending' | 'verified' | 'unverified' | 'not-applicable';

/**
 * What verdict() resolves to. 'reset' is only ever handed to a waiter whose
 * socket went away mid-wait (reset() ran); the gate's own state() is 'idle'
 * by then. Callers drop such a request: the daemon has already rejected it
 * on socket close.
 */
export type Verdict = VerificationState | 'reset';

export interface VerificationGateOptions {
	/** How long the whole exchange may take from the challenge to a checked auth.ok. */
	timeoutMs: number;
	/** Called once per settlement into 'unverified', with a human reason. */
	onUnverified?: (reason: string) => void;
	/** Called when a valid auth.ok upgrades an 'unverified' gate; receives the earlier reason. */
	onVerifiedLate?: (earlierReason: string | null) => void;
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
	verdict(): Promise<Verdict>;
	state(): VerificationState;
	/** The reason recorded at the last 'unverified' settlement, if any. */
	reason(): string | null;
	/** Fresh socket: forget everything, cancel any timer. */
	reset(): void;
}

/** Policy: may a request run under this verdict? Only the two proven-or-unprovable outcomes. */
export function allowsRequests(verdict: Verdict): boolean {
	return verdict === 'verified' || verdict === 'not-applicable';
}

export function createVerificationGate(opts: VerificationGateOptions): VerificationGate {
	const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

	let state: VerificationState = 'idle';
	let reason: string | null = null;
	let timer: unknown = null;
	let waiters: Array<(v: Verdict) => void> = [];

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
			if (ok && state === 'unverified') {
				// Late but genuine proof: upgrade. The earlier verdict was a
				// timeout, a legacy/refused challenge, or a bad MAC; a peer
				// that can now produce a valid MAC holds the token and is the
				// daemon, so every one of those was a false alarm in hindsight.
				const earlier = reason;
				state = 'verified';
				reason = null;
				try {
					opts.onVerifiedLate?.(earlier);
				} catch { /* logging must never break the gate */ }
				return;
			}
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
			// Anything still waiting belonged to the old socket; tell it so
			// (distinct from 'idle', which means "no challenge on THIS socket")
			// so the caller can drop it rather than answer with a misleading
			// refusal (QA 2026-09-06, Minor 1).
			for (const w of toWake) w('reset');
		},
	};
}
