/**
 * End-to-end tests for the bridge daemon, thin-client architecture.
 *
 * Each test spawns a fresh daemon in a tmp state dir on a unique port to
 * avoid colliding with the user's running 15168 port or with other tests.
 * The daemon is run via ts-node so we don't need to pre-compile.
 *
 * The daemon's UDS protocol is exercised directly (NDJSON) via MockMcpClient;
 * a MockExtension talks WS+JSON like a real EasyEDA browser extension would.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket as NetSocket } from 'node:net';
import { mkdtemp, rm, access, unlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { WebSocket } from 'ws';

const DAEMON_SRC = resolvePath(__dirname, '..', 'src', 'bridge-daemon', 'index.ts');

interface Harness {
	stateDir: string;
	wsPort: number;
	sockPath: string;
	daemon: ChildProcess;
	cleanup: () => Promise<void>;
}

// Random port per test so a stale daemon leaked from a prior crashed run
// (which would hold a deterministic sequential port) can't predictably block
// subsequent test runs. Range chosen to avoid common dev-server ports.
function nextPort(): number {
	return 30000 + Math.floor(Math.random() * 20000);
}

async function startDaemon(opts: { idleExitSec?: number; env?: Record<string, string> } = {}): Promise<Harness> {
	const stateDir = await mkdtemp(join(tmpdir(), 'easyeda-bridge-test-'));
	const wsPort = nextPort();
	const sockPath = join(stateDir, 'bridge.sock');

	const env = {
		...process.env,
		EDA_BRIDGE_STATE_DIR: stateDir,
		EDA_WS_PORT: String(wsPort),
		EDA_BRIDGE_IDLE_EXIT_SEC: String(opts.idleExitSec ?? 60),
		EDA_WS_ALLOW_ALL_ORIGINS: '1',
		...(opts.env ?? {}),
	};

	const daemon = spawn(process.execPath, ['--require', 'ts-node/register', DAEMON_SRC], {
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let log = '';
	daemon.stdout?.on('data', (d) => { log += d.toString(); });
	daemon.stderr?.on('data', (d) => { log += d.toString(); });
	daemon.on('exit', (code) => {
		if (code !== 0 && code !== null) {
			console.error(`[harness] daemon exited ${code}, log:\n${log}`);
		}
	});

	// Wait for pid file (written after both UDS + WS servers are listening).
	// 15s ceiling — ts-node cold-spawn can be slow under suite load.
	const pidPath = join(stateDir, 'bridge.pid');
	const deadline = Date.now() + 15000;
	let ready = false;
	while (Date.now() < deadline) {
		try {
			await access(pidPath);
			const ok = await new Promise<boolean>((resolve) => {
				const s = createConnection(sockPath);
				s.once('connect', () => { s.destroy(); resolve(true); });
				s.once('error', () => { resolve(false); });
			});
			if (ok) { ready = true; break; }
		} catch { /* not yet */ }
		await new Promise((r) => setTimeout(r, 50));
	}
	if (!ready) {
		console.error(`[harness] daemon did not become reachable at ${sockPath} within 15s. log:\n${log}`);
	}

	const cleanup = async () => {
		if (!daemon.killed) {
			daemon.kill('SIGTERM');
			await new Promise<void>((resolve) => {
				daemon.once('exit', () => resolve());
				setTimeout(() => { daemon.kill('SIGKILL'); resolve(); }, 1000);
			});
		}
		await rm(stateDir, { recursive: true, force: true });
	};

	return { stateDir, wsPort, sockPath, daemon, cleanup };
}

// ---------------------------------------------------------------------------
// Mock MCP client: raw UDS + NDJSON.
// ---------------------------------------------------------------------------
class MockMcpClient {
	sock: NetSocket;
	buffer = '';
	messages: any[] = [];
	private waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
	private idCounter = 0;

