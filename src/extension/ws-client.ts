import { componentHandlers } from './handlers/component';
import { trackHandlers } from './handlers/track';
import { viaHandlers } from './handlers/via';
import { netHandlers } from './handlers/net';
import { drcHandlers } from './handlers/drc';
import { documentHandlers } from './handlers/document';
import { schComponentHandlers } from './handlers/sch-component';
import { schWireHandlers } from './handlers/sch-wire';
import { schDocumentHandlers } from './handlers/sch-document';
import { schSelectHandlers } from './handlers/sch-select';
import { schPrimitiveHandlers } from './handlers/sch-primitive';
import { libraryHandlers } from './handlers/library';
import { pourFillHandlers } from './handlers/pour-fill';
import { manufactureHandlers } from './handlers/manufacture';
import { layerHandlers } from './handlers/layer';
import { pcbPrimitiveHandlers } from './handlers/pcb-primitive';
import { editorHandlers } from './handlers/editor';
import { fileManagerHandlers } from './handlers/file-manager';
import { describeError, setBridgeLogEmitter } from './diag';

// Single bridge daemon owns the WebSocket port. No more scanning.
// 16168 is one above the legacy 15168-15207 scan range — chosen so the
// new daemon doesn't collide with any stale processes from the old
// port-scanning architecture during migration.
const BRIDGE_PORT = 16168;
const WS_ID = 'mcp-bridge';

// Generate a random 8-character hex instance ID for this tab.
// Stored on globalThis so it survives extension IIFE re-evaluations
// but is unique per browser tab/context.
const GLOBAL_KEY = '__claude_mcp_instance_id__';

function getOrCreateInstanceId(): string {
	const g = globalThis as any;
	if (!g[GLOBAL_KEY]) {
		const bytes = new Uint8Array(4);
		crypto.getRandomValues(bytes);
		g[GLOBAL_KEY] = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	}
	return g[GLOBAL_KEY];
}

const instanceId = getOrCreateInstanceId();

export function getInstanceId(): string {
	return instanceId;
}

interface QueryParams {
	fields?: string[];
	filter?: Record<string, string | number | boolean | string[]>;
	limit?: number;
}

function matchesFilter(item: any, filter: Record<string, string | number | boolean | string[]>): boolean {
	for (const [key, condition] of Object.entries(filter)) {
		const value = item[key];
		if (Array.isArray(condition)) {
			// OR: item.key must be one of the values
			if (!condition.includes(String(value))) return false;
		} else if (typeof condition === 'string' && condition.endsWith('*')) {
			// Prefix glob: item.key must start with prefix
			const prefix = condition.slice(0, -1);
			if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
		} else {
			// Exact equality
			if (value !== condition) return false;
		}
	}
	return true;
}

function projectFields(item: any, fields: string[]): any {
	const projected: any = {};
	for (const field of fields) {
		if (field in item) {
			projected[field] = item[field];
		}
	}
	return projected;
}

function applyQueryParams(result: any, qp: QueryParams): any {
	if (!qp.fields && !qp.filter && !qp.limit) return result;

	if (!Array.isArray(result)) {
		// Non-array: only fields projection applies
		if (qp.fields && result && typeof result === 'object') {
			return projectFields(result, qp.fields);
		}
		return result;
	}

	let items = result;

	// 1. Filter
	if (qp.filter) {
		items = items.filter((item: any) => matchesFilter(item, qp.filter!));
	}

	// 2. Limit
	if (qp.limit && items.length > qp.limit) {
		items = items.slice(0, qp.limit);
	}

	// 3. Fields projection
	if (qp.fields) {
		const availableFields = items.length > 0 ? Object.keys(items[0]) : [];
		items = items.map((item: any) => projectFields(item, qp.fields!));
		return { items, _availableFields: availableFields };
	}

	return items;
}

function wsUrl(): string {
	return `ws://localhost:${BRIDGE_PORT}?instanceId=${instanceId}`;
}

