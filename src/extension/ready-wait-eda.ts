// eda-bound readiness waits. The logic and its tests live in ready-wait.ts;
// this file only binds it to the runtime API and to bridge.log.

import * as extensionConfig from '../../extension.json';
import { bridgeLog } from './diag';
import { describeReadyWait, waitUntilReady, type ReadyBreaker, type ReadyWaitResult } from './ready-wait';
import { versionedShared } from './shared-state';

/** Passed to EasyEDA as its own timeout; it resolves false when this runs out. */
const EDA_READY_TIMEOUT_MS = 6_000;
/** Our guard for a wait that never settles. Under the daemon's 45 s request timeout. */
const READY_GUARD_MS = 8_000;

// Kept on globalThis like the request queue, so a hot-reloaded handler module
// shares the breaker with the one it replaced; stamped with the extension
// version, so an upgrade starts with a fresh one (see shared-state.ts).
function breaker(key: string): ReadyBreaker {
	return versionedShared<ReadyBreaker>(globalThis as any, key, extensionConfig.version, () => ({ tripped: false }));
}

/**
 * Wait until a document (schematic page, PCB, panel, or a symbol/footprint
 * editor tab) has loaded. Call after openDocument or openInEditor and before
 * reading or writing the document. No-op on builds whose host does not serve
 * it (3.2.209 included), after one short probe.
 */
export async function waitForDocumentReady(documentUuidOrTabId: string): Promise<ReadyWaitResult> {
	const ec: any = (eda as any).dmt_EditorControl;
	const call = typeof ec?.waitForDocumentReady === 'function'
		? () => ec.waitForDocumentReady(documentUuidOrTabId, EDA_READY_TIMEOUT_MS)
		: undefined;
	const probe = typeof ec?.getDocumentReadyState === 'function'
		? () => ec.getDocumentReadyState(documentUuidOrTabId)
		: undefined;
	const result = await waitUntilReady(call, { guardMs: READY_GUARD_MS, probe, breaker: breaker('__easyedaMcpDocReadyBreaker') });
	const line = describeReadyWait(`document ${documentUuidOrTabId}`, result);
	if (line) bridgeLog(line);
	return result;
}

/**
 * Wait until the current project's data has loaded, so its tree does not read
 * as empty. No-op on builds whose host does not serve it (3.2.209 included),
 * after one short probe.
 */
export async function waitForProjectReady(): Promise<ReadyWaitResult> {
	const project: any = (eda as any).dmt_Project;
	const call = typeof project?.waitForReady === 'function'
		? () => project.waitForReady(undefined, EDA_READY_TIMEOUT_MS)
		: undefined;
	const probe = typeof project?.getReadyState === 'function'
		? () => project.getReadyState()
		: undefined;
	const result = await waitUntilReady(call, { guardMs: READY_GUARD_MS, probe, breaker: breaker('__easyedaMcpProjectReadyBreaker') });
	const line = describeReadyWait('project', result);
	if (line) bridgeLog(line);
	return result;
}
