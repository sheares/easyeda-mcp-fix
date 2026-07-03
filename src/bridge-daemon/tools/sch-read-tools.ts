import { z } from 'zod';
import type { ToolDef, ToolContext } from '../types';
import { withDocumentParam, withQueryParams } from './query-params';

export function schReadTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'sch_get_all_components',
			description: `Get all components in the schematic with their properties, positions, rotations, designators, etc.
To identify what a component is, check: designator (e.g. "R1", "U3"), name (part name/number), manufacturer, manufacturerId (manufacturer part number), supplier, supplierId (supplier part number, e.g. JLCPCB/LCSC number), and footprint.
All fields: primitiveId, componentType, designator, name, x, y, rotation, mirror, addIntoBom, addIntoPcb, footprint, manufacturer, manufacturerId, supplier, supplierId, net, otherProperty.
otherProperty contains user-defined custom attributes — contents vary per component.
Template expressions like ={Manufacturer Part} are automatically resolved to their actual values.`,
			inputShape: withQueryParams({
				componentType: z
					.enum(['part', 'sheet', 'netflag', 'netport', 'nonElectrical_symbol', 'short_symbol', 'netlabel'])
					.optional()
					.describe('Filter by component type (e.g. "part", "netflag", "netport")'),
				allSchematicPages: z
					.boolean()
					.optional()
					.describe('If true, get components from all schematic pages instead of just the current page'),
				skipNetlist: z
					.boolean()
					.optional()
					.describe(
						'If true, skip netlist resolution. Component pin-net names and ={...} template expressions are NOT resolved, but the call returns immediately. Use this on large projects where netlist retrieval is slow.',
					),
				refresh: z
					.boolean()
					.optional()
					.describe(
						'If true, bypass the netlist cache and force a fresh recompute. Use after editing the schematic directly in the EasyEDA UI (edits made through these tools invalidate the cache automatically).',
					),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.component.getAll', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_component',
			description: 'Get one or more schematic components by primitive ID(s)',
			inputShape: withDocumentParam({
				primitiveIds: z
					.union([z.string(), z.array(z.string())])
					.describe('Single primitive ID or array of primitive IDs'),
				skipNetlist: z
					.boolean()
					.optional()
					.describe(
						'If true, skip netlist resolution. ={...} template expressions are NOT resolved, but the call returns immediately. Use this on large projects where netlist retrieval is slow.',
					),
				refresh: z
					.boolean()
					.optional()
					.describe(
						'If true, bypass the netlist cache and force a fresh recompute. Use after editing the schematic directly in the EasyEDA UI (edits made through these tools invalidate the cache automatically).',
					),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.component.get', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_component_pins',
			description: `Get all pins of a schematic component by its primitive ID.
Pin fields: primitiveId, pinNumber, name, net, x, y, rotation.
Each pin includes a net field with the net name it is connected to (empty string if unconnected).
Pins connected to $-prefixed nets (like $R11_1) are on unnamed nets that still carry real signals — use sch_get_connectivity with that net name to see what else is connected.`,
			inputShape: withQueryParams({
				primitiveId: z.string().describe('The component primitive ID'),
				refresh: z
					.boolean()
					.optional()
					.describe(
						'If true, bypass the netlist cache and force a fresh recompute. Use after editing the schematic directly in the EasyEDA UI (edits made through these tools invalidate the cache automatically).',
					),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.component.getAllPins', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_all_wires',
			description: 'Get all wires in the schematic, optionally filtered by net name',
			inputShape: withQueryParams({
				net: z
					.union([z.string(), z.array(z.string())])
					.optional()
					.describe('Filter by net name or array of net names'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.wire.getAll', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_wire',
			description: 'Get one or more wires by primitive ID(s)',
			inputShape: withDocumentParam({
				primitiveIds: z
					.union([z.string(), z.array(z.string())])
					.describe('Single primitive ID or array of primitive IDs'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.wire.get', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_selected',
			description: 'Get all currently selected primitives in the schematic editor',
			inputShape: withQueryParams({}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.select.getAll', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_selected_ids',
			description: 'Get primitive IDs of all currently selected primitives in the schematic editor',
			inputShape: withDocumentParam({}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.select.getAllIds', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_primitive',
			description: 'Get a schematic primitive by its ID with all properties',
			inputShape: withDocumentParam({
				id: z.string().describe('The primitive ID'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.primitive.get', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_primitive_type',
			description: 'Get the type of a schematic primitive by its ID',
			inputShape: withDocumentParam({
				id: z.string().describe('The primitive ID'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.primitive.getType', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_primitive_bbox',
			description: 'Get the bounding box of one or more schematic primitives',
			inputShape: withDocumentParam({
				primitiveIds: z.array(z.string()).describe('Array of primitive IDs'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.primitive.getBBox', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_netlist',
			description: `Get the raw schematic netlist in the specified format. WARNING: The JLCEDA format response is very large (100KB+).
Prefer sch_get_connectivity for connectivity questions — it returns the same net/pin data in a much more compact format with resolved part names.
Only use this tool when you need a specific netlist export format (Allegro, PADS, etc.) or the full raw netlist data.`,
			inputShape: withQueryParams({
				type: z
					.enum(['Allegro', 'PADS', 'Protel2', 'JLCEDA', 'EasyEDA', 'DISA'])
					.optional()
					.describe('Netlist format type'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.netlist.get', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_get_connectivity',
			description: `Get compact connectivity data: which nets connect which component pins, with resolved part names.
Much smaller than sch_get_netlist — use this for connectivity questions.
Returns nets (net → pin connections like "U3.2(GND)") and components (designator → part + pin assignments).
Auto-generated net names (starting with $) are hidden from the nets section but still appear in component pin assignments.
IMPORTANT: $-prefixed nets (like $R11_1, $U3_7) represent real electrical connections — they are unnamed nets where the designer didn't assign a net label. When investigating a component's full circuit context, you MUST look at $-prefixed nets in its pin assignments and trace them to see what else is connected. These often carry critical signals (reset lines, boot pins, enable pins) that would otherwise be invisible.
Use the depth parameter (default 2) to automatically trace through $-prefixed nets and discover indirect connections — so by default, you already see one hop through unnamed nets (pull-ups, series resistors, boot/reset circuitry). Pass depth=1 to see only direct connections, or 3–5 to chase longer chains. The response includes a note field reminding you of the depth used.`,
			inputShape: withDocumentParam({
				designators: z
					.array(z.string())
					.optional()
					.describe('Only include these components and nets touching them (e.g. ["U3", "U8"])'),
				nets: z
					.array(z.string())
					.optional()
					.describe('Only include these nets and components touching them (e.g. ["GND", "VBUS"])'),
				depth: z
					.number()
					.int()
					.min(1)
					.max(5)
					.optional()
					.describe('How many hops to trace through $-prefixed (unnamed) nets from the specified designators. depth=1 shows only direct connections. depth=2 (default) follows unnamed nets one hop out — finds buttons/pull-ups/regulators connected through series resistors. Higher values chase longer chains. Only used with designators parameter.'),
				refresh: z
					.boolean()
					.optional()
					.describe(
						'If true, bypass the netlist cache and force a fresh recompute. Use after editing the schematic directly in the EasyEDA UI (edits made through these tools invalidate the cache automatically).',
					),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.connectivity.get', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_run_drc',
			description: 'Run Design Rule Check (DRC) on the schematic',
			inputShape: withQueryParams({
				strict: z.boolean().optional().describe('Whether to run strict DRC checks'),
				userInterface: z.boolean().optional().describe('Whether to show DRC results in UI'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.drc.check', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},
	];
}
