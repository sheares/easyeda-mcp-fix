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

const PORT_RANGE_START = 15168;
const PORT_RANGE_SIZE = 40;

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

function wsIdForPort(port: number): string {
	return `mcp-bridge-${port}`;
}

function wsUrlForPort(port: number): string {
	return `ws://localhost:${port}?instanceId=${instanceId}`;
}

// Map<port, agentId> — tracks which agent is connected on each port
const PORTS_KEY = '__claude_mcp_connected_ports__';
const connectedPorts: Map<number, string> = (globalThis as any)[PORTS_KEY] || ((globalThis as any)[PORTS_KEY] = new Map<number, string>());

// Map<port, timestamp> — last time we received any message from each bridge
const LAST_RECV_KEY = '__claude_mcp_last_received__';
const lastReceivedTime: Map<number, number> = (globalThis as any)[LAST_RECV_KEY] || ((globalThis as any)[LAST_RECV_KEY] = new Map<number, number>());

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
			projectName: proj?.name ?? proj?.title,
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

function handleMessage(extensionUuid: string, port: number, event: MessageEvent<any>): void {
	let id: string | undefined;
	try {
		const message = typeof event.data === 'string' ? event.data : String(event.data);
		const request = JSON.parse(message);

		// Record that we received traffic from this bridge (for keepalive)
		lastReceivedTime.set(port, Date.now());

		// Handle notifications from MCP server (type field, no id)
		if (request.type === 'pong') {
			// Keepalive response — lastReceivedTime already updated above
			return;
		}

		if (request.type === 'hello') {
			// Server sends its agentId on connection — store it for dedup
			connectedPorts.set(port, request.agentId || '');
			return;
		}

		if (request.type === 'newAgent') {
			// A peer MCP server notified us (via the server we're connected to)
			// that a new agent started — connect to it immediately
			const newPort = request.port as number;
			if (newPort && !connectedPorts.has(newPort)) {
				connectToSinglePort(extensionUuid, newPort);
			}
			return;
		}

		if (request.type === 'shutdown') {
			connectedPorts.delete(port);
			adjustScanInterval();
			try {
				eda.sys_WebSocket.close(wsIdForPort(port), undefined, undefined, extensionUuid);
			} catch {
				// Already closed
			}
			eda.sys_Message.showToastMessage(
				`Claude MCP Server on port ${port} shut down`,
				ESYS_ToastMessageType.INFO,
				3,
			);
			return;
		}

		id = request.id;
		const method: string = request.method;
		const params: Record<string, any> = request.params || {};

		// Extract query params and document before dispatching to handler
		const { fields, filter, limit, document, ...handlerParams } = params;
		const qp: QueryParams = { fields, filter, limit };

		const handler = allHandlers[method];
		if (!handler) {
			sendResponse(extensionUuid, port, id!, undefined, `Unknown method: ${method}. If you recently updated the MCP server, you may need to reinstall the EasyEDA extension as well.`);
			return;
		}

		// Auto-switch document if specified, then validate doc type, then run handler
		// Strip @projectUuid suffix if present — openDocument only accepts the document UUID
		const docUuid = document ? document.split('@')[0] : undefined;
		const switchDoc = docUuid
			? eda.dmt_EditorControl.openDocument(docUuid)
			: Promise.resolve();

		switchDoc.then(
			() => requireDocumentType(method).then(
				() =>
					handler(handlerParams).then(
						(result) => sendResponse(extensionUuid, port, id!, applyQueryParams(result, qp)),
						(err: any) => {
							const errorMsg = err instanceof Error ? err.message : String(err);
							sendResponse(extensionUuid, port, id!, undefined, errorMsg);
						},
					),
				(err: any) => {
					const errorMsg = err instanceof Error ? err.message : String(err);
					sendResponse(extensionUuid, port, id!, undefined, errorMsg);
				},
			),
			(err: any) => {
				const errorMsg = err instanceof Error ? err.message : String(err);
				sendResponse(extensionUuid, port, id!, undefined, `Failed to switch to document "${docUuid}": ${errorMsg}`);
			},
		);
	} catch (err: any) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (id) {
			sendResponse(extensionUuid, port, id, undefined, errorMsg);
		}
	}
}

function sendResponse(extensionUuid: string, port: number, id: string, result?: any, error?: string): void {
	const response: Record<string, any> = { id };
	if (error) {
		response.error = error;
	} else {
		response.result = result;
	}
	try {
		eda.sys_WebSocket.send(wsIdForPort(port), JSON.stringify(response), extensionUuid);
	} catch {
		// Send failed — connection is dead, remove from tracked ports
		connectedPorts.delete(port);
		adjustScanInterval();
	}
}

