// D1 mutual auth: pure helpers shared by the extension (webcrypto) and the
// daemon (node:crypto). The critical invariants pinned here:
//   1. the two HMAC implementations agree byte for byte;
//   2. the ext and daemon MAC messages are domain-separated (no reflection);
//   3. buildExtensionAuthAnswer NEVER emits the raw token — a challenge
//      without the hmac-v1 scheme gets {token: null} even when the token was
//      readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
	AUTH_SCHEME_HMAC_V1,
	buildExtensionAuthAnswer,
	daemonMacMessage,
	extMacMessage,
	hmacSha256Hex,
	hmacSha256HexPure,
	isHmacChallenge,
	randomHexNonce,
	sha256,
} from '../src/bridge-daemon/auth-mac';

const TOKEN = 'deadbeefcafef00d'.repeat(4);
const SERVER_NONCE = 'aa'.repeat(16);
const CLIENT_NONCE = 'bb'.repeat(16);

function nodeHmacHex(key: string, msg: string): string {
	return createHmac('sha256', key).update(msg).digest('hex');
}

test('webcrypto hmacSha256Hex matches node:crypto createHmac', async () => {
	const msg = extMacMessage(SERVER_NONCE, CLIENT_NONCE);
	assert.equal(await hmacSha256Hex(TOKEN, msg), nodeHmacHex(TOKEN, msg));
	// And on the daemon direction too.
	const dmsg = daemonMacMessage(CLIENT_NONCE, SERVER_NONCE);
	assert.equal(await hmacSha256Hex(TOKEN, dmsg), nodeHmacHex(TOKEN, dmsg));
});

test('ext and daemon MAC messages are domain-separated', async () => {
	// Same nonce pair, both directions: the messages must differ, and so must
	// the MACs — a captured ext MAC can never be replayed as a daemon proof.
	const ext = extMacMessage(SERVER_NONCE, CLIENT_NONCE);
	const daemon = daemonMacMessage(CLIENT_NONCE, SERVER_NONCE);
	assert.notEqual(ext, daemon);
	assert.notEqual(await hmacSha256Hex(TOKEN, ext), await hmacSha256Hex(TOKEN, daemon));
	// Even with identical nonces on both slots, prefixes keep them apart.
	assert.notEqual(extMacMessage('x', 'x'), daemonMacMessage('x', 'x'));
});

test('isHmacChallenge accepts only a well-formed hmac-v1 challenge', () => {
	assert.equal(isHmacChallenge(AUTH_SCHEME_HMAC_V1, SERVER_NONCE), true);
	assert.equal(isHmacChallenge(undefined, SERVER_NONCE), false);
	assert.equal(isHmacChallenge('hmac-v2', SERVER_NONCE), false);
	assert.equal(isHmacChallenge(AUTH_SCHEME_HMAC_V1, ''), false);
	assert.equal(isHmacChallenge(AUTH_SCHEME_HMAC_V1, 42), false);
});

test('buildExtensionAuthAnswer: hmac challenge yields a verifiable MAC, no raw token', async () => {
	const answer = await buildExtensionAuthAnswer(
		{ scheme: AUTH_SCHEME_HMAC_V1, serverNonce: SERVER_NONCE },
		TOKEN,
		() => CLIENT_NONCE,
	);
	assert.equal(answer.kind, 'hmac');
	if (answer.kind === 'hmac') {
		assert.equal(answer.data.scheme, AUTH_SCHEME_HMAC_V1);
		assert.equal(answer.data.clientNonce, CLIENT_NONCE);
		assert.equal(answer.data.mac, nodeHmacHex(TOKEN, extMacMessage(SERVER_NONCE, CLIENT_NONCE)));
		assert.ok(!JSON.stringify(answer.data).includes(TOKEN), 'raw token must not appear in the answer');
	}
});