	constructor(sockPath: string) {
		this.sock = createConnection(sockPath);
		this.sock.setEncoding('utf8');
		this.sock.on('data', (chunk: string) => {
			this.buffer += chunk;
			let nl: number;
			while ((nl = this.buffer.indexOf('\n')) !== -1) {
				const line = this.buffer.slice(0, nl);
				this.buffer = this.buffer.slice(nl + 1);
				if (line.length === 0) continue;
				const msg = JSON.parse(line);
				this.messages.push(msg);
				for (const w of this.waiters.slice()) {
					if (w.predicate(msg)) {
						this.waiters.splice(this.waiters.indexOf(w), 1);
						clearTimeout(w.timer);
						w.resolve(msg);
					}
				}
			}
		});
	}

	ready(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.sock.once('connect', () => resolve());
			this.sock.once('error', reject);
		});
	}

	send(msg: any): void {
		this.sock.write(JSON.stringify(msg) + '\n');
	}

	listTools(): Promise<any> {
		const id = `l${++this.idCounter}`;
		this.send({ kind: 'list_tools', id });
		return this.waitFor((m) => m.kind === 'list_tools_result' && m.id === id);
	}

	callTool(name: string, args: Record<string, unknown>): Promise<any> {
		const id = `c${++this.idCounter}`;
		this.send({ kind: 'call_tool', id, name, arguments: args });
		return this.waitFor((m) => m.kind === 'call_tool_result' && m.id === id);
	}

	waitFor(predicate: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
		for (const m of this.messages) {
			if (predicate(m)) return Promise.resolve(m);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
				reject(new Error('waitFor timeout'));
			}, timeoutMs);
			this.waiters.push({ predicate, resolve, reject, timer });
		});
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			this.sock.once('close', () => resolve());
			this.sock.destroy();
		});
	}
}

// ---------------------------------------------------------------------------
// Mock extension: raw WS + JSON.
// ---------------------------------------------------------------------------
class MockExtension {
	ws: WebSocket;
	instanceId: string;
	info: Record<string, unknown>;
	private handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
	messages: any[] = [];

	constructor(port: number, instanceId: string, info: Record<string, unknown> = {}) {
		this.instanceId = instanceId;
		this.info = { instanceId, ...info };
		this.ws = new WebSocket(`ws://127.0.0.1:${port}?instanceId=${instanceId}`, {
			origin: 'https://easyeda.com',
		});
		this.ws.on('message', (data) => {
			const msg = JSON.parse(data.toString());
			this.messages.push(msg);

			if (msg.method === 'instance.getInfo') {
				this.ws.send(JSON.stringify({ id: msg.id, result: this.info }));
				return;
			}
			const handler = this.handlers.get(msg.method);
			if (handler && msg.id) {
				try {
					const result = handler(msg.params || {});
					this.ws.send(JSON.stringify({ id: msg.id, result }));
				} catch (err: any) {
					this.ws.send(JSON.stringify({ id: msg.id, error: err.message || String(err) }));
				}
			}
		});
	}

	handle(method: string, fn: (params: Record<string, unknown>) => unknown): void {
		this.handlers.set(method, fn);
	}

	ready(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.ws.once('open', () => resolve());
			this.ws.once('error', reject);
		});
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			this.ws.once('close', () => resolve());
			this.ws.close();
		});
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('daemon advertises a non-empty tool list including server_info + list_instances', async () => {
	const h = await startDaemon();
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();
		const res = await client.listTools();
		assert.ok(Array.isArray(res.tools), 'tools should be an array');
		assert.ok(res.tools.length > 10, `expected many tools, got ${res.tools.length}`);
		const names = new Set(res.tools.map((t: any) => t.name));
		assert.ok(names.has('server_info'), 'server_info should be advertised');
		assert.ok(names.has('list_instances'), 'list_instances should be advertised');
		assert.ok(names.has('bridge_restart'), 'bridge_restart should be advertised');
		await client.close();
	} finally {
		await h.cleanup();
	}
});

test('tool descriptors carry name/description/inputSchema (JSON Schema)', async () => {
	const h = await startDaemon();
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();
		const res = await client.listTools();
		const t = res.tools.find((t: any) => t.name === 'server_info');
		assert.ok(t, 'server_info should be present');
		assert.equal(typeof t.description, 'string');
		assert.ok(t.description.length > 0);
		assert.equal(typeof t.inputSchema, 'object');
		assert.equal(t.inputSchema.type, 'object');
		await client.close();
	} finally {
		await h.cleanup();
	}
});