function sendNotification(extensionUuid: string, port: number, type: string, data: any): void {
	try {
		eda.sys_WebSocket.send(wsIdForPort(port), JSON.stringify({ type, data }), extensionUuid);
	} catch {
		connectedPorts.delete(port);
		adjustScanInterval();
	}
}

/**
 * Push updated instance info to all connected MCP servers.
 * Called when the active document changes, etc.
 */
async function pushInstanceInfoToAll(extensionUuid: string): Promise<void> {
	const info = await getInstanceInfo();
	for (const port of connectedPorts.keys()) {
		sendNotification(extensionUuid, port, 'instanceInfo', info);
	}
}

let pendingConnectionPorts: number[] = [];
let connectionToastTimer: ReturnType<typeof setTimeout> | null = null;

function flushConnectionToast(): void {
	if (pendingConnectionPorts.length === 0) return;
	const ports = pendingConnectionPorts;
	pendingConnectionPorts = [];
	connectionToastTimer = null;
	const portList = ports.map(String).join(', ');
	const msg =
		ports.length === 1
			? `Connected to Claude MCP Server on port ${portList} (instance: ${instanceId})`
			: `Connected to ${ports.length} Claude MCP Servers on ports ${portList} (instance: ${instanceId})`;
	eda.sys_Message.showToastMessage(msg, ESYS_ToastMessageType.SUCCESS, 5);
}

let noNewServersTimer: ReturnType<typeof setTimeout> | null = null;

// Ports we're currently in the process of connecting to (prevents duplicate
// attempts when multiple peers notify us about the same new agent).
const CONNECTING_KEY = '__claude_mcp_connecting_ports__';
const connectingPorts: Set<number> = (globalThis as any)[CONNECTING_KEY] || ((globalThis as any)[CONNECTING_KEY] = new Set<number>());

/**
 * Try connecting to a single MCP server port.
 * Used both by full scan and by peer newAgent notifications.
 */
function connectToSinglePort(extensionUuid: string, port: number): void {
	if (connectedPorts.has(port) || connectingPorts.has(port)) return;
	connectingPorts.add(port);

	// Clear the connecting flag after 10s if the connection never completes
	// (e.g. no server on that port — sys_WebSocket.register fails silently)
	setTimeout(() => connectingPorts.delete(port), 10_000);

	const wsId = wsIdForPort(port);
	const wsUrl = wsUrlForPort(port);
	eda.sys_WebSocket.register(
		wsId,
		wsUrl,
		(event: MessageEvent<any>) => handleMessage(extensionUuid, port, event),
		() => {
			connectingPorts.delete(port);
			// agentId will be set when we receive the 'hello' message;
			// store empty string as placeholder until then
			connectedPorts.set(port, '');
			lastReceivedTime.set(port, Date.now());
			pendingConnectionPorts.push(port);
			if (connectionToastTimer !== null) {
				clearTimeout(connectionToastTimer);
			}
			connectionToastTimer = setTimeout(flushConnectionToast, 500);

			// Cancel the "no new servers" toast since we found one
			if (noNewServersTimer !== null) {
				clearTimeout(noNewServersTimer);
				noNewServersTimer = null;
			}

			// Push instance info to the newly connected server after a short delay
			// (give the server a moment to finish its connection setup)
			setTimeout(() => pushInstanceInfoToAll(extensionUuid), 200);

			// Connection count changed — adjust scan interval if in live mode
			adjustScanInterval();
		},
	);
}

export function connectToMcpServers(extensionUuid: string): void {
	const countBefore = connectedPorts.size;

	for (let i = 0; i < PORT_RANGE_SIZE; i++) {
		connectToSinglePort(extensionUuid, PORT_RANGE_START + i);
	}

	// If no new connections arrive within 2s, show a "no new servers" toast
	if (countBefore > 0) {
		if (noNewServersTimer !== null) {
			clearTimeout(noNewServersTimer);
		}
		noNewServersTimer = setTimeout(() => {
			noNewServersTimer = null;
			if (connectedPorts.size === countBefore) {
				eda.sys_Message.showToastMessage(
					`No new servers found (${countBefore} already connected)`,
					ESYS_ToastMessageType.INFO,
					3,
				);
			}
		}, 2000);
	}
}

export function disconnectFromAllMcpServers(extensionUuid: string): void {
	for (const port of connectedPorts.keys()) {
		try {
			eda.sys_WebSocket.close(wsIdForPort(port), undefined, undefined, extensionUuid);
		} catch {
			// Ignore close errors
		}
	}
	connectedPorts.clear();
	connectingPorts.clear();
	lastReceivedTime.clear();
}

