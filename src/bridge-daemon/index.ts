/**
 * EasyEDA bridge daemon (thin-client architecture).
 *
 * Runs as a long-lived process shared by all MCP server instances on the
 * machine. Owns one WebSocket server (for browser-side EasyEDA extensions)
 * and one Unix domain socket server (for MCP server clients).
 *
 * The daemon is the source of truth for the tool surface. MCP servers are
 * thin proxies: on connect they call list_tools, register each via the MCP
 * SDK, and forward call_tool over the UDS. On daemon restart, the MCP server
 * reconnects, re-fetches, diffs, and fires notifications/tools/list_changed
 * for the agent to pick up.
 *
 * Singleton: only one daemon per state directory; second start exits 0.
 * Idle exit: shuts down N seconds after the last MCP client disconnects
 * (default 5s; set EDA_BRIDGE_IDLE_EXIT_SEC=0 for immediate, large number to
 * effectively disable).
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { createServer as createNetServer, type Socket as NetSocket } from 'node:net';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
	socketPath,
	pidPath,
	stateDir,
	wsPort,
	idleExitSeconds,
	type ClientToDaemon,
	type DaemonToClient,
} from './protocol';
import type { InstanceInfo, ToolContext } from './types';
import { ToolRegistry } from './registry';

const ALLOWED_ORIGIN_PATTERNS = [
	/^https?:\/\/([a-z0-9-]+\.)*easyeda\.com(:\d+)?$/,
	/^https?:\/\/([a-z0-9-]+\.)*lceda\.cn(:\d+)?$/,
	// EasyEDA Pro desktop app (Electron). Renderer is loaded from the fake
	// scheme/host https://client (visible as `https_client_0.indexeddb` in
	// ~/.config/EasyEDA-Pro/cache.arm64.3/IndexedDB/). The UA is identifiable
	// (`EasyEDAPro/<version> ... Electron/<version>`) but we can't see UAs in
	// verifyClient cheaply; the bare `https://client` origin is a hardcoded
	// Electron-only string with no path/port, so accepting it exactly is safe.
	/^https:\/\/client$/,
];

function isAllowedOrigin(origin: string | undefined): boolean {
	if (!origin) return false;
	if (process.env.EDA_WS_ALLOW_ALL_ORIGINS === '1') return true;
	return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

const EXTENSION_REQUEST_TIMEOUT_MS = 45000;

interface Extension {
	ws: WebSocket;
	info: InstanceInfo;
}

interface McpClient {
	id: string;
	sock: NetSocket;
	buffer: string;
}

interface PendingExtensionRequest {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	instanceId: string;
}

const extensions = new Map<string, Extension>(); // instanceId → Extension
const clients = new Map<string, McpClient>(); // clientId → McpClient
const pendingExtRequests = new Map<string, PendingExtensionRequest>(); // internalId → pending

let extRequestIdCounter = 0;
function nextExtRequestId(): string {
	return `d${++extRequestIdCounter}`;
}

let idleExitTimer: ReturnType<typeof setTimeout> | null = null;

function log(...args: unknown[]): void {
	const ts = new Date().toISOString();
	console.error(`[${ts}] [daemon]`, ...args);
}

// -----------------------------------------------------------------------------
// Tool context: how tool handlers reach the rest of the world.
// -----------------------------------------------------------------------------

function snapshotInstances(): InstanceInfo[] {
	return Array.from(extensions.values())
		.map((e) => ({ ...e.info }))
		.sort((a, b) => b.connectedAt - a.connectedAt);
}

function formatInstanceList(instances: InstanceInfo[]): string {
	return instances
		.map((info) => {
			const parts = [`  - ${info.instanceId}`];
			if (info.projectName) parts.push(`project: "${info.projectName}"`);
			if (info.currentDocument) {
				parts.push(`active: "${info.currentDocument}" (${info.documentType || 'unknown'})`);
			}
			return parts.join(' | ');
		})
		.join('\n');
}

function resolveExtension(instanceId: string | undefined): Extension {
	if (instanceId) {
		const ext = extensions.get(instanceId);
		if (!ext || ext.ws.readyState !== WebSocket.OPEN) {
			const available = snapshotInstances();
			const listText = available.length > 0
				? `\n\nConnected instances:\n${formatInstanceList(available)}`
				: '\n\nNo instances are currently connected.';
			throw new Error(`Instance "${instanceId}" is not connected.${listText}`);
		}
		return ext;
	}

	if (extensions.size === 0) {
		throw new Error('EDA Pro Extension is not connected. Please open EDA Pro and click "Connect Claude" first.');
	}
	if (extensions.size === 1) {
		const [, only] = extensions.entries().next().value!;
		if (only.ws.readyState !== WebSocket.OPEN) {
			throw new Error('EDA Pro Extension is not connected. Please open EDA Pro and click "Connect Claude" first.');
		}
		return only;
	}
	throw new Error(
		`Multiple EasyEDA instances are connected. Specify instance_id to choose one.\n\nConnected instances:\n${formatInstanceList(snapshotInstances())}\n\nUse list_instances for full details, or pass the instance_id of the instance you want to interact with.`,
	);
}

function sendToExtensionRaw(ext: Extension, method: string, params: Record<string, unknown>): Promise<unknown> {
	const id = nextExtRequestId();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingExtRequests.delete(id);
			reject(new Error(`Request timed out after ${EXTENSION_REQUEST_TIMEOUT_MS}ms: ${method}`));
		}, EXTENSION_REQUEST_TIMEOUT_MS);
		pendingExtRequests.set(id, { resolve, reject, timer, instanceId: ext.info.instanceId });
		try {
			ext.ws.send(JSON.stringify({ id, method, params }));
		} catch (err) {
			clearTimeout(timer);
			pendingExtRequests.delete(id);
			reject(err as Error);
		}
	});
}

const toolContext: ToolContext = {
	async sendToExtension(method, params = {}): Promise<unknown> {
		const { instance_id, ...forwardParams } = params;
		const ext = resolveExtension(instance_id as string | undefined);
		return sendToExtensionRaw(ext, method, forwardParams);
	},
	getConnectedInstances: snapshotInstances,
	getConnectedCount: () => extensions.size,
	isConnected: () => extensions.size > 0,
	getPort: () => wsPort(),
	refreshAllInstanceInfo,
	requestRestart: (delayMs = 100) => {
		setTimeout(() => shutdown(0), delayMs).unref();
	},
};

// Build registry up front so list_tools is cheap.
const registry = new ToolRegistry(toolContext);

// -----------------------------------------------------------------------------
// MCP client (UDS) handling
// -----------------------------------------------------------------------------

function sendToClient(client: McpClient, msg: DaemonToClient): void {
	try {
		client.sock.write(JSON.stringify(msg) + '\n');
	} catch (err: any) {
		// EPIPE/ECONNRESET = client closed mid-write (normal). Log anything else.
		if (err?.code !== 'EPIPE' && err?.code !== 'ECONNRESET') {
			log(`Failed to write to client ${client.id}:`, err);
		}
	}
}

function handleClientMessage(client: McpClient, raw: string): void {
	let msg: ClientToDaemon;
	try {
		msg = JSON.parse(raw) as ClientToDaemon;
	} catch (err) {
		log(`Bad NDJSON from client ${client.id}:`, err);
		return;
	}

	switch (msg.kind) {
		case 'list_tools':
			sendToClient(client, {
				kind: 'list_tools_result',
				id: msg.id,
				tools: registry.listDescriptors(),
			});
			break;
		case 'call_tool':
			(async () => {
				try {
					const result = await registry.dispatch(msg.name, msg.arguments);
					sendToClient(client, { kind: 'call_tool_result', id: msg.id, result });
				} catch (err: any) {
					sendToClient(client, {
						kind: 'call_tool_result',
						id: msg.id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			})();
			break;
		default: {
			const _exhaustive: never = msg;
			log(`Unknown message kind from client ${client.id}:`, _exhaustive);
		}
	}
}

function disconnectClient(client: McpClient): void {
	clients.delete(client.id);
	log(`Client ${client.id} disconnected (${clients.size} remaining)`);
	scheduleIdleExitCheck();
}

// -----------------------------------------------------------------------------
// Extension (WS) handling
// -----------------------------------------------------------------------------

function updateInstanceInfo(instanceId: string, data: Record<string, unknown>): void {
	const ext = extensions.get(instanceId);
	if (!ext) return;
	ext.info.projectName = data.projectName as string | undefined;
	ext.info.currentDocument = data.currentDocument as string | undefined;
	ext.info.documentType = data.documentType as string | undefined;
	ext.info.documents = data.documents as Array<{ title: string; uuid: string }> | undefined;
}

function handleExtensionMessage(instanceId: string, raw: string): void {
	let msg: any;
	try {
		msg = JSON.parse(raw);
	} catch (err) {
		log(`Bad JSON from extension ${instanceId}:`, err);
		return;
	}

	if (msg.type === 'ping') {
		const ext = extensions.get(instanceId);
		if (ext && ext.ws.readyState === WebSocket.OPEN) {
			ext.ws.send(JSON.stringify({ type: 'pong' }));
		}
		return;
	}

	if (msg.type === 'instanceInfo') {
		updateInstanceInfo(instanceId, msg.data || {});
		return;
	}

	// Response to a prior RPC. id is the daemon-internal id.
	const id: string = msg.id;
	const p = pendingExtRequests.get(id);
	if (!p) return;
	clearTimeout(p.timer);
	pendingExtRequests.delete(id);
	if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
	else p.resolve(msg.result);
}

async function requestInstanceInfo(instanceId: string): Promise<void> {
	const ext = extensions.get(instanceId);
	if (!ext || ext.ws.readyState !== WebSocket.OPEN) return;
	try {
		const result = await sendToExtensionRaw(ext, 'instance.getInfo', {});
		updateInstanceInfo(instanceId, (result as Record<string, unknown>) || {});
	} catch {
		// Non-critical; info will be updated when the extension pushes instanceInfo.
	}
}

async function refreshAllInstanceInfo(): Promise<void> {
	await Promise.allSettled(Array.from(extensions.keys()).map((id) => requestInstanceInfo(id)));
}

// -----------------------------------------------------------------------------
// Idle exit
// -----------------------------------------------------------------------------

function scheduleIdleExitCheck(): void {
	if (clients.size > 0) {
		if (idleExitTimer !== null) {
			clearTimeout(idleExitTimer);
			idleExitTimer = null;
		}
		return;
	}
	if (idleExitTimer !== null) return;
	const sec = idleExitSeconds();
	idleExitTimer = setTimeout(() => {
		idleExitTimer = null;
		if (clients.size === 0) {
			log(`Idle for ${sec}s with no MCP clients — shutting down.`);
			shutdown(0);
		}
	}, sec * 1000);
}

function cancelIdleExit(): void {
	if (idleExitTimer !== null) {
		clearTimeout(idleExitTimer);
		idleExitTimer = null;
	}
}

// -----------------------------------------------------------------------------
// Servers
// -----------------------------------------------------------------------------

let wss: WebSocketServer | null = null;
let uds: ReturnType<typeof createNetServer> | null = null;

function startWebSocketServer(): Promise<void> {
	return new Promise((resolve, reject) => {
		const port = wsPort();
		const server = new WebSocketServer({
			port,
			host: '127.0.0.1',
			verifyClient: (info: { origin: string; req: IncomingMessage; secure: boolean }) => {
				const remote = info.req.socket.remoteAddress ?? '?';
				const ua = info.req.headers['user-agent'] ?? '?';
				const allowed = isAllowedOrigin(info.origin);
				log(`WS handshake: origin=${info.origin || '(none)'} remote=${remote} ua=${ua} -> ${allowed ? 'accepted' : 'rejected'}`);
				return allowed;
			},
		});

		server.on('listening', () => {
			log(`WS listening on 127.0.0.1:${port}`);
			resolve();
		});

		server.on('error', (err) => {
			log('WS error:', err);
			reject(err);
		});

		server.on('connection', (ws, req) => {
			const url = new URL(req.url || '/', `http://localhost:${port}`);
			const instanceId = url.searchParams.get('instanceId');
			if (!instanceId) {
				log('Extension connected without instanceId, rejecting');
				ws.close(4001, 'instanceId query parameter required');
				return;
			}
			// Validate shape — extension always sends lowercase hex. Reject
			// anything else so newlines/control chars can't be smuggled into
			// log lines, Map keys, or error messages.
			if (!/^[a-f0-9]{1,32}$/.test(instanceId)) {
				log('Extension connected with malformed instanceId, rejecting');
				ws.close(4002, 'instanceId must be 1-32 lowercase hex chars');
				return;
			}

			const existing = extensions.get(instanceId);
			if (existing) {
				try { existing.ws.close(); } catch { /* noop */ }
				extensions.delete(instanceId);
			}

			const ext: Extension = { ws, info: { instanceId, connectedAt: Date.now() } };
			extensions.set(instanceId, ext);
			log(`Extension connected (instance: ${instanceId})`);

			ws.on('message', (data) => handleExtensionMessage(instanceId, data.toString()));

			ws.on('close', () => {
				log(`Extension disconnected (instance: ${instanceId})`);
				extensions.delete(instanceId);
				for (const [id, p] of pendingExtRequests) {
					if (p.instanceId === instanceId) {
						clearTimeout(p.timer);
						pendingExtRequests.delete(id);
						p.reject(new Error(`EDA Pro Extension disconnected (instance: ${instanceId})`));
					}
				}
			});

			ws.on('error', (err) => {
				log(`Extension WS error (instance: ${instanceId}):`, err);
			});

			ws.send(JSON.stringify({ type: 'hello', agentId: 'daemon' }));
			requestInstanceInfo(instanceId).catch(() => { /* non-critical */ });
		});

		wss = server;
	});
}