test('call_tool server_info works with no extensions connected', async () => {
	const h = await startDaemon();
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();
		const res = await client.callTool('server_info', {});
		assert.equal(res.error, undefined);
		assert.ok(res.result?.content?.[0]?.text);
		const body = JSON.parse(res.result.content[0].text);
		assert.equal(body.connectedInstanceCount, 0);
		assert.equal(body.extensionConnected, false);
		assert.equal(body.wsPort, h.wsPort);
		await client.close();
	} finally {
		await h.cleanup();
	}
});

test('call_tool list_instances reports extensions after one connects', async () => {
	const h = await startDaemon();
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();

		const ext = new MockExtension(h.wsPort, 'aaaa1111', { projectName: 'Project X', currentDocument: 'doc1', documentType: 'pcb' });
		await ext.ready();

		// Brief wait for the daemon to pull instance info via instance.getInfo
		await new Promise((r) => setTimeout(r, 200));

		const res = await client.callTool('list_instances', {});
		assert.equal(res.error, undefined);
		const body = JSON.parse(res.result.content[0].text);
		assert.equal(body.connectedInstanceCount, 1);
		assert.equal(body.instances[0].instanceId, 'aaaa1111');
		assert.equal(body.instances[0].projectName, 'Project X');

		await ext.close();
		await client.close();
	} finally {
		await h.cleanup();
	}
});

test('call_tool that forwards to an extension routes correctly', async () => {
	const h = await startDaemon();
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();

		const ext = new MockExtension(h.wsPort, '01abcdef');
		await ext.ready();
		// A real EasyEDA handler. pcb_get_all_nets calls pcb.net.getAllNames.
		ext.handle('pcb.net.getAllNames', () => ['VCC', 'GND', 'SCK']);
		await new Promise((r) => setTimeout(r, 100));

		const res = await client.callTool('pcb_get_all_nets', { document: 'fake-doc-uuid' });
		assert.equal(res.error, undefined);
		const body = JSON.parse(res.result.content[0].text);
		assert.deepEqual(body, ['VCC', 'GND', 'SCK']);

		await ext.close();
		await client.close();
	} finally {
		await h.cleanup();
	}
});

test('call_tool with no extensions returns a helpful error (not a crash)', async () => {
	const h = await startDaemon();
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();
		const res = await client.callTool('pcb_get_all_nets', { document: 'x' });
		assert.match(res.error || '', /not connected/);
		await client.close();
	} finally {
		await h.cleanup();
	}
});

test('call_tool routes via explicit instance_id when multiple extensions connected', async () => {
	const h = await startDaemon();
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();

		const ext1 = new MockExtension(h.wsPort, 'aaaa1111');
		const ext2 = new MockExtension(h.wsPort, 'bbbb2222');
		await Promise.all([ext1.ready(), ext2.ready()]);
		ext1.handle('pcb.net.getAllNames', () => ['A1', 'A2']);
		ext2.handle('pcb.net.getAllNames', () => ['B1', 'B2']);
		await new Promise((r) => setTimeout(r, 100));

		const res1 = await client.callTool('pcb_get_all_nets', { instance_id: 'aaaa1111', document: 'x' });
		assert.deepEqual(JSON.parse(res1.result.content[0].text), ['A1', 'A2']);

		const res2 = await client.callTool('pcb_get_all_nets', { instance_id: 'bbbb2222', document: 'x' });
		assert.deepEqual(JSON.parse(res2.result.content[0].text), ['B1', 'B2']);

		// Without instance_id, daemon errors with multiple-instances message.
		const resAmbig = await client.callTool('pcb_get_all_nets', { document: 'x' });
		assert.match(resAmbig.error || '', /Multiple EasyEDA instances/);

		await ext1.close();
		await ext2.close();
		await client.close();
	} finally {
		await h.cleanup();
	}
});

test('call_tool unknown tool name returns descriptive error', async () => {
	const h = await startDaemon();
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();
		const res = await client.callTool('not_a_real_tool', {});
		assert.match(res.error || '', /Unknown tool/);
		await client.close();
	} finally {
		await h.cleanup();
	}
});

