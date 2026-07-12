import type { ToolDef, ToolContext } from '../types';
import { z } from 'zod';
import { withDocumentParam, withQueryParams } from './query-params';

const GET_ALL_HANDLER_MAP: Record<string, string> = {
	component: 'pcb.getAll.component',
	track: 'pcb.getAll.line',
	polyline: 'pcb.getAll.polyline',
	via: 'pcb.getAll.via',
	pad: 'pcb.getAll.pad',
	pour: 'pcb.getAll.pour',
	fill: 'pcb.getAll.fill',
	arc: 'pcb.getAll.arc',
	region: 'pcb.getAll.region',
};

const GET_BY_ID_HANDLER_MAP: Record<string, string> = {
	component: 'pcb.get.component',
	track: 'pcb.get.line',
	polyline: 'pcb.get.polyline',
	via: 'pcb.get.via',
	pad: 'pcb.get.pad',
	pour: 'pcb.get.pour',
	fill: 'pcb.get.fill',
	arc: 'pcb.get.arc',
	region: 'pcb.get.region',
};

const PRIMITIVE_TYPES = [
	'component',
	'track',
	'polyline',
	'via',
	'pad',
	'pour',
	'fill',
	'arc',
	'region',
] as const;

export function readTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'pcb_get_all_primitives',
			description: `Get all primitives of a specific type on the PCB, with optional filters.
Filters by type: component(layer), track/polyline/arc(net,layer), via(net), pad(layer,net), pour/fill(layer,net), region(layer).
Component fields: primitiveId, designator, name, layer, x, y, rotation, primitiveLock, addIntoBom.
Track fields: primitiveId, net, layer, startX, startY, endX, endY, lineWidth.
Via fields: primitiveId, net, x, y, holeDiameter, diameter, viaType.
Pad fields: primitiveId, net, layer, padNumber, x, y.`,
			inputShape: withQueryParams({
				type: z.enum(PRIMITIVE_TYPES).describe('Primitive type to query'),
				net: z.string().optional().describe('Filter by net name'),
				layer: z.string().optional().describe('Filter by layer (e.g. "TopLayer", "BottomLayer")'),
				primitiveLock: z.boolean().optional().describe('Filter by lock status (true=locked only, false=unlocked only)'),
			}),
			handler: async ({ type, ...rest }) => {
				const result = await ctx.sendToExtension(GET_ALL_HANDLER_MAP[type], rest);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_get_primitives_by_id',
			description: 'Get one or more PCB primitives by their type and primitive ID(s)',
			inputShape: withQueryParams({
				type: z.enum(PRIMITIVE_TYPES).describe('Primitive type'),
				primitiveIds: z
					.union([z.string(), z.array(z.string())])
					.describe('Single primitive ID or array of IDs'),
			}),
			handler: async ({ type, ...rest }) => {
				const result = await ctx.sendToExtension(GET_BY_ID_HANDLER_MAP[type], rest);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_get_all_nets',
			description: 'Get all net names in the PCB design',
			inputShape: withDocumentParam({}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.net.getAllNames', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_get_net_primitives',
			description: 'Get all primitives (tracks, pads, vias, etc.) belonging to a specific net',
			inputShape: withQueryParams({
				net: z.string().describe('The net name to query'),
				types: z
					.array(z.string())
					.optional()
					.describe('Filter by primitive types (e.g. ["Line", "Via", "Pad"])'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.net.getPrimitives', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_get_net_length',
			description: 'Get the total routed length of a specific net',
			inputShape: withDocumentParam({
				net: z.string().describe('The net name'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.net.getLength', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_get_design_rules',
			description: 'Get the current PCB design rule configuration (clearance, width, etc.)',
			inputShape: withDocumentParam({}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.drc.getRuleConfiguration', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_get_net_rules',
			description: 'Get net-specific design rules',
			inputShape: withDocumentParam({}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.drc.getNetRules', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_get_component_pins',
			description: `Get all pins/pads of a specific component by its primitive ID.
Pin fields: primitiveId, padNumber, net, layer, x, y.
Note (upstream EDA bug, pro-api-sdk issue #33): for components placed via the API in the current editing session, padNumber can read back null until the PCB document is closed and reopened.`,
			inputShape: withQueryParams({
				primitiveId: z.string().describe('The component primitive ID'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.component.getPins', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_run_drc',
			description: 'Run Design Rule Check (DRC) on the PCB. Returns violations if verbose is true, or just pass/fail.',
			inputShape: withQueryParams({
				strict: z.boolean().default(true).describe('Whether to run strict DRC checks'),
				ui: z.boolean().default(false).describe('Whether to show DRC results in UI'),
				verbose: z.boolean().default(true).describe('If true, returns detailed violation list'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.drc.check', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_get_selected',
			description: 'Get currently selected primitives in the PCB editor',
			inputShape: withQueryParams({}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.select.getAll', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},
	];
}
