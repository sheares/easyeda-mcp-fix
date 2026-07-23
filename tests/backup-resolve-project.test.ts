// Q2: sch_swap_supplier_part backs up before writing. resolveProjectUuid is
// the helper that decides between a whole-project backup (allSchematicPages)
// and a document-level fallback; these tests pin its contract against a stub
// ToolContext.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectUuid } from '../src/bridge-daemon/backup';
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
