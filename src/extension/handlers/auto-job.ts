// EasyEDA autoroute / auto-layout as jobs. Two paths:
//
// 1. The @alpha job model (pcb_Document.startAutoRouting and friends, in the
//    pro-api 0.3.59 runtime): a start call returns a job handle at once, the
//    work runs in the background, and getAutoJobStatus reports progress.
// 2. When the host does not serve that API (EasyEDA Pro 3.2.209: the runtime
//    has the methods, the host's handler table does not, so every call hangs;
//    see host-probe.ts), the blocking autoRouting() / autoLayout() run in the
//    background behind the same tools, tracked by LocalJobStore.
//
// Which path is chosen by asking the host once, with a short guard, whether
// it answers getAutoJobStatus at all.

import * as extensionConfig from '../../../extension.json';
import { BridgeUserError, bridgeLog } from '../diag';
import { probeOnce, type ProbeOutcome } from '../host-probe';
import { versionedShared } from '../shared-state';
import { toAutoRoutingProps, type AutorouteToolParams } from './autoroute-params';
import { LocalJobStore, type LocalJobKind } from './auto-job-local';

// Starting, polling and cancelling should all answer at once. A call that
// does not is an EasyEDA hang, not a slow job.
const JOB_CALL_TIMEOUT_MS = 20_000;
/** How long the host gets to answer the probe. A served call answers in milliseconds. */
const JOB_PROBE_MS = 2_000;

// Kept on globalThis like the request queue, so a hot-reloaded handler module
// shares jobs and the probe result with the one it replaced; stamped with the
// extension version, so an upgrade never runs on an older version's objects
// (see shared-state.ts).
function shared<T>(key: string, make: () => T): T {
	return versionedShared(globalThis as any, key, extensionConfig.version, make);
}
const localJobs = (): LocalJobStore => shared('__easyedaMcpLocalJobs', () => new LocalJobStore());
const probeCache = (): Map<string, Promise<ProbeOutcome>> => shared('__easyedaMcpHostProbes', () => new Map());
const probeLog = (): { logged: boolean } => shared('__easyedaMcpJobProbeLog', () => ({ logged: false }));

function pcbDocument(): any {
	return (eda as any).pcb_Document;
}

function method(name: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
	const doc = pcbDocument();
	const fn = doc?.[name];
	return typeof fn === 'function' ? (...args: unknown[]) => fn.apply(doc, args) : undefined;
}

function requireMethod(name: string): (...args: unknown[]) => Promise<unknown> {
	const fn = method(name);
	if (!fn) {
		throw new BridgeUserError(`This EasyEDA build has no pcb_Document.${name}. Autorouting from the bridge needs EasyEDA Pro 3.2.150 or later; update EasyEDA (Help → Check for Updates) and try again.`);
	}
	return fn;
}

/** Does the host serve the job API? Asked once until EasyEDA restarts or the extension version changes. */
async function jobApiServed(): Promise<boolean> {
	const getStatus = method('getAutoJobStatus');
	if (!getStatus || !method('startAutoRouting')) return false;
	const outcome = await probeOnce(probeCache(), 'pcb_Document.getAutoJobStatus', () => getStatus('mcp-probe'), JOB_PROBE_MS);
	if (!outcome.answered) {
		const log = probeLog();
		if (!log.logged) {
			log.logged = true;
			bridgeLog(`auto-job: the host did not answer pcb_Document.getAutoJobStatus within ${JOB_PROBE_MS} ms; using the blocking autoRouting/autoLayout in the background instead`);
		}
	}
	return outcome.answered;
}

function timeBoxed<T>(promise: Promise<T>, apiName: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new BridgeUserError(
				`pcb_Document.${apiName} did not answer within ${JOB_CALL_TIMEOUT_MS / 1000} s. Check the board before retrying: a start call may still have begun routing.`,
			));
		}, JOB_CALL_TIMEOUT_MS);
		promise.then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
}