function startUdsServer(sockPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const server = createNetServer((sock) => {
			const client: McpClient = {
				id: randomBytes(4).toString('hex'),
				sock,
				buffer: '',
			};
			clients.set(client.id, client);
			cancelIdleExit();
			log(`Client ${client.id} connected (${clients.size} total)`);

			sock.setEncoding('utf8');
			sock.on('data', (chunk: string) => {
				client.buffer += chunk;
				let nl: number;
				while ((nl = client.buffer.indexOf('\n')) !== -1) {
					const line = client.buffer.slice(0, nl);
					client.buffer = client.buffer.slice(nl + 1);
					if (line.length > 0) handleClientMessage(client, line);
				}
			});

			sock.on('close', () => disconnectClient(client));
			sock.on('error', (err: any) => {
				if (err?.code !== 'EPIPE' && err?.code !== 'ECONNRESET') {
					log(`Client ${client.id} socket error:`, err);
				}
			});
		});

		server.on('error', (err) => reject(err));
		server.listen(sockPath, () => {
			log(`UDS listening at ${sockPath}`);
			startUdsFileMonitor(sockPath);
			resolve();
		});

		uds = server;
	});
}

// Safety net: if our UDS file gets unlinked (or replaced) out from under us,
// new clients can no longer reach us via the well-known path. The process is
// still alive holding the WS port, so a fresh daemon spawn would EADDRINUSE
// and crash, leaving the system wedged. Detect the situation and exit so a
// new daemon can bind cleanly.
//
// 5s polling cadence + 1s grace before exit caps thrash if something is
// actively deleting the file in a loop.
//
// Key is dev:ino, not ino alone — ino is only unique within a filesystem, so if
// the state dir ever lives on a different mount than something with a colliding
// inode number, bare ino comparison could spuriously match.
let udsInodeKey: string | null = null;
let udsMonitorInterval: ReturnType<typeof setInterval> | null = null;
let udsMonitorExitTimer: ReturnType<typeof setTimeout> | null = null;