// Per-tab connection state (persisted on globalThis to survive IIFE re-evals).
const CONNECTED_KEY = '__claude_mcp_connected__';
const LAST_RECV_KEY = '__claude_mcp_last_received__';
const CONNECTING_KEY = '__claude_mcp_connecting__';
// Sticky flag: true once we've ever successfully connected this tab session.
// Used to distinguish first-connect toast from reconnect toast.
const CONNECTED_EVER_KEY = '__claude_mcp_connected_ever__';

function isConnected(): boolean {
	return !!(globalThis as any)[CONNECTED_KEY];
}
function setConnected(v: boolean): void {
	(globalThis as any)[CONNECTED_KEY] = v;
}
function getLastReceived(): number {
	return ((globalThis as any)[LAST_RECV_KEY] as number) ?? 0;
}
function setLastReceived(t: number): void {
	(globalThis as any)[LAST_RECV_KEY] = t;
}
function isConnecting(): boolean {
	return !!(globalThis as any)[CONNECTING_KEY];
}
function setConnecting(v: boolean): void {
	(globalThis as any)[CONNECTING_KEY] = v;
}

const allHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	...componentHandlers,
	...trackHandlers,
	...viaHandlers,
	...netHandlers,
	...drcHandlers,
	...documentHandlers,
	...schComponentHandlers,
	...schWireHandlers,
	...schDocumentHandlers,
	...schSelectHandlers,
	...schPrimitiveHandlers,
	...libraryHandlers,
	...pourFillHandlers,
	...manufactureHandlers,
	...layerHandlers,
	...pcbPrimitiveHandlers,
	...editorHandlers,
	...fileManagerHandlers,
};

async function getInstanceInfo(): Promise<Record<string, any>> {
	const DOC_TYPE_NAMES: Record<number, string> = { 1: 'schematic', 3: 'pcb' };

	try {
		const [project, currentDoc, tree] = await Promise.all([
			eda.dmt_Project.getCurrentProjectInfo(),
			eda.dmt_SelectControl.getCurrentDocumentInfo(),
			eda.dmt_EditorControl.getSplitScreenTree(),
		]);

		const documents: Array<{ title: string; uuid: string }> = [];
		if (tree) {
			(function collectTabs(node: any): void {
				if (node.tabs) {
					for (const tab of node.tabs) {
						documents.push({ title: tab.title, uuid: tab.tabId });
					}
				}
				if (node.children) {
					for (const child of node.children) {
						collectTabs(child);
					}
				}
			})(tree);
		}

		// Runtime API returns more fields than the type declarations expose
		const proj = project as any;
		const doc = currentDoc as any;

		return {
			instanceId,
			// Prefer friendlyName (user-visible display name) over name (a URL
			// slug populated by the web backend but absent on desktop-local
			// projects). Both fields are declared on IDMT_ProjectItem in
			// pro-api/api-types.d.ts.
			projectName: proj?.friendlyName ?? proj?.name,
			currentDocument: doc?.tabId,
			documentType: doc?.documentType != null ? (DOC_TYPE_NAMES[doc.documentType] || `type_${doc.documentType}`) : undefined,
			documents,
		};
	} catch {
		return { instanceId };
	}
}

// Register the instance.getInfo handler alongside other handlers
allHandlers['instance.getInfo'] = async () => getInstanceInfo();

async function requireDocumentType(method: string): Promise<void> {
	const requiresPcb = method.startsWith('pcb.');
	const requiresSch = method.startsWith('sch.');
	if (!requiresPcb && !requiresSch) return;

	const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	const docType = doc?.documentType;

	if (requiresPcb && docType !== 3) {
		const current =
			docType === 1 ? ' (a schematic is currently open)' : docType != null ? '' : ' (no document is open)';
		throw new Error(
			`This tool requires a PCB document, but the currently active tab is not a PCB${current}. Pass a PCB document UUID as the "document" parameter, or use editor_open_document to switch.`,
		);
	}

	if (requiresSch && docType !== 1) {
		const current =
			docType === 3 ? ' (a PCB is currently open)' : docType != null ? '' : ' (no document is open)';
		throw new Error(
			`This tool requires a schematic document, but the currently active tab is not a schematic${current}. Pass a schematic document UUID as the "document" parameter, or use editor_open_document to switch.`,
		);
	}
}

