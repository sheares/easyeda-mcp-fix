/**
 * Tool registry: collects all tool modules into a single dispatchable surface.
 *
 * On daemon startup, every tool's zod input shape is converted once to JSON
 * Schema for transport over NDJSON to MCP-server clients. Clients re-hydrate
 * via zod's fromJSONSchema and register the tools with the MCP SDK.
 *
 * Wire-format settings match what the MCP SDK uses internally so the schemas
 * Claude sees are identical regardless of whether tools are local or proxied:
 *   - target: 'draft-7'    (MCP convention)
 *   - io: 'input'          (we're describing what the caller sends)
 *   - unrepresentable: 'any' (don't throw on things JSON Schema can't express)
 */
import { z, toJSONSchema } from 'zod';
import type { ToolDef, ToolContext } from './types';
import type { CallToolResult, ToolDescriptor } from './protocol';

import { builtinTools } from './tools/builtin-tools';
import { readTools } from './tools/read-tools';
import { writeTools } from './tools/write-tools';
import { analysisTools } from './tools/analysis-tools';
import { schReadTools } from './tools/sch-read-tools';
import { schWriteTools } from './tools/sch-write-tools';
import { libTools } from './tools/lib-tools';
import { manufactureTools } from './tools/manufacture-tools';
import { pcbDrcTools } from './tools/pcb-drc-tools';
import { pcbLayerTools } from './tools/pcb-layer-tools';
import { editorTools } from './tools/editor-tools';
import { fileManagerTools } from './tools/file-manager-tools';
import { schemaTools } from './tools/schema-tools';

interface RegistryEntry {
	def: ToolDef;
	descriptor: ToolDescriptor;
}

export class ToolRegistry {
	private entries = new Map<string, RegistryEntry>();

	constructor(ctx: ToolContext) {
		const modules: Array<(c: ToolContext) => ToolDef[]> = [
			builtinTools,
			readTools,
			writeTools,
			analysisTools,
			schReadTools,
			schWriteTools,
			libTools,
			manufactureTools,
			pcbDrcTools,
			pcbLayerTools,
			editorTools,
			fileManagerTools,
			schemaTools,
		];

		for (const mod of modules) {
			for (const def of mod(ctx)) {
				if (this.entries.has(def.name)) {
					throw new Error(`Duplicate tool name: ${def.name}`);
				}
				this.entries.set(def.name, {
					def,
					descriptor: this.makeDescriptor(def),
				});
			}
		}
	}

	private makeDescriptor(def: ToolDef): ToolDescriptor {
		const schemaObject = z.object(def.inputShape);
		const jsonSchema = toJSONSchema(schemaObject, {
			target: 'draft-7',
			io: 'input',
			unrepresentable: 'any',
		}) as Record<string, unknown>;
		return {
			name: def.name,
			description: def.description,
			inputSchema: jsonSchema,
		};
	}

	listDescriptors(): ToolDescriptor[] {
		return Array.from(this.entries.values(), (e) => e.descriptor);
	}

	async dispatch(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
		const entry = this.entries.get(name);
		if (!entry) {
			throw new Error(`Unknown tool: ${name}`);
		}
		return entry.def.handler(args);
	}
}
