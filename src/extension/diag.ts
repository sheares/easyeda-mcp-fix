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
/**
 * An error whose message is the whole story: a deliberate, user-facing
 * refusal (wrong document type, unverified daemon) rather than an unexpected
 * failure. describeError returns just the message for these, so the MCP
 * client is not handed a renderer stack trace and an internal api.js URL.
 */
export class BridgeUserError extends Error {
	readonly userFacing = true;
	constructor(message: string) {
		super(message);
		this.name = 'BridgeUserError';
	}
}

const DETAIL_CAP = 2000;

function dumpErrorDetail(err: Error): string {
	const parts: string[] = [];
	const safe = (v: unknown): string => {
		try { return JSON.stringify(v, Object.getOwnPropertyNames(Object(v))) ?? String(v); } catch { return String(v); }
	};
	if ((err as any).cause !== undefined) parts.push(`cause: ${safe((err as any).cause)}`);
	const own: Record<string, unknown> = {};
	for (const k of Object.getOwnPropertyNames(err)) {
		if (k === 'stack' || k === 'message' || k === 'cause') continue;
		own[k] = (err as any)[k];
	}
	if (Object.keys(own).length > 0) parts.push(`properties: ${safe(own)}`);
	if (parts.length === 0) parts.push('(no cause or extra properties on the error)');
	const text = `detail: ${parts.join('; ')}`;
	return text.length > DETAIL_CAP ? `${text.slice(0, DETAIL_CAP)}... [truncated]` : text;
}

export function describeError(err: unknown): string {
	if (err === undefined) return '<rejected with undefined>';
	if (err === null) return '<rejected with null>';
	if (err instanceof Error && (err as any).userFacing === true) {
		return err.message;
	}
	if (err instanceof Error) {
		// EDA sometimes does `new Error(obj)`, so the message is the useless
		// "[object Object]" (or empty) and the real detail sits in cause/own props.
		if (err.message === '[object Object]' || err.message === '') {
			return `${err.stack || `${err.name}: ${err.message}`}\n${dumpErrorDetail(err)}`;
		}
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