function handleMessage(extensionUuid: string, event: MessageEvent<any>): void {
	let id: string | undefined;
	try {
		const message = typeof event.data === 'string' ? event.data : String(event.data);
		const request = JSON.parse(message);

		setLastReceived(Date.now());

		// Notifications from daemon (type field, no id).
		if (request.type === 'pong') return;
		if (request.type === 'hello') return; // just a "you're connected" signal
		if (request.type === 'shutdown') {
			setConnected(false);
			try {
				eda.sys_WebSocket.close(WS_ID, undefined, undefined, extensionUuid);
			} catch { /* already closed */ }
			// Reconnect loop in heartbeat / scheduleReconnect will pick this up.
			scheduleReconnect(extensionUuid);
			return;
		}

		id = request.id;
		const method: string = request.method;
		const params: Record<string, any> = request.params || {};

		const { fields, filter, limit, document, ...handlerParams } = params;
		const qp: QueryParams = { fields, filter, limit };

		const handler = allHandlers[method];
		if (!handler) {
			sendResponse(extensionUuid, id!, undefined, `Unknown method: ${method}. If you recently updated the MCP server, you may need to reinstall the EasyEDA extension as well.`);
			return;
		}

		// Auto-switch document if specified, then validate doc type, then run handler.
		const switchDoc: Promise<unknown> = document
			? (async () => {
				const [itemUuid, suffix] = document.split('@');
				if (!suffix) {
					return eda.dmt_EditorControl.openDocument(itemUuid);
				}
				const tree: any = await eda.dmt_EditorControl.getSplitScreenTree();
				let doctype: number | undefined;
				(function walk(node: any): void {
					if (doctype !== undefined) return;
					if (node?.tabs) {
						for (const t of node.tabs) {
							if (t.tabId === document) {
								doctype = t.data?.doctype;
								return;
							}
						}
					}
					if (node?.children) for (const c of node.children) walk(c);
				})(tree);
				if (doctype === 2) {
					return eda.lib_Symbol.openInEditor(itemUuid, suffix);
				}
				if (doctype === 4) {
					return eda.lib_Footprint.openInEditor(itemUuid, suffix);
				}
				return eda.dmt_EditorControl.openDocument(itemUuid);
			})()
			: Promise.resolve();

		switchDoc.then(
			() => requireDocumentType(method).then(
				() =>
					handler(handlerParams).then(
						(result) => sendResponse(extensionUuid, id!, applyQueryParams(result, qp)),
						(err: any) => {
							sendResponse(extensionUuid, id!, undefined, describeError(err));
						},
					),
				(err: any) => {
					sendResponse(extensionUuid, id!, undefined, describeError(err));
				},
			),
			(err: any) => {
				sendResponse(extensionUuid, id!, undefined, `Failed to switch to document "${document}": ${describeError(err)}`);
			},
		);
	} catch (err: any) {
		if (id) {
			sendResponse(extensionUuid, id, undefined, describeError(err));
		}
	}
}

function sendResponse(extensionUuid: string, id: string, result?: any, error?: string): void {
	const response: Record<string, any> = { id };
	if (error) {
		response.error = error;
	} else {
		response.result = result;
	}
	try {
		eda.sys_WebSocket.send(WS_ID, JSON.stringify(response), extensionUuid);
	} catch {
		handleConnectionLost(extensionUuid);
	}
}

function sendNotification(extensionUuid: string, type: string, data: any): void {
	try {
		eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type, data }), extensionUuid);
	} catch {
		handleConnectionLost(extensionUuid);
	}
}

/**
 * Push updated instance info to the bridge daemon.
 * Called when the active document changes, etc.
 */
async function pushInstanceInfo(extensionUuid: string): Promise<void> {
	if (!isConnected()) return;
	const info = await getInstanceInfo();
	sendNotification(extensionUuid, 'instanceInfo', info);
}