function startUdsFileMonitor(sockPath: string): void {
	try {
		const st = statSync(sockPath);
		udsInodeKey = `${st.dev}:${st.ino}`;
	} catch (err) {
		log('UDS monitor: initial stat failed, skipping monitor:', err);
		return;
	}

	udsMonitorInterval = setInterval(() => {
		if (shuttingDown || udsMonitorExitTimer) return;
		let currentKey: string | null = null;
		try {
			const st = statSync(sockPath);
			currentKey = `${st.dev}:${st.ino}`;
		} catch {
			currentKey = null;
		}
		if (currentKey === udsInodeKey) return;

		log(
			`UDS file at ${sockPath} disappeared or replaced ` +
			`(expected inode ${udsInodeKey}, found ${currentKey ?? 'missing'}). ` +
			`Self-terminating in 1s so a fresh daemon can take over.`,
		);
		udsMonitorExitTimer = setTimeout(() => shutdown(2), 1000);
		udsMonitorExitTimer.unref();
	}, 5000);
	udsMonitorInterval.unref();
}

function stopUdsFileMonitor(): void {
	if (udsMonitorInterval) {
		clearInterval(udsMonitorInterval);
		udsMonitorInterval = null;
	}
	if (udsMonitorExitTimer) {
		clearTimeout(udsMonitorExitTimer);
		udsMonitorExitTimer = null;
	}
}

