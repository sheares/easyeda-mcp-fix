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

// EasyEDA Pro 3.2.206 runs extensions in a sandbox where globalThis.crypto has
// getRandomValues but no `subtle`, so the webcrypto HMAC threw ("reading
// 'importKey'"), the auth answer was never sent and every request was refused
// after the 15 s verification timeout. hmacSha256Hex therefore falls back to
// the pure implementation below whenever crypto.subtle is missing; tests pin
// both paths to node:crypto.

function utf8Bytes(s: string): Uint8Array {
	if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
	const out: number[] = [];
	for (let i = 0; i < s.length; i++) {
		let c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const lo = s.charCodeAt(i + 1);
			if (lo >= 0xdc00 && lo <= 0xdfff) {
				c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
				i++;
			}
		}
		if (c < 0x80) out.push(c);
		else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
		else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
	}
	return Uint8Array.from(out);
}

const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const ror = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** FIPS 180-4 SHA-256. Pure and synchronous; inputs here are tiny (keys, nonces). */
export function sha256(msg: Uint8Array): Uint8Array {
	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
	padded.set(msg);
	padded[msg.length] = 0x80;
	const view = new DataView(padded.buffer);
	const bitLen = msg.length * 8;
	view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
	view.setUint32(padded.length - 4, bitLen >>> 0);
	const w = new Uint32Array(64);
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = w[i - 16] + s0 + w[i - 7] + s1;
		}
		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 64; i++) {
			const t1 = (hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
			const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}
		h[0] += a;
		h[1] += b;
		h[2] += c;
		h[3] += d;
		h[4] += e;
		h[5] += f;
		h[6] += g;
		h[7] += hh;
	}
	const out = new Uint8Array(32);
	const outView = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
	return out;
}

/** RFC 2104 HMAC-SHA256 on the pure sha256 above. */
export function hmacSha256HexPure(keyUtf8: string, message: string): string {
	let key = utf8Bytes(keyUtf8);
	if (key.length > 64) key = sha256(key);
	const ipad = new Uint8Array(64);
	const opad = new Uint8Array(64);
	for (let i = 0; i < 64; i++) {
		const k = i < key.length ? key[i] : 0;
		ipad[i] = k ^ 0x36;
		opad[i] = k ^ 0x5c;
	}
	const msg = utf8Bytes(message);
	const inner = new Uint8Array(64 + msg.length);
	inner.set(ipad);
	inner.set(msg, 64);
	const outer = new Uint8Array(64 + 32);
	outer.set(opad);
	outer.set(sha256(inner), 64);
	return bytesToHex(sha256(outer));
}

export async function hmacSha256Hex(keyUtf8: string, message: string): Promise<string> {
	const subtle = (globalThis as any).crypto?.subtle;
	if (!subtle || typeof subtle.importKey !== 'function' || typeof subtle.sign !== 'function') {
		return hmacSha256HexPure(keyUtf8, message);
	}
	const enc = new TextEncoder();
	const key = await subtle.importKey(
		'raw',
		enc.encode(keyUtf8),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await subtle.sign('HMAC', key, enc.encode(message));
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