function handleConnectionLost(extensionUuid: string): void {
	setConnected(false);
	// Close the host-side registration before reconnecting. sys_WebSocket.register
	// is a no-op when a connection with this ID is still considered active, so
	// without this close a half-open socket (send threw, host still holds the
	// registration) would make every reconnect attempt silently do nothing.
	try {
		eda.sys_WebSocket.close(WS_ID, undefined, undefined, extensionUuid);
	} catch { /* already closed */ }
	scheduleReconnect(extensionUuid);
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

function connect(extensionUuid: string): void {
	if (isConnected() || isConnecting()) return;
	setConnecting(true);

	// Clear the connecting flag after 10s if the connection never completes
	// (sys_WebSocket.register fails silently if nothing is listening), and
	// schedule a retry — the daemon may simply not be up yet. Without this,
	// a failed INITIAL connect (e.g. EasyEDA started before the bridge
	// daemon) never retries: scheduleReconnect was previously only reachable
	// from paths that require a prior successful connection.
	setTimeout(() => {
		if (!isConnected()) {
			setConnecting(false);
			try {
				eda.sys_WebSocket.close(WS_ID, undefined, undefined, extensionUuid);
			} catch { /* never opened */ }
			scheduleReconnect(extensionUuid);
		}
	}, 10_000);

	const wasConnectedBefore = (globalThis as any)[CONNECTED_EVER_KEY] === true;

	try {
		eda.sys_WebSocket.register(
			WS_ID,
			wsUrl(),
			(event: MessageEvent<any>) => handleMessage(extensionUuid, event),
			() => {
				setConnecting(false);
				setConnected(true);
				setLastReceived(Date.now());
				(globalThis as any)[CONNECTED_EVER_KEY] = true;
				// Reset reconnect cadence so future drops get the eager 2s/5s retries
				// instead of skipping straight to the 15s steady-state.
				resetReconnectAttempts();
				// Push instance info after a short delay (let the daemon finish setup).
				setTimeout(() => pushInstanceInfo(extensionUuid), 200);
				// Surface a toast so the user knows we made it. Distinguish first
				// connect from a post-drop reconnect so the reconnect path doesn't
				// look like a fresh "yay, connected" event.
				eda.sys_Message.showToastMessage(
					wasConnectedBefore
						? `Reconnected to Claude bridge (instance: ${instanceId})`
						: `Connected to Claude bridge (instance: ${instanceId})`,
					ESYS_ToastMessageType.SUCCESS,
					4,
				);
			},
		);
	} catch {
		setConnecting(false);
		// register() threw synchronously — retry later rather than staying dead.
		scheduleReconnect(extensionUuid);
	}
}

export function connectToMcpServers(extensionUuid: string): void {
	connect(extensionUuid);
}

export function disconnectFromAllMcpServers(extensionUuid: string): void {
	try {
		eda.sys_WebSocket.close(WS_ID, undefined, undefined, extensionUuid);
	} catch { /* noop */ }
	setConnected(false);
	setConnecting(false);
}

export function getConnectedPortCount(): number {
	return isConnected() ? 1 : 0;
}

// Reconnect schedule: cap at 15s steady-state so any extension reconnects
// within 15s of a daemon (re)start. First two attempts are eager to handle
// the daemon-respawn case where the new daemon is already listening.
const RECONNECT_INITIAL_DELAYS_MS = [2_000, 5_000];
const RECONNECT_STEADY_MS = 15_000;
const RECONNECT_KEY = '__claude_mcp_reconnect_timer__';
const RECONNECT_CHECK_KEY = '__claude_mcp_reconnect_check_timer__';
const RECONNECT_ATTEMPT_KEY = '__claude_mcp_reconnect_attempt__';

function scheduleReconnect(extensionUuid: string): void {
	const g = globalThis as any;
	if (!g[LIVE_MODE_KEY]) return; // user disconnected — don't schedule
	if (g[RECONNECT_KEY]) return; // already scheduled

	const attempt = (g[RECONNECT_ATTEMPT_KEY] as number) ?? 0;
	const delay = attempt < RECONNECT_INITIAL_DELAYS_MS.length
		? RECONNECT_INITIAL_DELAYS_MS[attempt]
		: RECONNECT_STEADY_MS;
	g[RECONNECT_ATTEMPT_KEY] = attempt + 1;

	g[RECONNECT_KEY] = setTimeout(() => {
		g[RECONNECT_KEY] = null;
		// Re-check live mode here too: user may have disconnected during the wait.
		if (!g[LIVE_MODE_KEY] || isConnected()) return;
		connect(extensionUuid);
		// If still not connected after a moment, schedule the next retry.
		// Tracked separately so stopLiveMode can cancel this inner timer.
		g[RECONNECT_CHECK_KEY] = setTimeout(() => {
			g[RECONNECT_CHECK_KEY] = null;
			if (!g[LIVE_MODE_KEY]) return;
			if (!isConnected()) scheduleReconnect(extensionUuid);
		}, 1_500);
	}, delay);
}

function resetReconnectAttempts(): void {
	(globalThis as any)[RECONNECT_ATTEMPT_KEY] = 0;
}

// ---------------------------------------------------------------------------
// Heartbeat: detect dead connections by pinging when the daemon goes quiet.
// ---------------------------------------------------------------------------
const HEARTBEAT_INTERVAL_MS = 90_000;
const QUIET_THRESHOLD_MS = 60_000;
const DEAD_THRESHOLD_MS = 180_000;
const HEARTBEAT_TIMER_KEY = '__claude_mcp_heartbeat_timer__';

function runHeartbeat(extensionUuid: string): void {
	if (!isConnected()) return;
	const silenceMs = Date.now() - getLastReceived();

	if (silenceMs >= DEAD_THRESHOLD_MS) {
		setConnected(false);
		try {
			eda.sys_WebSocket.close(WS_ID, undefined, undefined, extensionUuid);
		} catch { /* already gone */ }
		eda.sys_Message.showToastMessage(
			'Lost connection to Claude bridge daemon — reconnecting...',
			ESYS_ToastMessageType.WARNING,
			5,
		);
		scheduleReconnect(extensionUuid);
	} else if (silenceMs >= QUIET_THRESHOLD_MS) {
		try {
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'ping' }), extensionUuid);
		} catch {
			handleConnectionLost(extensionUuid);
		}
	}
}

