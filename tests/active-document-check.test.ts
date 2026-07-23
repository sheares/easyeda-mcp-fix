// Q1: request-level document switch verification.
//
// checkActiveDocument is the pure guard ws-client.ts runs after
// switchToDocument: openDocument can fail without throwing, leaving the
// previous document active, and requireDocumentType only checks the TYPE —
// so two PCBs in one project are interchangeable to it. These tests pin the
// accept/reject/permissive matrix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkActiveDocument } from '../src/extension/active-document-check';

const UUID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const UUID_B = 'bbbbbbbb-5555-6666-7777-888888888888';

test('exact tabId match passes', () => {
	const res = checkActiveDocument(UUID_A, { uuid: UUID_A, tabId: UUID_A });
	assert.equal(res.ok, true);
});

test('exact tabId match with suffix on both sides passes', () => {
	const res = checkActiveDocument(`${UUID_A}@2`, { uuid: UUID_A, tabId: `${UUID_A}@2` });
	assert.equal(res.ok, true);
});

test('bare-uuid request matches a suffixed tabId (pre-@ segment)', () => {
	const res = checkActiveDocument(UUID_A, { uuid: undefined, tabId: `${UUID_A}@1` });
	assert.equal(res.ok, true);
});

test('suffixed request matches a bare uuid (pre-@ segment)', () => {
	const res = checkActiveDocument(`${UUID_A}@symbolTab`, { uuid: UUID_A, tabId: undefined });
	assert.equal(res.ok, true);
});

test('two different PCB uuids fail, even though both are documentType 3', () => {
	const res = checkActiveDocument(UUID_B, { uuid: UUID_A, tabId: UUID_A });
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.match(res.reason, new RegExp(UUID_B));
		assert.match(res.reason, new RegExp(UUID_A));
	}
});

test('mismatch on both uuid and tabId fails', () => {
	const res = checkActiveDocument(`${UUID_B}@1`, { uuid: UUID_A, tabId: `${UUID_A}@1` });
	assert.equal(res.ok, false);
});

test('missing tabId falls back to uuid match', () => {
	const res = checkActiveDocument(UUID_A, { uuid: UUID_A });
	assert.equal(res.ok, true);
});

test('missing uuid falls back to tabId match', () => {
	const res = checkActiveDocument(UUID_A, { tabId: UUID_A });
	assert.equal(res.ok, true);
});

test('info object with neither field is permissive with a note', () => {
	const res = checkActiveDocument(UUID_A, {});
	assert.equal(res.ok, true);
	if (res.ok) assert.ok(res.note, 'expected a skip note');
});

test('null/undefined info is permissive with a note', () => {
	const forNull = checkActiveDocument(UUID_A, null);
	assert.equal(forNull.ok, true);
	if (forNull.ok) assert.ok(forNull.note);
	const forUndefined = checkActiveDocument(UUID_A, undefined);
	assert.equal(forUndefined.ok, true);
	if (forUndefined.ok) assert.ok(forUndefined.note);
});

test('non-string identity fields are treated as absent (permissive)', () => {
	const res = checkActiveDocument(UUID_A, { uuid: 42 as unknown, tabId: {} as unknown });
	assert.equal(res.ok, true);
	if (res.ok) assert.ok(res.note);
});

test('empty-string requested document is trivially ok', () => {
	const res = checkActiveDocument('', { uuid: UUID_A, tabId: UUID_A });
	assert.equal(res.ok, true);
});

test('empty-string identity fields are treated as absent', () => {
	const res = checkActiveDocument(UUID_A, { uuid: '', tabId: '' });
	assert.equal(res.ok, true);
	if (res.ok) assert.ok(res.note);
});
