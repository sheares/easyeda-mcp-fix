// D1 mutual auth: pure helpers shared by the extension (webcrypto) and the
// daemon (node:crypto). The critical invariants pinned here:
//   1. the two HMAC implementations agree byte for byte;
//   2. the ext and daemon MAC messages are domain-separated (no reflection);
//   3. buildExtensionAuthAnswer NEVER emits the raw token — a challenge
//      without the hmac-v1 scheme gets {token: null} even when the token was
//      readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
	AUTH_SCHEME_HMAC_V1,
	buildExtensionAuthAnswer,
	daemonMacMessage,
	extMacMessage,
	hmacSha256Hex,
	isHmacChallenge,
	randomHexNonce,
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
