import type { ToolDef, ToolContext } from '../types';
import { z } from 'zod';
import { withInstanceParam } from './query-params';
import * as ANN from './annotations';

export function editorTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'project_get_structure',
			annotations: ANN.READ_ONLY,
			description: 'Get the current project structure: boards (with their schematics/PCBs), standalone schematics with pages, standalone PCBs, and panels. Also shows which document is currently focused.',
			inputShape: withInstanceParam({}),
			handler: async ({ instance_id }) => {
				const result = await ctx.sendToExtension('editor.project.getStructure', { instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'editor_get_current_document',
			annotations: ANN.READ_ONLY,
			description: 'Get detailed info about the currently focused document. For schematic pages, includes parent schematic info. For PCBs, includes associated board info.',
			inputShape: withInstanceParam({}),
			handler: async ({ instance_id }) => {
				const result = await ctx.sendToExtension('editor.getCurrentDocument', { instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'editor_open_document',
			annotations: ANN.NAV,
			description: 'Open/navigate to a specific document by UUID. Works for schematic page UUIDs, PCB UUIDs, and panel UUIDs.',
			inputShape: withInstanceParam({
				documentUuid: z.string().describe('The UUID of the document to open'),
			}),
			handler: async ({ documentUuid, instance_id }) => {
				const result = await ctx.sendToExtension('editor.openDocument', { documentUuid, instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'editor_get_open_tabs',
			annotations: ANN.READ_ONLY,
			description: 'Get all currently open tabs in the editor, with the active tab marked. Also returns the split screen structure.',
			inputShape: withInstanceParam({}),
			handler: async ({ instance_id }) => {
				const result = await ctx.sendToExtension('editor.getOpenTabs', { instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		// Screenshot tool removed — see comment in editor.ts for why.
		// EasyEDA Pro's export/capture APIs don't work in the web app (2026-03-15).
	];
}
