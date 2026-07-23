// Pure validator for the C4 auth-challenge tokenPath.
//
// The daemon sends `auth.challenge { tokenPath }` and expects the extension
// to prove same-user file access by reading that path back. Without
// validation, this is an arbitrary-file-read primitive: any local process
// that binds port 16168 during the ~15 s reconnect window can send
// tokenPath: "/Users/<u>/.ssh/id_ed25519" and receive the file contents.
//
// The extension cannot compute the daemon's exact state directory
// (protocol.ts:stateDir() honours the EDA_BRIDGE_STATE_DIR env var, which
// the extension cannot see), so we validate SHAPE rather than equality:
// basename must be `ws-token` inside a `.easyeda-mcp` parent directory. Any
// EDA_BRIDGE_STATE_DIR override that isn't named `.easyeda-mcp` will fail
// hardened auth by design.

export const AUTH_TOKEN_BASENAME = 'ws-token';
export const AUTH_TOKEN_PARENT_BASENAME = '.easyeda-mcp';

export type AuthPathValidation =
	| { ok: true }
	| { ok: false; reason: string };

export function validateAuthTokenPath(input: unknown): AuthPathValidation {
	if (typeof input !== 'string') {
		return { ok: false, reason: 'not a string' };
	}
	if (input.length === 0) {
		return { ok: false, reason: 'empty' };
	}
	if (input.includes('\0')) {
		return { ok: false, reason: 'contains NUL' };
	}
	if (input.includes('..')) {
		return { ok: false, reason: 'contains ..' };
	}

	// Split on both POSIX and Windows separators. The extension runs on the
	// user's desktop OS and the daemon runs there too, so path style follows
	// the OS; supporting both keeps the validator OS-agnostic and testable.
	const parts = input.split(/[\\/]/).filter((p) => p.length > 0);
	if (parts.length < 2) {
		return { ok: false, reason: 'must include parent directory' };
	}
	const basename = parts[parts.length - 1];
	const parent = parts[parts.length - 2];
	if (basename !== AUTH_TOKEN_BASENAME) {
		return { ok: false, reason: `basename ${JSON.stringify(basename)} != ${AUTH_TOKEN_BASENAME}` };
	}
	if (parent !== AUTH_TOKEN_PARENT_BASENAME) {
		return { ok: false, reason: `parent ${JSON.stringify(parent)} != ${AUTH_TOKEN_PARENT_BASENAME}` };
	}
	return { ok: true };
}