export function getConnectedPortCount(): number {
	return connectedPorts.size;
}

export function getConnectedPorts(): number[] {
	return [...connectedPorts.keys()];
}

// Keepalive: detect dead connections by pinging bridges that have gone quiet.
// Checks run every HEARTBEAT_INTERVAL_MS. If no message received in
// QUIET_THRESHOLD_MS, send a ping. If still no message after DEAD_THRESHOLD_MS
// total silence, drop the connection. DEAD - QUIET must be > HEARTBEAT so the
// bridge gets at least one full interval to respond before being dropped.
const HEARTBEAT_INTERVAL_MS = 90_000;
const QUIET_THRESHOLD_MS = 60_000;
const DEAD_THRESHOLD_MS = 180_000;
const HEARTBEAT_TIMER_KEY = '__claude_mcp_heartbeat_timer__';

function runHeartbeat(extensionUuid: string): void {
	const now = Date.now();
	for (const port of [...connectedPorts.keys()]) {
		const lastRecv = lastReceivedTime.get(port) ?? 0;
		const silenceMs = now - lastRecv;

		if (silenceMs >= DEAD_THRESHOLD_MS) {
			// No response to our ping — connection is dead
			connectedPorts.delete(port);
			lastReceivedTime.delete(port);
			try {
				eda.sys_WebSocket.close(wsIdForPort(port), undefined, undefined, extensionUuid);
			} catch {
				// Already gone
			}
			eda.sys_Message.showToastMessage(
				`Lost connection to Claude MCP Server on port ${port}`,
				ESYS_ToastMessageType.WARNING,
				5,
			);
			adjustScanInterval();
		} else if (silenceMs >= QUIET_THRESHOLD_MS) {
			// Bridge has been quiet — send a ping to check
			try {
				eda.sys_WebSocket.send(wsIdForPort(port), JSON.stringify({ type: 'ping' }), extensionUuid);
			} catch {
				// Send failed — connection already dead
				connectedPorts.delete(port);
				lastReceivedTime.delete(port);
				adjustScanInterval();
			}
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

// Live mode: periodic background scanning for new MCP servers
// Adaptive intervals: scan eagerly (30s) when no connections, slowly (3min)
// when connected (peer notifications handle the fast path).
const LIVE_MODE_KEY = '__claude_mcp_live_mode__';
const LIVE_TIMER_KEY = '__claude_mcp_live_timer__';
const LIVE_UUID_KEY = '__claude_mcp_live_uuid__';
const SCAN_INTERVAL_EAGER_MS = 30_000;   // No connections — scan frequently
const SCAN_INTERVAL_RELAXED_MS = 180_000; // Has connections — peer notifications cover fast discovery

function currentScanInterval(): number {
	return connectedPorts.size > 0 ? SCAN_INTERVAL_RELAXED_MS : SCAN_INTERVAL_EAGER_MS;
}

/**
 * Re-evaluate and adjust the scan interval based on current connection count.
 * Called when connections are gained or lost.
 */
function adjustScanInterval(): void {
	const g = globalThis as any;
	if (!g[LIVE_MODE_KEY] || !g[LIVE_UUID_KEY]) return;

	const extensionUuid = g[LIVE_UUID_KEY] as string;
	if (g[LIVE_TIMER_KEY]) {
		clearInterval(g[LIVE_TIMER_KEY]);
	}
	g[LIVE_TIMER_KEY] = setInterval(() => {
		connectToMcpServers(extensionUuid);
	}, currentScanInterval());
}

export function startLiveMode(extensionUuid: string): void {
	const g = globalThis as any;
	if (g[LIVE_TIMER_KEY]) {
		clearInterval(g[LIVE_TIMER_KEY]);
	}
	g[LIVE_MODE_KEY] = true;
	g[LIVE_UUID_KEY] = extensionUuid;
	g[LIVE_TIMER_KEY] = setInterval(() => {
		connectToMcpServers(extensionUuid);
	}, currentScanInterval());
	startHeartbeat(extensionUuid);
}

export function stopLiveMode(): void {
	const g = globalThis as any;
	g[LIVE_MODE_KEY] = false;
	if (g[LIVE_TIMER_KEY]) {
		clearInterval(g[LIVE_TIMER_KEY]);
		g[LIVE_TIMER_KEY] = null;
	}
	stopHeartbeat();
}

export function isLiveModeActive(): boolean {
	return !!(globalThis as any)[LIVE_MODE_KEY];
}
