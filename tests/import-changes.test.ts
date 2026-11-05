// pcb_import_changes: EasyEDA Pro 3.2.209's host ignores `force`, so the
// tool must warn whenever force is passed instead of letting `true` read as
// "the import finished".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisTools } from '../src/bridge-daemon/tools/analysis-tools';
import type { ToolContext } from '../src/bridge-daemon/types';

function toolWith(answer: unknown) {
	const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
	const ctx: ToolContext = {
		sendToExtension: async (method, params) => { sent.push({ method, params }); return answer; },
		getConnectedInstances: () => [],
		getConnectedCount: () => 1,
		isConnected: () => true,
		getPort: () => 16168,
		getDaemonVersion: () => '0.0.0-test',
		refreshAllInstanceInfo: async () => {},
		requestRestart: () => {},
	};
	const tool = analysisTools(ctx).find((t) => t.name === 'pcb_import_changes');
	assert.ok(tool, 'pcb_import_changes is defined');
	const run = async (params: Record<string, unknown>) => {
		const out = await tool.handler(params as any) as { content: Array<{ text: string }> };
		return JSON.parse(out.content[0].text);
	};
	return { run, sent };
}

test('pcb_import_changes without force returns EasyEDA\'s answer unchanged', async () => {
	const { run, sent } = toolWith(true);
	assert.equal(await run({ document: 'pcb-1' }), true);
	assert.equal(sent[0].method, 'pcb.document.importChanges');
});

test('pcb_import_changes with force passes it on and warns that 3.2.209 ignores it', async () => {
	const { run, sent } = toolWith(true);
	const body = await run({ document: 'pcb-1', force: true });
	assert.equal(sent[0].params?.force, true);
	assert.equal(body.result, true);
	assert.match(body.note, /ignores it/);
	assert.match(body.note, /click Apply/);
});