test('singleton: second daemon on same UDS exits 0', async () => {
	const h = await startDaemon();
	try {
		const env = {
			...process.env,
			EDA_BRIDGE_STATE_DIR: h.stateDir,
			EDA_WS_PORT: String(h.wsPort + 1000),
			EDA_BRIDGE_IDLE_EXIT_SEC: '60',
			EDA_WS_ALLOW_ALL_ORIGINS: '1',
		};
		const second = spawn(process.execPath, ['--require', 'ts-node/register', DAEMON_SRC], {
			env, stdio: ['ignore', 'pipe', 'pipe'],
		});

		const exitCode = await new Promise<number | null>((resolve) => {
			second.once('exit', (code) => resolve(code));
			setTimeout(() => { second.kill(); resolve(-1); }, 5000);
		});
		assert.equal(exitCode, 0, 'second daemon should exit cleanly when one is already running');
	} finally {
		await h.cleanup();
	}
});

test('idle exit: daemon exits ~N seconds after last MCP client disconnects', async () => {
	const h = await startDaemon({ idleExitSec: 1 });
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();
		await client.listTools(); // ensure connection is in steady state
		await client.close();

		const exited = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 4000);
			h.daemon.once('exit', () => { clearTimeout(timer); resolve(true); });
		});
		assert.equal(exited, true, 'daemon should exit within 4s after last client disconnects');
	} finally {
		await h.cleanup();
	}
});

test('bridge_restart returns a response, then the daemon exits', async () => {
	const h = await startDaemon();
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();

		const res = await client.callTool('bridge_restart', { reason: 'unit test' });
		assert.equal(res.kind, 'call_tool_result');
		assert.equal(res.error, undefined);
		// Response payload travels in result.content[0].text as a JSON string.
		const payload = JSON.parse(res.result?.content?.[0]?.text ?? '{}');
		assert.equal(payload.ok, true);
		assert.equal(typeof payload.pidWas, 'number');
		assert.match(payload.message, /respawn/);

		// Daemon should exit within ~1s of the response (handler schedules +100ms).
		const exited = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 2000);
			h.daemon.once('exit', () => { clearTimeout(timer); resolve(true); });
		});
		assert.equal(exited, true, 'daemon should exit after bridge_restart');
	} finally {
		await h.cleanup();
	}
});

test('extension disconnect mid-call surfaces an error, not a hang', async () => {
	const h = await startDaemon();
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();

		const ext = new MockExtension(h.wsPort, 'aaaa1111');
		await ext.ready();
		// Don't register pcb.net.getAllNames — the call will sit pending until disconnect.
		await new Promise((r) => setTimeout(r, 100));

		const callPromise = client.callTool('pcb_get_all_nets', { document: 'x' });
		await new Promise((r) => setTimeout(r, 100));
		await ext.close();

		const res = await callPromise;
		assert.match(res.error || '', /disconnected/);

		await client.close();
	} finally {
		await h.cleanup();
	}
});

// UDS monitor: 5s poll + 1s grace. Allow a generous 10s window for the daemon
// to notice the file change and exit. Skipped under CI fast-mode if env says so.
async function waitForExit(daemon: ChildProcess, timeoutMs: number): Promise<number | null> {
	return new Promise((resolve) => {
		if (daemon.exitCode !== null) return resolve(daemon.exitCode);
		const timer = setTimeout(() => resolve(null), timeoutMs);
		daemon.once('exit', (code) => { clearTimeout(timer); resolve(code); });
	});
}

test('UDS monitor: daemon self-terminates when its socket file is unlinked', async () => {
	const h = await startDaemon();
	try {
		await unlink(h.sockPath);
		const code = await waitForExit(h.daemon, 10000);
		assert.equal(code, 2, `daemon should exit with code 2 when its UDS file disappears, got ${code}`);
	} finally {
		await h.cleanup();
	}
});

