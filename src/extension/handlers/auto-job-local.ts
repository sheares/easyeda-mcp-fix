// Job-style wrapper around EasyEDA's blocking pcb_Document.autoRouting() and
// autoLayout(), for builds whose host does not serve the @alpha job API (see
// host-probe.ts: EasyEDA Pro 3.2.209 is one). Pure module (no `eda` imports)
// so it can be unit-tested with ts-node.
//
// The blocking call is started without awaiting it; the extension keeps the
// job's state, so status and log reads never touch the host. What the
// emulation cannot give, and says so in every status:
//   - progress: the blocking call reports nothing until it finishes;
//   - cancel: there is no way to stop it;
//   - partial results: EasyEDA's fixed 900 s ceiling commits nothing if it
//     runs out (types 0.4.27, autoRouting remarks).

export type LocalJobKind = 'routing' | 'layout';
export type LocalJobState = 'running' | 'completed' | 'failed';

export interface LocalJobLogEntry {
	at: number;
	level: 'info' | 'warn' | 'error';
	code?: string;
	message: string;
}

export interface LocalJobStatus {
	jobId: string;
	state: LocalJobState;
	progress: number | null;
	partial: false;
	emulated: true;
	kind: LocalJobKind;
	elapsedMs: number;
	result?: unknown;
	error?: { code: string; message: string };
	note: string;
}

interface LocalJob {
	jobId: string;
	kind: LocalJobKind;
	startedAt: number;
	state: LocalJobState;
	finishedAt?: number;
	result?: unknown;
	error?: { code: string; message: string };
	log: LocalJobLogEntry[];
}

export const LOCAL_JOB_PREFIX = 'mcp-blocking-';
/** EasyEDA's own hard ceiling on the blocking autoRouting call. */
export const BLOCKING_CEILING_MS = 900_000;
/** After this long with no answer the host has hung, not merely run out of time. */
export const NO_ANSWER_MS = BLOCKING_CEILING_MS + 120_000;

const NOTE = 'Emulated job: this EasyEDA build does not serve the autoroute job API, so the bridge runs the blocking call in the background. No progress figure, no cancel, and EasyEDA commits nothing if its 15-minute ceiling runs out.';

/** Summarise an IPCB_AutoRoutingResult / IPCB_AutoLayoutResult for the log. */
export function describeResult(kind: LocalJobKind, result: unknown): { level: 'info' | 'warn' | 'error'; message: string; failed: boolean } {
	const r = (result ?? {}) as Record<string, unknown>;
	if (r.success === false) {
		return { level: 'error', failed: true, message: `EasyEDA reports the ${kind === 'routing' ? 'autorouter' : 'auto-layout'} did not start (success: false).` };
	}
	if (kind === 'routing') {
		const total = typeof r.totalNetsCount === 'number' ? r.totalNetsCount : undefined;
		const ok = typeof r.successNetsCount === 'number' ? r.successNetsCount : undefined;
		const failedNets = Array.isArray(r.failedNets) ? (r.failedNets as unknown[]).map(String) : [];
		const secs = typeof r.duration === 'number' ? ` in ${Math.round(r.duration / 1000)} s` : '';
		const counts = total !== undefined && ok !== undefined ? `${ok} of ${total} nets routed${secs}` : `finished${secs}`;
		if (failedNets.length > 0) return { level: 'warn', failed: false, message: `${counts}; not routed: ${failedNets.join(', ')}` };
		return { level: 'info', failed: false, message: counts };
	}
	const total = typeof r.totalComponentsCount === 'number' ? r.totalComponentsCount : undefined;
	const ok = typeof r.successComponentsCount === 'number' ? r.successComponentsCount : undefined;
	const failed = Array.isArray(r.failedComponents) ? (r.failedComponents as unknown[]).length : 0;
	const counts = total !== undefined && ok !== undefined ? `${ok} of ${total} components placed` : 'finished';
	return failed > 0
		? { level: 'warn', failed: false, message: `${counts}; ${failed} could not be placed` }
		: { level: 'info', failed: false, message: counts };
}

export class LocalJobStore {
	private readonly jobs = new Map<string, LocalJob>();
	private seq = 0;

	constructor(private readonly now: () => number = () => Date.now()) {}

	isLocal(jobId: string): boolean {
		return jobId.startsWith(LOCAL_JOB_PREFIX);
	}

	/** Start `run` without awaiting it and return the job handle at once. */
	start(kind: LocalJobKind, run: () => Promise<unknown>, startMessage: string): { jobId: string } {
		const startedAt = this.now();
		this.seq += 1;
		const jobId = `${LOCAL_JOB_PREFIX}${kind}-${startedAt.toString(36)}-${this.seq}`;
		const job: LocalJob = { jobId, kind, startedAt, state: 'running', log: [{ at: startedAt, level: 'info', message: startMessage }] };
		this.jobs.set(jobId, job);
		let promise: Promise<unknown>;
		try {
			promise = Promise.resolve(run());
		} catch (err) {
			promise = Promise.reject(err);
		}
		promise.then(
			(result) => {
				if (job.state !== 'running') return;
				const d = describeResult(kind, result);
				job.finishedAt = this.now();
				job.result = result;
				job.state = d.failed ? 'failed' : 'completed';
				if (d.failed) job.error = { code: 'NOT_STARTED', message: d.message };
				job.log.push({ at: job.finishedAt, level: d.level, message: d.message });
			},
			(err: unknown) => {
				if (job.state !== 'running') return;
				const message = err instanceof Error ? err.message : String(err);
				job.finishedAt = this.now();
				job.state = 'failed';
				job.error = { code: 'EASYEDA_ERROR', message };
				job.log.push({ at: job.finishedAt, level: 'error', code: 'EASYEDA_ERROR', message });
			},
		);
		return { jobId };
	}

	private settleIfHung(job: LocalJob): void {
		if (job.state !== 'running') return;
		const t = this.now();
		if (t - job.startedAt < NO_ANSWER_MS) return;
		job.state = 'failed';
		job.finishedAt = t;
		job.error = { code: 'NO_ANSWER', message: `EasyEDA had not answered after ${Math.round((t - job.startedAt) / 60_000)} minutes, past its own 15-minute ceiling. Check the board; reload EasyEDA if it is stuck.` };
		job.log.push({ at: t, level: 'error', code: 'NO_ANSWER', message: job.error.message });
	}

	status(jobId: string): LocalJobStatus | undefined {
		const job = this.jobs.get(jobId);
		if (!job) return undefined;
		this.settleIfHung(job);
		return {
			jobId,
			state: job.state,
			progress: job.state === 'running' ? null : 100,
			partial: false,
			emulated: true,
			kind: job.kind,
			elapsedMs: (job.finishedAt ?? this.now()) - job.startedAt,
			...(job.result === undefined ? {} : { result: job.result }),
			...(job.error ? { error: job.error } : {}),
			note: NOTE,
		};
	}

	log(jobId: string): LocalJobLogEntry[] | undefined {
		const job = this.jobs.get(jobId);
		if (!job) return undefined;
		this.settleIfHung(job);
		return [...job.log];
	}
}
