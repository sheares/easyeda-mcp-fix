// Headless harness for the extension's request pipeline (QA 2026-09-06,
// Minor 2). ws-client.ts runs inside EasyEDA Pro against ambient `eda.*`
// globals; here those are stubbed just enough to drive the WebSocket
// callbacks that sys_WebSocket.register hands us, so the real handleMessage,
// auth exchange, verification gate and response path all execute.
//
// The verification gate lives on globalThis under a fixed key so it survives
// extension re-evaluation; tests use that same seam to (a) get a fresh gate
// per test and (b) install a short-timeout gate for the overrun scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { extMacMessage, daemonMacMessage } from '../src/bridge-daemon/auth-mac';
import { createVerificationGate } from '../src/extension/daemon-verification';
import * as extensionConfig from '../extension.json';

const GATE_KEY = '__claude_mcp_verification_gate__';
const TOKEN = 'f'.repeat(64);
const TOKEN_PATH = '/Users/test/.easyeda-mcp/ws-token';
const UUID = 'ext-uuid';

interface Harness {
	sent: any[];
	toasts: string[];
	push(msg: unknown): void;
	docInfo: any;
	tokenReadable: boolean;
}

function installEdaStub(): Harness {
	const g = globalThis as any;
	const h: Harness = { sent: [], toasts: [], push: () => { throw new Error('not connected'); }, docInfo: { documentType: 3, uuid: 'abc', tabId: 'abc@proj' }, tokenReadable: true };
	g.ESYS_ToastMessageType = { SUCCESS: 'success', WARNING: 'warning', ERROR: 'error' };
	g.ESYS_NetlistType = { JLCEDA_PRO: 'JLCEDA' };
	g.eda = {
		sys_WebSocket: {
			register: (_id: string, _url: string, onMessage: (e: { data: string }) => void, onOpen: () => void) => {
				h.push = (msg) => onMessage({ data: JSON.stringify(msg) });
				onOpen();
			},
			send: (_id: string, payload: string) => { h.sent.push(JSON.parse(payload)); },
			close: () => {},
		},
		sys_FileSystem: {
			readFileFromFileSystem: async (_path: string) => {
				if (!h.tokenReadable) throw new Error('permission denied');
				return { text: async () => TOKEN };
			},
		},
		sys_Message: { showToastMessage: (text: string) => { h.toasts.push(text); } },
		dmt_Project: { getCurrentProjectInfo: async () => ({ friendlyName: 'Proj' }) },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => h.docInfo },
		dmt_EditorControl: { getSplitScreenTree: async () => null, openDocument: async () => undefined },
	};
	return h;
}

// ws-client is loaded once (it caches state on globalThis); the stub must be
// in place before the first require.
const stub = installEdaStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wsClient = require('../src/extension/ws-client') as typeof import('../src/extension/ws-client');

async function waitFor<T>(probe: () => T | undefined, ms = 2000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = probe();
		if (v !== undefined) return v;
		if (Date.now() > deadline) throw new Error('waitFor timeout');
		await new Promise((r) => setTimeout(r, 5));
	}
}

function fresh(): Harness {
	delete (globalThis as any)[GATE_KEY];
	stub.sent.length = 0;
	stub.toasts.length = 0;
	stub.tokenReadable = true;
	stub.docInfo = { documentType: 3, uuid: 'abc', tabId: 'abc@proj' };
	wsClient.disconnectFromAllMcpServers(UUID);
	wsClient.connectToMcpServers(UUID);
	return stub;
}

const findSent = (pred: (m: any) => boolean) => () => stub.sent.find(pred);
const responseFor = (id: string) => findSent((m) => m.id === id);
const serverNonce = '11'.repeat(16);

function challenge(extra: Record<string, unknown> = { scheme: 'hmac-v1', serverNonce }) {
	return { type: 'auth.challenge', tokenPath: TOKEN_PATH, ...extra };
}

function daemonMac(clientNonce: string): string {
	return createHmac('sha256', TOKEN).update(daemonMacMessage(clientNonce, serverNonce)).digest('hex');
}