async function bindUdsWithSingletonCheck(): Promise<void> {
	const sockPath = socketPath();

	try {
		await startUdsServer(sockPath);
		return;
	} catch (err: any) {
		if (err?.code !== 'EADDRINUSE') throw err;
	}

	const alive = await probeAlive(sockPath);
	if (alive) {
		log(`Another daemon already running at ${sockPath} — exiting.`);
		process.exit(0);
	}

	log(`Stale socket at ${sockPath} — unlinking and retrying.`);
	try { await unlink(sockPath); } catch { /* noop */ }
	await startUdsServer(sockPath);
}

function probeAlive(path: string, timeoutMs = 300): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = createConnection(path);
		let settled = false;
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* noop */ }
			resolve(ok);
		};
		const timer = setTimeout(() => done(false), timeoutMs);
		sock.once('connect', () => { clearTimeout(timer); done(true); });
		sock.once('error', () => { clearTimeout(timer); done(false); });
	});
}

// -----------------------------------------------------------------------------
// Shutdown
// -----------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(code: number): void {
	if (shuttingDown) return;
	shuttingDown = true;

	stopUdsFileMonitor();

	for (const ext of extensions.values()) {
		try {
			if (ext.ws.readyState === WebSocket.OPEN) {
				ext.ws.send(JSON.stringify({ type: 'shutdown', agentId: 'daemon' }));
			}
			ext.ws.close();
		} catch { /* noop */ }
	}
	extensions.clear();

	for (const client of clients.values()) {
		try { client.sock.destroy(); } catch { /* noop */ }
	}
	clients.clear();

	const done = () => {
		unlink(socketPath()).catch(() => { /* noop */ });
		unlink(pidPath()).catch(() => { /* noop */ });
		process.exit(code);
	};

	let waiting = 0;
	if (wss) {
		waiting++;
		wss.close(() => { if (--waiting === 0) done(); });
	}
	if (uds) {
		waiting++;
		uds.close(() => { if (--waiting === 0) done(); });
	}
	if (waiting === 0) done();

	setTimeout(() => process.exit(code), 2000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
	await mkdir(stateDir(), { recursive: true });
	await bindUdsWithSingletonCheck();
	await startWebSocketServer();
	await writeFile(pidPath(), String(process.pid));
	log(`Daemon started (pid ${process.pid}, idle-exit ${idleExitSeconds()}s, tools=${registry.listDescriptors().length})`);
	scheduleIdleExitCheck();
}

main().catch((err) => {
	log('Fatal:', err);
	process.exit(1);
});