test('buildExtensionAuthAnswer: challenge without hmac-v1 scheme gets token:null even when the token is readable', async () => {
	const legacy = await buildExtensionAuthAnswer({}, TOKEN);
	assert.deepEqual(legacy, { kind: 'null', data: { token: null } });
	const wrongScheme = await buildExtensionAuthAnswer({ scheme: 'raw', serverNonce: SERVER_NONCE }, TOKEN);
	assert.deepEqual(wrongScheme, { kind: 'null', data: { token: null } });
	const noNonce = await buildExtensionAuthAnswer({ scheme: AUTH_SCHEME_HMAC_V1 }, TOKEN);
	assert.deepEqual(noNonce, { kind: 'null', data: { token: null } });
});

test('buildExtensionAuthAnswer: unreadable token always yields token:null', async () => {
	const answer = await buildExtensionAuthAnswer(
		{ scheme: AUTH_SCHEME_HMAC_V1, serverNonce: SERVER_NONCE },
		null,
	);
	assert.deepEqual(answer, { kind: 'null', data: { token: null } });
});

test('randomHexNonce produces distinct lowercase hex of the requested width', () => {
	const a = randomHexNonce();
	const b = randomHexNonce();
	assert.match(a, /^[0-9a-f]{32}$/);
	assert.match(b, /^[0-9a-f]{32}$/);
	assert.notEqual(a, b);
	assert.match(randomHexNonce(8), /^[0-9a-f]{16}$/);
});

// Pure fallback (EasyEDA 3.2.206 sandboxes have no crypto.subtle).

test('pure sha256 matches node:crypto across every padding boundary', () => {
	for (let len = 0; len <= 200; len++) {
		const data = randomBytes(len);
		const ours = Buffer.from(sha256(new Uint8Array(data))).toString('hex');
		assert.equal(ours, createHash('sha256').update(data).digest('hex'), `length ${len}`);
	}
});

test('pure HMAC matches the RFC 4231 vectors', () => {
	// Case 2 ("Jefe") and case 6 (131-byte key, hashed first). Keys built from
	// latin-1 bytes would not survive UTF-8, so case 6 uses an ASCII key of
	// the same length and node:crypto as the reference.
	assert.equal(
		hmacSha256HexPure('Jefe', 'what do ya want for nothing?'),
		'5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
	);
	const longKey = 'k'.repeat(131);
	const msg = 'Test Using Larger Than Block-Size Key - Hash Key First';
	assert.equal(hmacSha256HexPure(longKey, msg), nodeHmacHex(longKey, msg));
});

test('pure HMAC matches node:crypto on random keys and messages, incl. non-ASCII', () => {
	const alphabet = 'abcdef0123456789|-_ \u00e9\u4e2d\ud83d\ude00';
	const pick = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
	for (let i = 0; i < 300; i++) {
		const key = pick(Math.floor(Math.random() * 150));
		const msg = pick(Math.floor(Math.random() * 300));
		assert.equal(hmacSha256HexPure(key, msg), nodeHmacHex(key, msg), `key ${JSON.stringify(key)}`);
	}
});

test('hmacSha256Hex falls back to the pure HMAC when crypto.subtle is missing', async (t) => {
	const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
	if (!desc || !desc.configurable) {
		t.skip('globalThis.crypto is not configurable on this Node');
		return;
	}
	const real = (globalThis as any).crypto;
	Object.defineProperty(globalThis, 'crypto', {
		configurable: true,
		value: { getRandomValues: real.getRandomValues.bind(real) },
	});
	try {
		const msg = extMacMessage(SERVER_NONCE, CLIENT_NONCE);
		assert.equal(await hmacSha256Hex(TOKEN, msg), nodeHmacHex(TOKEN, msg));
		const answer = await buildExtensionAuthAnswer({ scheme: AUTH_SCHEME_HMAC_V1, serverNonce: SERVER_NONCE }, TOKEN, () => CLIENT_NONCE);
		assert.equal(answer.kind, 'hmac');
		if (answer.kind === 'hmac') assert.equal(answer.data.mac, nodeHmacHex(TOKEN, msg));
	} finally {
		Object.defineProperty(globalThis, 'crypto', desc);
	}
});
