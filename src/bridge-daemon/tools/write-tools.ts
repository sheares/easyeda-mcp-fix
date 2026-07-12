import { z } from 'zod';
import type { ToolDef, ToolContext } from '../types';
import { withDocumentParam, PCB_COORD_NOTE } from './query-params';
import { backupDocument, formatBackupSummary } from '../backup';

const layerParam = (description: string) => z.union([z.string(), z.number()]).describe(description);

const LAYER_DESC =
	'Layer name (e.g. "TopLayer", "BottomLayer", "Inner1".."Inner30", "Multi") or numeric EPCB_LayerId (1=Top, 2=Bottom, 12=Multi). Names are converted to the numeric id EasyEDA requires.';

const DELETE_HANDLER_MAP: Record<string, string> = {
	component: 'pcb.delete.component',
	track: 'pcb.delete.line',
	polyline: 'pcb.delete.polyline',
	via: 'pcb.delete.via',
	pad: 'pcb.delete.pad',
	pour: 'pcb.delete.pour',
	fill: 'pcb.delete.fill',
	arc: 'pcb.delete.arc',
	region: 'pcb.delete.region',
};

const MODIFY_HANDLER_MAP: Record<string, string> = {
	via: 'pcb.modify.via',
	polyline: 'pcb.modify.polyline',
	arc: 'pcb.modify.arc',
	pad: 'pcb.modify.pad',
	pour: 'pcb.modify.pour',
	fill: 'pcb.modify.fill',
	region: 'pcb.modify.region',
};