test('UDS monitor: daemon self-terminates when its socket file is replaced with a different inode', async () => {
	const h = await startDaemon();
	try {
		// Swap the live socket for a regular file at the same path so the inode
		// changes but the path still resolves — verifies dev:ino comparison, not
		// just existence.
		await unlink(h.sockPath);
		await writeFile(h.sockPath, '');
		const code = await waitForExit(h.daemon, 10000);
		assert.equal(code, 2, `daemon should exit with code 2 when its UDS file is replaced, got ${code}`);
	} finally {
		await h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// C4: WS auth token
// ---------------------------------------------------------------------------

function wsCloseCode(ws: WebSocket, timeoutMs = 5000): Promise<number> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('socket did not close in time')), timeoutMs);
		ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
	});
}

function nextMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<any> {
	return new Promise((resolve, reject) => {
		const onMsg = (data: any) => {
			try {
				const msg = JSON.parse(data.toString());
				if (predicate(msg)) {
					clearTimeout(timer);
					ws.off('message', onMsg);
					resolve(msg);
				}
			} catch { /* not JSON, keep waiting */ }
		};
		const timer = setTimeout(() => {
			ws.off('message', onMsg);
			reject(new Error('nextMessage timeout'));
		}, timeoutMs);
		ws.on('message', onMsg);
	});
}

test('WS auth: wrong ?token= in the URL is rejected with 4003', async () => {
	const h = await startDaemon();
	try {
		const ws = new WebSocket(`ws://127.0.0.1:${h.wsPort}?instanceId=aabb0011&token=wrong`, {
			origin: 'https://easyeda.com',
		});
		const code = await wsCloseCode(ws);
		assert.equal(code, 4003);
	} finally {
		await h.cleanup();
	}
});

test('WS auth: correct ?token= from the state dir is accepted', async () => {
	const h = await startDaemon();
	try {
		const token = (await readFile(join(h.stateDir, 'ws-token'), 'utf8')).trim();
		const ws = new WebSocket(`ws://127.0.0.1:${h.wsPort}?instanceId=aabb0022&token=${token}`, {
			origin: 'https://easyeda.com',
		});
		await nextMessage(ws, (m) => m.type === 'hello');
		ws.close();
	} finally {
		await h.cleanup();
	}
});

test('WS auth: wrong token in an auth message closes an already-registered socket', async () => {
	const h = await startDaemon();
	try {
		const ws = new WebSocket(`ws://127.0.0.1:${h.wsPort}?instanceId=aabb0033`, {
			origin: 'https://easyeda.com',
		});
		// Default policy: registered on Origin trust before any auth answer.
		await nextMessage(ws, (m) => m.type === 'hello');
		ws.send(JSON.stringify({ type: 'auth', data: { token: 'wrong' } }));
		const code = await wsCloseCode(ws);
		assert.equal(code, 4003);
	} finally {
		await h.cleanup();
	}
});

test('WS auth: EDA_WS_AUTH=require quarantines until the challenge is answered', async () => {
	const h = await startDaemon({ env: { EDA_WS_AUTH: 'require' } });
	try {
		const client = new MockMcpClient(h.sockPath);
		await client.ready();

		const ws = new WebSocket(`ws://127.0.0.1:${h.wsPort}?instanceId=aabb0044`, {
			origin: 'https://easyeda.com',
		});
		// list_instances awaits an instance.getInfo round-trip per extension, so
		// the fake extension must answer it or the tool call stalls.
		ws.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.method === 'instance.getInfo') {
					ws.send(JSON.stringify({ id: msg.id, result: { instanceId: 'aabb0044' } }));
				}
			} catch { /* ignore */ }
		});
		const challenge = await nextMessage(ws, (m) => m.type === 'auth.challenge');
		assert.equal(typeof challenge.tokenPath, 'string');

		// Quarantined: not visible to MCP clients yet (zero-instance path
		// returns a plain-text hint, not JSON).
		let res = await client.callTool('list_instances', {});
		assert.match(res.result.content[0].text, /No EasyEDA Pro instances are connected/);

		const token = (await readFile(challenge.tokenPath, 'utf8')).trim();
		ws.send(JSON.stringify({ type: 'auth', data: { token } }));
		await nextMessage(ws, (m) => m.type === 'hello');

		res = await client.callTool('list_instances', {});
		const body = JSON.parse(res.result.content[0].text);
		assert.equal(body.connectedInstanceCount, 1);

		ws.close();
		await client.close();
	} finally {
		await h.cleanup();
	}
});
