// Does the EasyEDA host answer a call at all? Pure module (no `eda` imports)
// so it can be unit-tested with ts-node.
//
// Why: a pro-api runtime can ship a method before the editor host that serves
// it. The call is a thin rpcCall to the host, and a host with no handler for
// it never answers, so the promise never settles. Checking `typeof fn ===
// 'function'` therefore proves nothing. Seen live on EasyEDA Pro 3.2.209
// (5 Nov 2026): runtime 0.3.59 has dmt_EditorControl.waitForDocumentReady,
// getDocumentReadyState, dmt_Project.waitForReady and the whole
// pcb_Document autoroute job API (startAutoRouting, getAutoJobStatus,
// cancelAutoJob, getAutoJobLog, startAutoLayout), all marked "since EDA
// v4.1.79", while the host's handler table (pro-ui 3.2.198) serves none of
// them. Every one of those calls hangs.
//
// The fix is to ask the host something cheap with a short guard before
// trusting the API, and to remember the answer until EasyEDA restarts or a
// different extension version is installed (it is kept on globalThis,
// stamped with the version; see shared-state.ts).

export type ProbeOutcome =
	| { answered: true; rejected?: string }
	| { answered: false };

export interface ProbeOptions {
	schedule?: (fn: () => void, ms: number) => unknown;
	cancel?: (handle: unknown) => void;
}

/**
 * Run `call` and report whether the host answered within `ms`. A rejection
 * counts as an answer (the host has a handler; it just did not like the
 * arguments). Never rejects.
 */
export async function answersWithin(
	call: () => Promise<unknown>,
	ms: number,
	opts: ProbeOptions = {},
): Promise<ProbeOutcome> {
	const schedule = opts.schedule ?? ((fn, t) => setTimeout(fn, t));
	const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	const SILENT = Symbol('silent');
	let handle: unknown;
	const guard = new Promise<typeof SILENT>((resolve) => {
		handle = schedule(() => resolve(SILENT), ms);
	});
	try {
		const settled = Promise.resolve()
			.then(call)
			.then(
				() => ({ answered: true as const }),
				(err: unknown) => ({ answered: true as const, rejected: err instanceof Error ? err.message : String(err) }),
			);
		const value = await Promise.race([settled, guard]);
		return value === SILENT ? { answered: false } : value;
	} finally {
		cancel(handle);
	}
}

/**
 * answersWithin, run once per key and remembered in `cache`. Concurrent
 * callers share the one probe.
 */
export function probeOnce(
	cache: Map<string, Promise<ProbeOutcome>>,
	key: string,
	call: () => Promise<unknown>,
	ms: number,
	opts: ProbeOptions = {},
): Promise<ProbeOutcome> {
	let p = cache.get(key);
	if (!p) {
		p = answersWithin(call, ms, opts);
		cache.set(key, p);
	}
	return p;
}