function requireJobId(params: Record<string, any>): string {
	const jobId = params.jobId;
	if (typeof jobId !== 'string' || jobId.length === 0) throw new BridgeUserError('jobId is required (from pcb_autoroute_start or pcb_autolayout_start).');
	return jobId;
}

function requireHandle(handle: unknown, apiName: string): { jobId: string } {
	const jobId = (handle as { jobId?: unknown } | null | undefined)?.jobId;
	if (typeof jobId !== 'string' || jobId.length === 0) {
		throw new BridgeUserError(`pcb_Document.${apiName} returned no job handle (got ${JSON.stringify(handle) ?? 'undefined'}). EasyEDA did not start the job.`);
	}
	return { jobId };
}

function startBlocking(kind: LocalJobKind, run: () => Promise<unknown>, what: string): { jobId: string } {
	const store = localJobs();
	const handle = store.start(kind, run, `${what} started (blocking call, run in the background)`);
	bridgeLog(`auto-job: ${handle.jobId} started (blocking ${kind === 'routing' ? 'autoRouting' : 'autoLayout'})`);
	return handle;
}

function unknownLocalJob(jobId: string): BridgeUserError {
	return new BridgeUserError(`No job ${jobId}. Emulated job IDs live in the extension and are lost when EasyEDA restarts or a different extension version is installed; check the board for the result.`);
}

export const autoJobHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.autoJob.startRouting': async (params) => {
		const props = toAutoRoutingProps(params as AutorouteToolParams);
		if (await jobApiServed()) {
			const handle = await timeBoxed(requireMethod('startAutoRouting')(props), 'startAutoRouting');
			return { ...requireHandle(handle, 'startAutoRouting'), mode: 'job', sent: props };
		}
		const run = requireMethod('autoRouting');
		return { ...startBlocking('routing', () => run(props), 'Autorouting'), mode: 'blocking-fallback', sent: props };
	},

	'pcb.autoJob.startLayout': async () => {
		if (await jobApiServed()) {
			const handle = await timeBoxed(requireMethod('startAutoLayout')(), 'startAutoLayout');
			return { ...requireHandle(handle, 'startAutoLayout'), mode: 'job' };
		}
		const run = requireMethod('autoLayout');
		return { ...startBlocking('layout', () => run(), 'Auto-layout'), mode: 'blocking-fallback' };
	},

	'pcb.autoJob.getStatus': async (params) => {
		const jobId = requireJobId(params);
		const store = localJobs();
		if (store.isLocal(jobId)) {
			const status = store.status(jobId);
			if (!status) throw unknownLocalJob(jobId);
			return status;
		}
		const status = await timeBoxed(requireMethod('getAutoJobStatus')(jobId), 'getAutoJobStatus');
		if (status == null) throw new BridgeUserError(`EasyEDA knows no job ${jobId}. Job IDs do not survive an EasyEDA reload.`);
		return status;
	},

	'pcb.autoJob.cancel': async (params) => {
		const jobId = requireJobId(params);
		const store = localJobs();
		if (store.isLocal(jobId)) {
			if (!store.status(jobId)) throw unknownLocalJob(jobId);
			return {
				cancelRequested: false,
				note: 'This is an emulated job around EasyEDA\'s blocking call, which cannot be cancelled. It stops by itself within 15 minutes; restore from the start call\'s backup SHA if you do not want its result.',
			};
		}
		return { cancelRequested: await timeBoxed(requireMethod('cancelAutoJob')(jobId), 'cancelAutoJob') };
	},

	'pcb.autoJob.getLog': async (params) => {
		const jobId = requireJobId(params);
		const store = localJobs();
		if (store.isLocal(jobId)) {
			const log = store.log(jobId);
			if (!log) throw unknownLocalJob(jobId);
			return log;
		}
		const log = await timeBoxed(requireMethod('getAutoJobLog')(jobId), 'getAutoJobLog');
		return Array.isArray(log) ? log : [];
	},
};