function startHeartbeat(extensionUuid: string): void {
	const g = globalThis as any;
	if (g[HEARTBEAT_TIMER_KEY]) {
		clearInterval(g[HEARTBEAT_TIMER_KEY]);
	}
	g[HEARTBEAT_TIMER_KEY] = setInterval(() => runHeartbeat(extensionUuid), HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
	const g = globalThis as any;
	if (g[HEARTBEAT_TIMER_KEY]) {
		clearInterval(g[HEARTBEAT_TIMER_KEY]);
		g[HEARTBEAT_TIMER_KEY] = null;
	}
}

// ---------------------------------------------------------------------------
// Live mode: stays as a top-level "auto-connect on extension load" toggle.
// With a single fixed-port daemon there's nothing to scan for, but reconnect
// scheduling provides the auto-reconnect behavior live mode used to offer.
// ---------------------------------------------------------------------------
const LIVE_MODE_KEY = '__claude_mcp_live_mode__';
const LIVE_UUID_KEY = '__claude_mcp_live_uuid__';

export function startLiveMode(extensionUuid: string): void {
	const g = globalThis as any;
	g[LIVE_MODE_KEY] = true;
	g[LIVE_UUID_KEY] = extensionUuid;
	setBridgeLogEmitter((message) => sendNotification(extensionUuid, 'log', { message }));
	resetReconnectAttempts();
	startHeartbeat(extensionUuid);
	connect(extensionUuid);
}

export function stopLiveMode(): void {
	const g = globalThis as any;
	g[LIVE_MODE_KEY] = false;
	if (g[RECONNECT_KEY]) {
		clearTimeout(g[RECONNECT_KEY]);
		g[RECONNECT_KEY] = null;
	}
	if (g[RECONNECT_CHECK_KEY]) {
		clearTimeout(g[RECONNECT_CHECK_KEY]);
		g[RECONNECT_CHECK_KEY] = null;
	}
	stopHeartbeat();
	setBridgeLogEmitter(null);
}

export function isLiveModeActive(): boolean {
	return !!(globalThis as any)[LIVE_MODE_KEY];
}
