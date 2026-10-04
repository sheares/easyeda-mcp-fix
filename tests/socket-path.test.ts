import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { socketPath, usesNamedPipe } from '../src/bridge-daemon/protocol';

test('POSIX: a socket file inside the state dir', () => {
	assert.equal(socketPath('/home/ana/.easyeda-mcp', 'linux'), join('/home/ana/.easyeda-mcp', 'bridge.sock'));
	assert.equal(socketPath('/Users/ana/.easyeda-mcp', 'darwin'), join('/Users/ana/.easyeda-mcp', 'bridge.sock'));
	assert.equal(usesNamedPipe('darwin'), false);
	assert.equal(usesNamedPipe('linux'), false);
});

test('Windows: a named pipe, not a file path', () => {
	const p = socketPath('C:\\Users\\Ana\\.easyeda-mcp', 'win32');
	assert.match(p, /^\\\\\.\\pipe\\easyeda-mcp-bridge-[0-9a-f]{16}$/);
	assert.equal(usesNamedPipe('win32'), true);
});

test('Windows: one pipe per state dir, stable across calls and case', () => {
	const a = socketPath('C:\\Users\\Ana\\.easyeda-mcp', 'win32');
	assert.equal(socketPath('C:\\Users\\Ana\\.easyeda-mcp', 'win32'), a);
	assert.equal(socketPath('c:\\users\\ana\\.easyeda-mcp', 'win32'), a);
	assert.notEqual(socketPath('C:\\Users\\Ben\\.easyeda-mcp', 'win32'), a);
	assert.notEqual(socketPath('C:\\Temp\\easyeda-bridge-test-x1', 'win32'), a);
});
