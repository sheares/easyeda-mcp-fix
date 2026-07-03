// Extension-side diagnostics: a tiny log channel to the bridge daemon and a
// robust error describer. Kept dependency-free (imports nothing from the
// handlers or ws-client) so any module can import it without a cycle.

type LogEmitter = (message: string) => void;

let emitter: LogEmitter | null = null;

/**
 * Register how bridgeLog() ships a line to the daemon. ws-client sets this to a
 * WebSocket notification once a connection is live, and clears it on disconnect.
 */
export function setBridgeLogEmitter(fn: LogEmitter | null): void {
	emitter = fn;
}

/**
 * Send a diagnostic line to the bridge daemon, where it lands in bridge.log.
 * The extension runs in EDA Pro's renderer with no filesystem access, so this
 * is the only way to get durable, host-readable logs out of it. Never throws:
 * diagnostics must not break the operation they are observing.
 */
export function bridgeLog(message: string): void {
	try {
		emitter?.(message);
	} catch {
		/* logging must never throw */
	}
}

/**
 * Turn an unknown thrown/rejected value into the most informative string we can.
 * EDA Pro's API frequently rejects with a non-Error (or with nothing at all),
 * which the naive `err.message ?? String(err)` collapses to "undefined" and
 * hides the real cause.
 */
export function describeError(err: unknown): string {
	if (err === undefined) return '<rejected with undefined>';
	if (err === null) return '<rejected with null>';
	if (err instanceof Error) {
		return err.stack || `${err.name}: ${err.message}`;
	}
	if (typeof err === 'object') {
		try {
			const ctor = (err as any).constructor?.name ?? 'object';
			return `non-Error(${ctor}): ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`;
		} catch {
			return `non-Error object (unserialisable): ${String(err)}`;
		}
	}
	return `${typeof err}: ${String(err)}`;
}
