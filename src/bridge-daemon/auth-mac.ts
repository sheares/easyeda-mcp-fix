// D1: mutual auth between extension and daemon — shared pure helpers.
//
// The C4 challenge-response only ever authenticated the extension TO the
// daemon, and did so by shipping the raw ws-token over the socket. Nothing
// authenticated the daemon to the extension, and TCP loopback ports carry no
// user identity, so any local process (any OS account) that bound 16168
// during a daemon-down window received the extension's auto-reconnect and
// could drive its full handler surface — and could also collect the raw
// token by challenging with the well-known default path.
//
// hmac-v1 fixes both directions without the token ever crossing the wire:
//
//   daemon → ext : auth.challenge { tokenPath, scheme: 'hmac-v1', serverNonce }
//   ext    → dmn : auth { scheme, clientNonce,
//                         mac = HMAC-SHA256(token, "ext|serverNonce|clientNonce") }
//   daemon → ext : auth.ok { mac = HMAC-SHA256(token, "daemon|clientNonce|serverNonce") }
//
// The extension reads the token itself (path shape validated by
// auth-path-validator.ts, unchanged) and verifies the daemon's MAC against
// it. A peer that cannot read the token file cannot produce either MAC. The
// "ext|"/"daemon|" prefixes domain-separate the two directions so a MAC can
// never be reflected back as the other side's proof.
//
// This module is PURE (no node: imports) because it is bundled into both the
// browser extension (webcrypto) and the daemon/tests (Node 20 exposes the
// same webcrypto on globalThis.crypto). The daemon's own verification uses
// node:crypto synchronously in index.ts; tests cross-check the two
// implementations against each other.

export const AUTH_SCHEME_HMAC_V1 = 'hmac-v1';

export function extMacMessage(serverNonce: string, clientNonce: string): string {
	return `ext|${serverNonce}|${clientNonce}`;
}

export function daemonMacMessage(clientNonce: string, serverNonce: string): string {
	return `daemon|${clientNonce}|${serverNonce}`;
}

/** True when a challenge carries everything hmac-v1 needs. */
export function isHmacChallenge(scheme: unknown, serverNonce: unknown): boolean {
	return scheme === AUTH_SCHEME_HMAC_V1 && typeof serverNonce === 'string' && serverNonce.length > 0;
}

function bytesToHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

export function randomHexNonce(byteLength = 16): string {
	const buf = new Uint8Array(byteLength);
	crypto.getRandomValues(buf);
	return bytesToHex(buf);
}

export async function hmacSha256Hex(keyUtf8: string, message: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(keyUtf8),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
	return bytesToHex(new Uint8Array(sig));
}

export type ExtensionAuthAnswer =
	| { kind: 'null'; data: { token: null } }
	| { kind: 'hmac'; clientNonce: string; data: { scheme: typeof AUTH_SCHEME_HMAC_V1; clientNonce: string; mac: string } };

/**
 * Build the extension's answer to an auth.challenge.
 *
 * The invariant this function owns: the RAW TOKEN IS NEVER SENT. A challenge
 * that does not speak hmac-v1 (a legacy daemon, or a rogue listener fishing
 * with the well-known token path) gets the same `{token: null}` answer as a
 * build that cannot read the file at all — the daemon then continues on
 * Origin trust (its default policy) and the extension surfaces an
 * "unverified daemon" warning instead.
 */
export async function buildExtensionAuthAnswer(
	challenge: { scheme?: unknown; serverNonce?: unknown },
	token: string | null,
	makeClientNonce: () => string = randomHexNonce,
): Promise<ExtensionAuthAnswer> {
	if (token === null || !isHmacChallenge(challenge.scheme, challenge.serverNonce)) {
		return { kind: 'null', data: { token: null } };
	}
	const clientNonce = makeClientNonce();
	const mac = await hmacSha256Hex(token, extMacMessage(challenge.serverNonce as string, clientNonce));
	return { kind: 'hmac', clientNonce, data: { scheme: AUTH_SCHEME_HMAC_V1, clientNonce, mac } };
}
