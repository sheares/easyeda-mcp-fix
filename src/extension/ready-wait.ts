// Waits for a document or project to finish loading before the bridge reads
// or writes it. Pure module (no `eda` imports) so it can be unit-tested with
// ts-node; the eda-bound callers live in ready-wait-eda.ts.
//
// Why: openDocument resolves before the document's data has loaded, and the
// project tree reads as empty for a few seconds after a project opens. Live on
// EasyEDA 3.2.209 (5 Nov 2026), project_get_structure on a freshly opened
// project returned `data: []`; five seconds later it listed every board.
// EasyEDA 3.2.209 (pro-api runtime 0.3.59) added
// dmt_EditorControl.waitForDocumentReady and dmt_Project.waitForReady for
// exactly this. Older builds lack them, and this codebase has a long history
// of new EasyEDA calls that exist but never settle, so every wait is
// feature-detected, raced against a guard timer, and never throws.
//
// Feature detection needs the host, not just the runtime: on 3.2.209 itself
// the runtime has both waits but the host serves neither, so they hang (see
// host-probe.ts). Before the first wait of a kind, a cheap readiness-state
// read is raced against a short guard; a silent host turns that kind of wait
// off until EasyEDA restarts or a different extension version is installed
// (the breaker is on globalThis, stamped with the version; see
// shared-state.ts), at a cost of one short probe instead of one full guard
// timeout.

import { answersWithin } from './host-probe';

export type ReadyOutcome = 'ready' | 'not-ready' | 'unsupported' | 'timeout' | 'error' | 'disabled';

export interface ReadyWaitResult {
	outcome: ReadyOutcome;
	elapsedMs: number;
	detail?: string;
}

/** A per-kind breaker. Once a wait hits the guard timer, later waits of that kind are skipped. */
export interface ReadyBreaker {
	tripped: boolean;
	/** Set by the first probe: did the host answer at all? */
	hostAnswers?: boolean;
}

export interface WaitUntilReadyOptions {
	/** Kills a wait that never settles. Must stay well under the daemon's 45 s request timeout. */
	guardMs: number;
	breaker?: ReadyBreaker;
	/** A cheap call the host answers at once when it serves this kind of wait (a ready-state read). */
	probe?: () => Promise<unknown>;
	/** Guard for the probe. Default 1500 ms. */
	probeMs?: number;
	now?: () => number;
	schedule?: (fn: () => void, ms: number) => unknown;
	cancel?: (handle: unknown) => void;
}

/**
 * Run `call` (an EasyEDA readiness wait that resolves true when ready, false on
 * its own timeout) and classify the result. `call` undefined means the runtime
 * does not have the API. Never rejects: a failed wait must not fail the
 * operation it guards, which then behaves exactly as it did before the wait
 * existed.
 */
export async function waitUntilReady(
	call: (() => Promise<unknown>) | undefined,
	opts: WaitUntilReadyOptions,
): Promise<ReadyWaitResult> {
	const now = opts.now ?? (() => Date.now());
	const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	const start = now();
	const done = (outcome: ReadyOutcome, detail?: string): ReadyWaitResult => ({
		outcome,
		elapsedMs: now() - start,
		...(detail === undefined ? {} : { detail }),
	});

	if (!call) return done('unsupported');
	if (opts.breaker?.tripped) return done('disabled');

	if (opts.probe && opts.breaker?.hostAnswers === undefined) {
		const probeMs = opts.probeMs ?? 1500;
		const probed = await answersWithin(opts.probe, probeMs, { schedule, cancel });
		if (opts.breaker) opts.breaker.hostAnswers = probed.answered;
		if (!probed.answered) {
			if (opts.breaker) opts.breaker.tripped = true;
			return done('unsupported', `the host did not answer the ready-state probe within ${probeMs} ms`);
		}
	}

	const GUARD = Symbol('guard');
	let handle: unknown;
	const guard = new Promise<typeof GUARD>((resolve) => {
		handle = schedule(() => resolve(GUARD), opts.guardMs);
	});
	try {
		const value = await Promise.race([Promise.resolve().then(call), guard]);
		if (value === GUARD) {
			if (opts.breaker) opts.breaker.tripped = true;
			return done('timeout');
		}
		if (value === true) return done('ready');
		if (value === false) return done('not-ready');
		// The RPC exists client-side but the host answered with something else
		// (typically undefined when the main process lacks the handler).
		return done('unsupported', `returned ${value === undefined ? 'undefined' : typeof value}`);
	} catch (err: unknown) {
		return done('error', err instanceof Error ? err.message : String(err));
	} finally {
		cancel(handle);
	}
}

/** One bridge.log line for a wait, or null when there is nothing worth logging. */
export function describeReadyWait(label: string, result: ReadyWaitResult): string | null {
	// 'ready' within a few ms is the normal case on an already-loaded document,
	// and 'unsupported'/'disabled' repeat on every call; log only what helps a
	// diagnosis.
	if (result.outcome === 'unsupported' && result.detail === undefined) return null;
	if (result.outcome === 'disabled') return null;
	if (result.outcome === 'ready' && result.elapsedMs < 250) return null;
	const detail = result.detail ? ` (${result.detail})` : '';
	const off = result.outcome === 'timeout' || (result.outcome === 'unsupported' && /probe/.test(result.detail ?? ''));
	const tail = off ? '; further waits of this kind are skipped until EasyEDA restarts or a different extension version is installed' : '';
	return `ready-wait ${label}: ${result.outcome} after ${result.elapsedMs} ms${detail}${tail}`;
}
