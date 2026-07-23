import type { ToolDef, ToolContext } from '../types';
import { z } from 'zod';
import { withDocumentParam, withQueryParams, PCB_COORD_NOTE } from './query-params';

export function analysisTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'pcb_highlight_net',
			description: 'Highlight a specific net in the PCB editor for visual inspection',
			inputShape: withDocumentParam({
				net: z.string().describe('Net name to highlight'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.net.highlight', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_select_net',
			description: 'Select all primitives of a specific net in the PCB editor',
			inputShape: withDocumentParam({
				net: z.string().describe('Net name to select'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.net.select', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_clear_selection',
			description: 'Clear all selection in the PCB editor',
			inputShape: withDocumentParam({}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.select.clear', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_navigate_to',
			description: `Navigate the PCB editor viewport to specific coordinates. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				x: z.number().describe('X coordinate to navigate to'),
				y: z.number().describe('Y coordinate to navigate to'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.document.navigateTo', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_navigate_to_region',
			description: `Navigate and zoom the PCB editor viewport to fit a specific region. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				left: z.number().describe('Left boundary X'),
				right: z.number().describe('Right boundary X'),
				top: z.number().describe('Top boundary Y'),
				bottom: z.number().describe('Bottom boundary Y'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.document.navigateToRegion', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_zoom_to_board',
			description: 'Zoom the viewport to fit the entire board outline',
			inputShape: withDocumentParam({}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.document.zoomToBoardOutline', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_get_primitive_at_point',
			description: `Get the primitive at a specific point on the PCB. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				x: z.number().describe('X coordinate'),
				y: z.number().describe('Y coordinate'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.document.getPrimitiveAtPoint', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_get_primitives_in_region',
			description: `Get all primitives within a rectangular region on the PCB. ${PCB_COORD_NOTE}`,
			inputShape: withQueryParams({
				left: z.number().describe('Left boundary X'),
				right: z.number().describe('Right boundary X'),
				top: z.number().describe('Top boundary Y'),
				bottom: z.number().describe('Bottom boundary Y'),
				leftToRight: z
					.boolean()
					.optional()
					.describe('true=must be fully inside, false=intersecting also counts'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.document.getPrimitivesInRegion', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_canvas_origin',
			description: `Get or set the canvas origin offset relative to data origin. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				action: z.enum(['get', 'set']).describe('"get" to read, "set" to write'),
				offsetX: z.number().optional().describe('X offset (required for set)'),
				offsetY: z.number().optional().describe('Y offset (required for set)'),
			}),
			handler: async ({ action, ...rest }) => {
				if (action === 'get') {
					const result = await ctx.sendToExtension('pcb.document.getCanvasOrigin', rest);
					return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
				}
				const result = await ctx.sendToExtension('pcb.document.setCanvasOrigin', rest);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_convert_coordinates',
			description: `Convert between canvas coordinates and data coordinates. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				direction: z.enum(['canvasToData', 'dataToCanvas']).describe('Conversion direction'),
				x: z.number().describe('X coordinate'),
				y: z.number().describe('Y coordinate'),
			}),
			handler: async ({ direction, ...rest }) => {
				const method =
					direction === 'canvasToData'
						? 'pcb.document.convertCanvasToData'
						: 'pcb.document.convertDataToCanvas';
				const result = await ctx.sendToExtension(method, rest);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_import_changes',
			description:
				'Import changes from schematic into the PCB (sync schematic to PCB). Warning (upstream EDA bug, pro-api-sdk issue #33): pads of components newly placed by this call can read back with a null pad number until the PCB document is reloaded, and DRC may report an unstructured "Netlist Error". Close and reopen the PCB document (or reload via editor_open_document) before reading pads of freshly placed components.',
			inputShape: withDocumentParam({
				uuid: z.string().optional().describe('Schematic UUID (uses associated schematic if not provided)'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.document.importChanges', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},
	];
}
