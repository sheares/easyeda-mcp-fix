// Q2: sch_swap_supplier_part backs up before writing. resolveProjectUuid is
// the helper that decides between a whole-project backup (allSchematicPages)
// and a document-level fallback; these tests pin its contract against a stub
// ToolContext.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDocument, resolveProjectUuid } from '../src/bridge-daemon/backup';
import type { ToolContext } from '../src/bridge-daemon/types';

function stubCtx(response: unknown): { ctx: ToolContext; calls: Array<{ method: string; params: Record<string, unknown> }> } {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	const ctx = {
		sendToExtension: async (method: string, params: Record<string, unknown> = {}) => {
			calls.push({ method, params });
			return response;
		},
		getConnectedInstances: () => [],
		getConnectedCount: () => 1,
		isConnected: () => true,
		getPort: () => 16168,
		refreshAllInstanceInfo: async () => {},
		requestRestart: () => {},
	} as ToolContext;
	return { ctx, calls };
}

test('returns the projectUuid from the document context', async () => {
	const { ctx, calls } = stubCtx({ source: '', context: { projectUuid: 'proj-123', documentUuid: 'doc-1' } });
	const uuid = await resolveProjectUuid(ctx, { instance_id: 'ab12', document: 'doc-1' });
	assert.equal(uuid, 'proj-123');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].method, 'fileManager.getDocumentSource');
	assert.deepEqual(calls[0].params, { instance_id: 'ab12', document: 'doc-1' });
});

test('returns undefined when context is missing entirely', async () => {
	const { ctx } = stubCtx({ source: '' });
	const uuid = await resolveProjectUuid(ctx, { document: 'doc-1' });
	assert.equal(uuid, undefined);
});

test('returns undefined when projectUuid is empty or non-string', async () => {
	const empty = stubCtx({ source: '', context: { projectUuid: '' } });
	assert.equal(await resolveProjectUuid(empty.ctx, { document: 'doc-1' }), undefined);
	const nonString = stubCtx({ source: '', context: { projectUuid: 42 } });
	assert.equal(await resolveProjectUuid(nonString.ctx, { document: 'doc-1' }), undefined);
});

// D3: a caller that already fetched the document source in the same tool call
// can thread it into backupDocument, which must then NOT re-fetch — one less
// full-document WS crossing per upload.
test('backupDocument with prefetched source does not call the extension', async () => {
	const repo = await mkdtemp(join(tmpdir(), 'easyeda-backup-test-'));
	const prevEnv = process.env.EDA_BACKUP_DIR;
	process.env.EDA_BACKUP_DIR = repo;
	try {
		const { ctx, calls } = stubCtx(null);
		const backup = await backupDocument(ctx, {
			document: 'doc-42',
			toolName: 'unit_test',
			prefetched: {
				source: 'line-one\nline-two\n',
				context: { projectUuid: 'proj-42', documentUuid: 'doc-42', documentType: 1, projectName: 'Test Project' },
			},
		});
		assert.equal(calls.length, 0, 'prefetched backup must not round-trip to the extension');
		assert.match(backup.sha, /^[0-9a-f]{40}$/);
		assert.ok(backup.path.includes('proj-42'));
		assert.ok(backup.path.includes('doc-42'));
	} finally {
		if (prevEnv === undefined) delete process.env.EDA_BACKUP_DIR;
		else process.env.EDA_BACKUP_DIR = prevEnv;
		await rm(repo, { recursive: true, force: true });
	}
});

test('propagates extension errors (backup must not silently skip)', async () => {
	const ctx = {
		...stubCtx(null).ctx,
		sendToExtension: async () => {
			throw new Error('EDA Pro Extension is not connected');
		},
	} as ToolContext;
	await assert.rejects(
		() => resolveProjectUuid(ctx, { document: 'doc-1' }),
		/not connected/,
	);
});
