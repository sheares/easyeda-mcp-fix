// Smoke test for the bundled release: start dist/mcp-server/index.js the way an
// MCP client does, let it spawn a real bridge daemon, list the tools and call
// server_info. Runs in an isolated state dir and port, so it never touches a
// live bridge. Needs `npm run compile` first. Usage: node tests/smoke-bundle.js
'use strict';
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const server = join(root, 'dist', 'mcp-server', 'index.js');
const expectedVersion = require(join(root, 'package.json')).version;
const stateDir = mkdtempSync(join(tmpdir(), 'easyeda-smoke-'));

const child = spawn(process.execPath, [server], {
	env: {
		...process.env,
		EDA_BRIDGE_STATE_DIR: stateDir,
		EDA_BACKUP_DIR: join(stateDir, 'backup'),
		EDA_WS_PORT: String(30000 + Math.floor(Math.random() * 20000)),
	},
	stdio: ['pipe', 'pipe', 'pipe'],
	windowsHide: true,
});

let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		const msg = JSON.parse(line);
		const done = pending.get(msg.id);
		if (done) { pending.delete(msg.id); done(msg); }
	}
});

let nextId = 0;
function rpc(method, params) {
	return new Promise((res) => {
		const id = ++nextId;
		pending.set(id, res);
		child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	});
}

function fail(why) {
	console.error(`FAIL: ${why}`);
	if (stderr) console.error(`server stderr:\n${stderr.slice(-2000)}`);
	try { console.error(`bridge.log:\n${readFileSync(join(stateDir, 'bridge.log'), 'utf8').slice(-2000)}`); } catch { /* none */ }
	child.kill();
	process.exit(1);
}

(async () => {
	const timer = setTimeout(() => fail('timed out after 60 s'), 60000);

	const init = await rpc('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'smoke-bundle', version: '0' },
	});
	if (init.error) fail(`initialize: ${JSON.stringify(init.error)}`);
	console.log(`server ${init.result.serverInfo.name} ${init.result.serverInfo.version} on ${process.platform}`);
	child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

	const list = await rpc('tools/list', {});
	if (list.error) fail(`tools/list: ${JSON.stringify(list.error)}`);
	const names = list.result.tools.map((t) => t.name);
	console.log(`tools: ${names.length}`);
	if (names.length < 100) fail(`expected at least 100 tools, got ${names.length}`);

	// server_info is answered by the daemon itself, so this proves the MCP
	// server spawned the bridge and reached it over its local socket or pipe.
	const call = await rpc('tools/call', { name: 'server_info', arguments: {} });
	if (call.error || call.result.isError) fail(`server_info: ${JSON.stringify(call.error || call.result)}`);
	const info = JSON.parse(call.result.content[0].text);
	console.log(`daemon ${info.daemonVersion}, ws port ${info.wsPort}, extension connected: ${info.extensionConnected}`);
	if (info.daemonVersion !== expectedVersion) fail(`daemon version ${info.daemonVersion}, expected ${expectedVersion}`);

	const listening = readFileSync(join(stateDir, 'bridge.log'), 'utf8').split('\n').find((l) => l.includes('UDS listening at'));
	console.log(listening ? listening.trim() : '(no UDS line in bridge.log)');

	clearTimeout(timer);
	child.stdin.end();
	child.kill();
	setTimeout(() => {
		try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* daemon may still hold the log */ }
		console.log('PASS');
		process.exit(0);
	}, 1500);
})().catch((err) => fail(err && err.stack || String(err)));
