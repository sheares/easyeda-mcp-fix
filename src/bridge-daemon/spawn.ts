import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { openSync, closeSync } from 'node:fs';
import { socketPath, logPath, stateDir } from './protocol';

/**
 * Probe-connect the UDS to see if a daemon is already running.
 * Resolves true on connect, false on ECONNREFUSED/ENOENT.
 * Closes the probe socket immediately.
 */
function probeDaemon(path: string, timeoutMs = 500): Promise<boolean> {
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
		sock.once('connect', () => {
			clearTimeout(timer);
			done(true);
		});
		sock.once('error', () => {
			clearTimeout(timer);
			done(false);
		});
	});
}

/**
 * Locate the daemon entry script. In production it ships next to the MCP
 * server: dist/bridge-daemon/index.js. __dirname is dist/mcp-server when this
 * code is bundled into the MCP server binary. Tests can override via
 * EDA_BRIDGE_DAEMON_ENTRY (e.g. to point at a ts-node-runnable .ts file).
 */
function daemonEntryPath(): string {
	if (process.env.EDA_BRIDGE_DAEMON_ENTRY) {
		return process.env.EDA_BRIDGE_DAEMON_ENTRY;
	}
	return resolvePath(__dirname, '..', 'bridge-daemon', 'index.js');
}

/**
 * Ensure a daemon is running and reachable at the configured UDS path.
 * - If one is already running, returns immediately.
 * - Otherwise spawns it (detached + unref'd), then polls for ~3s waiting for
 *   the UDS to accept connections.
 *
 * Race-safe: two MCP clients calling this at the same time both spawn, but
 * only one successfully binds the UDS (the other exits 0 from its singleton
 * check). The probe-connect after spawn will succeed for both.
 */
export async function ensureDaemonRunning(): Promise<void> {
	const sock = socketPath();

	if (await probeDaemon(sock)) return;

	await mkdir(stateDir(), { recursive: true });

	const entry = daemonEntryPath();
	const logFd = openSync(logPath(), 'a');

	const child = spawn(process.execPath, [entry], {
		detached: true,
		stdio: ['ignore', logFd, logFd],
		env: process.env,
	});
	// Spawn failures (EMFILE, EAGAIN, missing binary) emit 'error' on the
	// ChildProcess; with no listener that's an uncaught exception in the MCP
	// server process. Log it — the probe loop below will surface the failure.
	child.once('error', (err) => {
		console.error('[spawn] failed to spawn bridge daemon:', err);
	});
	child.unref();
	closeSync(logFd);

	// Poll for the UDS to come up. Use small initial delays; back off slowly.
	const deadline = Date.now() + 3000;
	const delays = [50, 100, 100, 150, 200, 300, 400, 500, 600, 700];
	let i = 0;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
		i++;
		if (await probeDaemon(sock)) return;
	}

	throw new Error(
		`Bridge daemon did not become reachable at ${sock} within 3s. See ${logPath()} for daemon output.`,
	);
}