export function writeTools(ctx: ToolContext): ToolDef[] {
	return [
		// === Create Tools (keep separate — different param schemas) ===

		{
			name: 'pcb_create_track',
			description: `Create a single track segment (line) between two points on a specified layer and net. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				net: z.string().describe('Net name for the track'),
				layer: layerParam(LAYER_DESC),
				startX: z.number().describe('Start X coordinate'),
				startY: z.number().describe('Start Y coordinate'),
				endX: z.number().describe('End X coordinate'),
				endY: z.number().describe('End Y coordinate'),
				lineWidth: z.number().optional().describe('Track width (default uses design rules)'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.create.line', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_create_polyline_track',
			description: `Create a multi-segment polyline track defined by a series of points. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				net: z.string().describe('Net name for the track'),
				layer: layerParam(LAYER_DESC),
				polygon: z
					.array(z.object({ x: z.number(), y: z.number() }))
					.min(2)
					.describe('Array of points [{x, y}, ...] defining the polyline path'),
				lineWidth: z.number().optional().describe('Track width'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.create.polyline', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_create_via',
			description:
				'Create a via at the specified position. Warning (upstream EDA bug, pro-api-sdk issue #32): if an internal plane (PLANE layer) has already been generated, a via on a different net created afterwards does NOT get its anti-pad cut. Rebuilding pours does not fix it; DRC reports "Plane Zone to Via". Regenerate the internal plane after placing vias. This is a fabrication risk, so do not ship until that DRC error is clear. ' + PCB_COORD_NOTE,
			inputShape: withDocumentParam({
				net: z.string().describe('Net name'),
				x: z.number().describe('X coordinate'),
				y: z.number().describe('Y coordinate'),
				holeDiameter: z.number().describe('Hole diameter'),
				diameter: z.number().describe('Via pad diameter'),
				viaType: z.string().optional().describe('Via type (e.g. "Through", "BlindBuried")'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.create.via', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_create_arc',
			description: `Create an arc track segment on the PCB. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				net: z.string().describe('Net name'),
				layer: layerParam(LAYER_DESC),
				startX: z.number().describe('Start X coordinate'),
				startY: z.number().describe('Start Y coordinate'),
				endX: z.number().describe('End X coordinate'),
				endY: z.number().describe('End Y coordinate'),
				arcAngle: z.number().describe('Arc angle in degrees'),
				lineWidth: z.number().optional().describe('Track width'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.create.arc', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_create_pad',
			description: `Create a standalone pad on the PCB. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				layer: layerParam(LAYER_DESC),
				padNumber: z.string().describe('Pad number/name'),
				x: z.number().describe('X coordinate'),
				y: z.number().describe('Y coordinate'),
				rotation: z.number().optional().describe('Rotation angle in degrees'),
				net: z.string().optional().describe('Net name'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.create.pad', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_create_pour',
			description:
				'Create a copper pour region on the PCB. Two upstream EDA bugs to note: (1) pours reflow using the design-rule snapshot taken when the document was opened, so rules written via the API do not affect reflow until the PCB document is closed and reopened (pro-api-sdk issue #34); reopen before rebuilding pours after rule changes. (2) Rebuilding a pour does not cut internal-plane anti-pads for different-net vias created after plane generation (issue #32); regenerate the plane instead. ' + PCB_COORD_NOTE,
			inputShape: withDocumentParam({
				net: z.string().describe('Net name for the pour'),
				layer: layerParam(LAYER_DESC),
				polygon: z
					.array(z.union([z.string(), z.number()]))
					.describe('Polygon source array in EasyEDA L-mode order: [x1, y1, "L", x2, y2, ..., x1, y1] — coordinates of the first point, then the "L" token, then the remaining points (closed: last point repeats the first)'),
				pourFillMethod: z.enum(['solid', '45grid', '90grid']).optional().describe('Fill method'),
				preserveSilos: z.boolean().optional().describe('Whether to preserve copper islands'),
				pourName: z.string().optional().describe('Name for the pour region'),
				pourPriority: z.number().optional().describe('Pour priority (higher = poured first)'),
				lineWidth: z.number().optional().describe('Line width'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.create.pour', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_create_fill',
			description: `Create a fill region on the PCB. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				layer: layerParam(LAYER_DESC),
				polygon: z
					.array(z.union([z.string(), z.number()]))
					.describe('Polygon source array in EasyEDA L-mode order: [x1, y1, "L", x2, y2, ..., x1, y1] — coordinates of the first point, then the "L" token, then the remaining points (closed: last point repeats the first)'),
				net: z.string().optional().describe('Net name'),
				lineWidth: z.number().optional().describe('Line width'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.create.fill', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_create_region',
			description: `Create a design rule region (keepout/constraint area) on the PCB. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				layer: layerParam(LAYER_DESC),
				polygon: z
					.array(z.union([z.string(), z.number()]))
					.describe('Polygon source array in EasyEDA L-mode order: [x1, y1, "L", x2, y2, ..., x1, y1] — coordinates of the first point, then the "L" token, then the remaining points (closed: last point repeats the first)'),
				ruleType: z.array(z.string()).optional().describe('Rule type(s) for the region'),
				regionName: z.string().optional().describe('Name for the region'),
				lineWidth: z.number().optional().describe('Outline width'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.create.region', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		// === Modify Tools ===

		{
			name: 'pcb_move_component',
			description: `Move and/or rotate a component. Can also change its layer (flip), lock status, designator, etc. ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				primitiveId: z.string().describe('The component primitive ID'),
				x: z.number().optional().describe('New X coordinate'),
				y: z.number().optional().describe('New Y coordinate'),
				rotation: z.number().optional().describe('New rotation angle in degrees'),
				layer: layerParam('Target layer: "TopLayer"/1 or "BottomLayer"/2').optional(),
				primitiveLock: z.boolean().optional().describe('Whether to lock the component'),
				designator: z.string().optional().describe('New designator (e.g. "R1", "U2")'),
			}),
			handler: async ({ primitiveId, instance_id, document, ...property }) => {
				const result = await ctx.sendToExtension('pcb.modify.component', { primitiveId, property, instance_id, document });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_modify_track',
			description: `Modify properties of an existing track segment (line). ${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				primitiveId: z.string().describe('The track primitive ID'),
				net: z.string().optional().describe('New net name'),
				layer: layerParam(LAYER_DESC).optional(),
				startX: z.number().optional().describe('New start X'),
				startY: z.number().optional().describe('New start Y'),
				endX: z.number().optional().describe('New end X'),
				endY: z.number().optional().describe('New end Y'),
				lineWidth: z.number().optional().describe('New track width'),
			}),
			handler: async ({ primitiveId, instance_id, document, ...property }) => {
				const result = await ctx.sendToExtension('pcb.modify.line', { primitiveId, property, instance_id, document });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_modify_primitive',
			description: `Modify properties of a PCB primitive. Property keys vary by type:
- via: net, x, y, holeDiameter, diameter, viaType
- polyline: net, layer, lineWidth
- arc: net, layer, startX, startY, endX, endY, arcAngle, lineWidth
- pad: x, y, rotation, net, padNumber, layer
- pour: net, layer, pourFillMethod, preserveSilos, pourName, pourPriority, lineWidth
- fill: layer, net, fillMode, lineWidth
- region: layer, ruleType, regionName, lineWidth
All types support: primitiveLock
${PCB_COORD_NOTE}`,
			inputShape: withDocumentParam({
				type: z
					.enum(['via', 'polyline', 'arc', 'pad', 'pour', 'fill', 'region'])
					.describe('Primitive type to modify'),
				primitiveId: z.string().describe('The primitive ID'),
				property: z
					.record(z.string(), z.any())
					.describe('Properties to modify (see description for valid keys per type)'),
			}),
			handler: async ({ type, ...rest }) => {
				const result = await ctx.sendToExtension(MODIFY_HANDLER_MAP[type], rest);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		// === Delete (consolidated) ===

		{
			name: 'pcb_delete_primitives',
			description:
				'Delete one or more PCB primitives by type and IDs. Irreversible via this API: there is no undo call. The whole document is snapshotted to the local backup repo first; the response includes the backup SHA for recovery.',
			inputShape: withDocumentParam({
				type: z
					.enum(['component', 'track', 'polyline', 'via', 'pad', 'pour', 'fill', 'arc', 'region'])
					.describe('Primitive type to delete'),
				ids: z
					.union([z.string(), z.array(z.string())])
					.describe('Primitive ID(s) to delete'),
			}),
			handler: async ({ type, ...rest }) => {
				const backup = await backupDocument(ctx, {
					instance_id: rest.instance_id,
					document: rest.document,
					toolName: 'pcb_delete_primitives',
				});
				const result = await ctx.sendToExtension(DELETE_HANDLER_MAP[type], rest);
				return { content: [{ type: 'text', text: JSON.stringify({ result, backup, note: formatBackupSummary(backup) }, null, 2) }] };
			},
		},

		// === Save ===

		{
			name: 'pcb_save',
			description: 'Save the current PCB document',
			inputShape: withDocumentParam({
				uuid: z.string().optional().describe('Document UUID (uses current document if not provided)'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('pcb.document.save', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},
	];
}
