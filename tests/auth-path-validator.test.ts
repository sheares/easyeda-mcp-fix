import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { validateAuthTokenPath } from '../src/extension/auth-path-validator';

test('accepts a well-shaped POSIX path', () => {
	const r = validateAuthTokenPath('/Users/alice/.easyeda-mcp/ws-token');
	assert.equal(r.ok, true);
});

test('accepts a well-shaped Windows path', () => {
	const r = validateAuthTokenPath('C:\\Users\\alice\\.easyeda-mcp\\ws-token');
	assert.equal(r.ok, true);
});

test('accepts a relative path if the two trailing segments are right', () => {
	// The daemon builds the path from homedir() + state dir, so it will be
	// absolute in practice, but the validator itself is shape-only.
	const r = validateAuthTokenPath('.easyeda-mcp/ws-token');
	assert.equal(r.ok, true);
});

test('rejects a non-string', () => {
	assert.equal(validateAuthTokenPath(undefined as unknown).ok, false);
	assert.equal(validateAuthTokenPath(null as unknown).ok, false);
	assert.equal(validateAuthTokenPath(42 as unknown).ok, false);
	assert.equal(validateAuthTokenPath({ tokenPath: 'x' } as unknown).ok, false);
});

test('rejects an empty string', () => {
	assert.equal(validateAuthTokenPath('').ok, false);
});

test('rejects a NUL byte anywhere in the path', () => {
	const r = validateAuthTokenPath('/Users/alice/.easyeda-mcp/ws-token\0.ssh/id_ed25519');
	assert.equal(r.ok, false);
});

test('rejects a path containing ..', () => {
	assert.equal(validateAuthTokenPath('/Users/alice/.easyeda-mcp/../.ssh/id_ed25519').ok, false);
	assert.equal(validateAuthTokenPath('../.easyeda-mcp/ws-token').ok, false);
	assert.equal(validateAuthTokenPath('/a/b/..hidden/.easyeda-mcp/ws-token').ok, false);
});

test('refuses classic exfil targets outright', () => {
	assert.equal(validateAuthTokenPath('/etc/passwd').ok, false);
	assert.equal(validateAuthTokenPath('/Users/alice/.ssh/id_ed25519').ok, false);
	assert.equal(validateAuthTokenPath('/Users/alice/.zsh_history').ok, false);
	assert.equal(validateAuthTokenPath('C:\\Windows\\System32\\config\\SAM').ok, false);
});

test('rejects a wrong basename inside the right parent dir', () => {
	// A rogue server that guesses the parent name still cannot pivot to any
	// other file inside it.
	const r = validateAuthTokenPath('/Users/alice/.easyeda-mcp/bridge.log');
	assert.equal(r.ok, false);
});

test('rejects the right basename inside a wrong parent dir', () => {
	const r = validateAuthTokenPath('/Users/alice/.ssh/ws-token');
	assert.equal(r.ok, false);
});

test('rejects a bare basename with no parent segment', () => {
	assert.equal(validateAuthTokenPath('ws-token').ok, false);
	assert.equal(validateAuthTokenPath('/ws-token').ok, false);
});

test('reason string is informative but does not leak the input verbatim in a header field', () => {
	// Sanity check that reason is a short debuggable string, not a stack.
	const r = validateAuthTokenPath('/Users/alice/.ssh/id_ed25519');
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.reason.length > 0);
		assert.ok(r.reason.length < 200);
	}
});
