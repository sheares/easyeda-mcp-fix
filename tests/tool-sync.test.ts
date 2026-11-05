import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planToolSync, toolFingerprint } from '../src/mcp-server/tool-sync';
import type { ToolDescriptor } from '../src/bridge-daemon/protocol';

function tool(name: string, props: Record<string, unknown> = {}, description = `${name} tool`): ToolDescriptor {
	return { name, description, inputSchema: { type: 'object', properties: props } } as ToolDescriptor;
}

test('planToolSync: a new parameter on an existing tool means a re-registration', () => {
	const before = [tool('pcb_run_drc', { verbose: { type: 'boolean' } }), tool('server_info'), tool('old_tool')];
	const registered = new Map(before.map((d) => [d.name, toolFingerprint(d)]));
	const after = [tool('pcb_run_drc', { verbose: { type: 'boolean' }, maxErrors: { type: 'integer' } }), tool('server_info'), tool('new_tool')];
	const plan = planToolSync(registered, after);
	assert.deepEqual(plan.replace.map((d) => d.name), ['pcb_run_drc']);
	assert.deepEqual(plan.add.map((d) => d.name), ['new_tool']);
	assert.deepEqual(plan.remove, ['old_tool']);
});

test('planToolSync: an unchanged list is a no-op, and a description change counts as a change', () => {
	const tools = [tool('a'), tool('b')];
	const registered = new Map(tools.map((d) => [d.name, toolFingerprint(d)]));
	assert.deepEqual(planToolSync(registered, tools), { add: [], replace: [], remove: [] });
	assert.deepEqual(planToolSync(registered, [tool('a'), tool('b', {}, 'better words')]).replace.map((d) => d.name), ['b']);
});
