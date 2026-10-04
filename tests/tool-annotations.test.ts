// Q3: every tool in the registry must carry MCP annotations so clients can
// tell a read from a delete at the protocol level. These tests pin the
// classification rules rather than individual tools, so new tools that break
// a rule fail loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/bridge-daemon/registry';
import type { ToolContext } from '../src/bridge-daemon/types';

// Registry construction never calls the context; a no-op stub suffices.
const stubCtx: ToolContext = {
	sendToExtension: async () => null,
	getConnectedInstances: () => [],
	getConnectedCount: () => 0,
	isConnected: () => false,
	getPort: () => 16168,
	getDaemonVersion: () => '0.0.0-test',
	refreshAllInstanceInfo: async () => {},
	requestRestart: () => {},
};

const descriptors = new ToolRegistry(stubCtx).listDescriptors();

// Tools that MUST be flagged destructive: deletes, whole-document/project
// replacement, bulk mutation, layer surgery, and the restart.
const MUST_BE_DESTRUCTIVE = [
	'sch_delete_component',
	'sch_delete_wire',
	'pcb_delete_primitives',
	'lib_symbol_delete',
	'lib_device_delete',
	'lib_symbol_update_document_source',
	'lib_footprint_update_document_source',
	'document_set_source',
	'document_load_from_file',
	'project_import_file',
	'sch_swap_supplier_part',
	'sch_set_netlist',
	'pcb_manage_layers',
	'pcb_import',
	'sch_import_changes',
	'pcb_import_changes',
	'bridge_restart',
];

test('every advertised tool carries annotations with all four hints', () => {
	assert.ok(descriptors.length >= 100, `expected the full surface, got ${descriptors.length}`);
	for (const d of descriptors) {
		assert.ok(d.annotations, `${d.name} has no annotations`);
		for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
			assert.equal(typeof d.annotations![hint], 'boolean', `${d.name} missing explicit ${hint}`);
		}
	}
});

test('get/search/list-style tools are read-only', () => {
	for (const d of descriptors) {
		if (/^(sch|pcb|lib|editor)_get_|_search_|^list_instances$|^server_info$|^project_get_structure$|^document_get_source$|^document_validate$/.test(d.name)) {
			assert.equal(d.annotations?.readOnlyHint, true, `${d.name} should be readOnlyHint: true`);
			assert.equal(d.annotations?.destructiveHint, false, `${d.name} should be destructiveHint: false`);
		}
	}
});

test('the destructive list is flagged destructive and not read-only', () => {
	for (const name of MUST_BE_DESTRUCTIVE) {
		const d = descriptors.find((x) => x.name === name);
		assert.ok(d, `${name} missing from the registry`);
		assert.equal(d!.annotations?.destructiveHint, true, `${name} should be destructiveHint: true`);
		assert.equal(d!.annotations?.readOnlyHint, false, `${name} should be readOnlyHint: false`);
	}
});

test('no tool is both read-only and destructive', () => {
	for (const d of descriptors) {
		assert.ok(
			!(d.annotations?.readOnlyHint === true && d.annotations?.destructiveHint === true),
			`${d.name} claims to be both read-only and destructive`,
		);
	}
});

test('only the LCSC-backed lookups are open-world', () => {
	const openWorld = descriptors.filter((d) => d.annotations?.openWorldHint === true).map((d) => d.name).sort();
	assert.deepEqual(openWorld, ['lib_get_device_by_lcsc', 'lib_search_device']);
});

test('create tools are writes, not destructive, not idempotent', () => {
	for (const d of descriptors) {
		if (/^(sch|pcb)_create_/.test(d.name)) {
			assert.equal(d.annotations?.readOnlyHint, false, `${d.name} should not be read-only`);
			assert.equal(d.annotations?.destructiveHint, false, `${d.name} should not be destructive`);
			assert.equal(d.annotations?.idempotentHint, false, `${d.name} creates duplicates on repeat`);
		}
	}
});