test('happy path: request waits for auth.ok, then runs; ext MAC verifies; no warning toast', async () => {
	const h = fresh();
	h.push(challenge());
	const auth = await waitFor(findSent((m) => m.type === 'auth'));
	assert.equal(auth.data.scheme, 'hmac-v1');
	assert.equal(auth.data.token, undefined, 'raw token must never be sent');
	const expectedExtMac = createHmac('sha256', TOKEN).update(extMacMessage(serverNonce, auth.data.clientNonce)).digest('hex');
	assert.equal(auth.data.mac, expectedExtMac);

	h.push({ id: 'r1', method: 'instance.getInfo', params: {} });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(stub.sent.find((m) => m.id === 'r1'), undefined, 'request must be held until auth.ok is checked');

	h.push({ type: 'auth.ok', mac: daemonMac(auth.data.clientNonce) });
	const res = await waitFor(responseFor('r1'));
	assert.equal(res.error, undefined);
	assert.equal(res.result.extensionVersion, extensionConfig.version);
	assert.equal(wsClient.isDaemonVerified(), true);
	assert.deepEqual(h.toasts.filter((t) => /NOT verified/.test(t)), []);
});

test('silent daemon: refused after the timeout; a late valid auth.ok upgrades and requests resume (Major 1)', async () => {
	const reasons: string[] = [];
	const late: Array<string | null> = [];
	const h = fresh();
	// Short-timeout gate through the documented globalThis seam.
	(globalThis as any)[GATE_KEY] = createVerificationGate({
		timeoutMs: 150,
		onUnverified: (r) => reasons.push(r),
		onVerifiedLate: (r) => late.push(r),
	});
	h.push(challenge());
	const auth = await waitFor(findSent((m) => m.type === 'auth'));
	h.push({ id: 'r2', method: 'instance.getInfo', params: {} });
	const refused = await waitFor(responseFor('r2'));
	assert.match(refused.error, /Bridge daemon not verified/);
	assert.match(refused.error, /did not complete within 150ms/);
	assert.equal(reasons.length, 1);

	h.push({ type: 'auth.ok', mac: daemonMac(auth.data.clientNonce) });
	await waitFor(() => (late.length === 1 ? true : undefined));
	h.push({ id: 'r3', method: 'instance.getInfo', params: {} });
	const ok = await waitFor(responseFor('r3'));
	assert.equal(ok.error, undefined);
	assert.equal(wsClient.isDaemonVerified(), true);
});

test('legacy challenge with a readable token: null answer, refusal naming bridge_restart, real toast', async () => {
	const h = fresh();
	h.push(challenge({}));
	const auth = await waitFor(findSent((m) => m.type === 'auth'));
	assert.deepEqual(auth.data, { token: null });
	h.push({ id: 'r4', method: 'instance.getInfo', params: {} });
	const res = await waitFor(responseFor('r4'));
	assert.match(res.error, /bridge_restart/);
	assert.equal(h.toasts.filter((t) => /NOT verified/.test(t)).length, 1, 'one warning toast');
});

test('token unreadable: null answer and requests proceed on Origin trust, no toast', async () => {
	const h = fresh();
	h.tokenReadable = false;
	h.push(challenge());
	const auth = await waitFor(findSent((m) => m.type === 'auth'));
	assert.deepEqual(auth.data, { token: null });
	h.push({ id: 'r5', method: 'instance.getInfo', params: {} });
	const res = await waitFor(responseFor('r5'));
	assert.equal(res.error, undefined);
	assert.deepEqual(h.toasts.filter((t) => /NOT verified/.test(t)), []);
});

test('no challenge at all: the first request is refused', async () => {
	const h = fresh();
	h.push({ id: 'r6', method: 'instance.getInfo', params: {} });
	const res = await waitFor(responseFor('r6'));
	assert.match(res.error, /no auth\.challenge was received/);
});

test('a challenge with a token path outside the state dir is refused without touching the file', async () => {
	const h = fresh();
	h.push(challenge({ scheme: 'hmac-v1', serverNonce, tokenPath: '/etc/passwd' }));
	const auth = await waitFor(findSent((m) => m.type === 'auth'));
	assert.deepEqual(auth.data, { token: null });
	h.push({ id: 'r7', method: 'instance.getInfo', params: {} });
	const res = await waitFor(responseFor('r7'));
	assert.match(res.error, /auth challenge refused/);
});

test('type-gate refusal reaches the daemon as a message, not a stack trace', async () => {
	const h = fresh();
	h.push(challenge());
	const auth = await waitFor(findSent((m) => m.type === 'auth'));
	h.push({ type: 'auth.ok', mac: daemonMac(auth.data.clientNonce) });
	h.docInfo = { documentType: 1, uuid: 'sch', tabId: 'sch@proj' };
	h.push({ id: 'r8', method: 'pcb.drc.getRuleConfiguration', params: {} });
	const res = await waitFor(responseFor('r8'));
	assert.match(res.error, /^This tool requires a PCB document/);
	assert.doesNotMatch(res.error, /\n\s+at /);
});
