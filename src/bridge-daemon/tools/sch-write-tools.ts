import { z } from 'zod';
import type { ToolDef, ToolContext } from '../types';
import { withDocumentParam } from './query-params';
import { backupDocument, formatBackupSummary } from '../backup';

export function schWriteTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'sch_create_component',
			description: 'Create a schematic component from a library device reference. Use lib_search_device or lib_get_device_by_lcsc first to get the component object. IMPORTANT: The component object must include uuid, symbolUuid, footprintUuid, AND libraryUuid — passing only {deviceUuid, libraryUuid} will fail with a validation error. Pass the full object returned by lib_get_device_by_lcsc with libraryUuid added (from lib_get_system_library_uuid).',
			inputShape: withDocumentParam({
				component: z
					.record(z.string(), z.any())
					.describe(
						'Full component object including uuid, symbolUuid, footprintUuid, and libraryUuid. Get the base object from lib_get_device_by_lcsc or lib_search_device, then add libraryUuid from lib_get_system_library_uuid. Passing only {deviceUuid, libraryUuid} will fail.',
					),
				x: z.number().describe('X coordinate for placement (X axis points rightward — higher values = further right)'),
				y: z.number().describe('Y coordinate for placement (Y axis points upward — higher values = higher on screen)'),
				subPartName: z.string().optional().describe('Sub-part name for multi-part components'),
				rotation: z.number().optional().describe('Rotation angle in degrees'),
				mirror: z.boolean().optional().describe('Whether to mirror the component'),
				addIntoBom: z.boolean().optional().describe('Whether to include in BOM (default true)'),
				addIntoPcb: z.boolean().optional().describe('Whether to include in PCB (default true)'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.component.create', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		...((): ToolDef[] => {
			const netFlagItemSchema = z.object({
				identification: z
					.enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround'])
					.describe('Net flag type'),
				net: z.string().describe('Net name (e.g. "VCC", "GND", "3V3")'),
				x: z.number().describe('X coordinate (X axis points rightward — higher values = further right)'),
				y: z.number().describe('Y coordinate (Y axis points upward — higher values = higher on screen)'),
				rotation: z.number().optional().describe('Rotation angle in degrees'),
				mirror: z.boolean().optional().describe('Whether to mirror'),
				component: z
					.object({ libraryUuid: z.string(), uuid: z.string() })
					.optional()
					.describe('Library device reference override'),
			});

			const netPortItemSchema = z.object({
				direction: z.enum(['IN', 'OUT', 'BI']).describe('Port direction'),
				net: z.string().describe('Net name'),
				x: z.number().describe('X coordinate'),
				y: z.number().describe('Y coordinate'),
				rotation: z.number().optional().describe('Rotation angle in degrees'),
				mirror: z.boolean().optional().describe('Whether to mirror'),
				component: z
					.object({ libraryUuid: z.string(), uuid: z.string() })
					.optional()
					.describe('Library device reference override'),
			});

			return [
				{
					name: 'sch_create_net_flag',
					description: 'Create one or more Power/Ground/AnalogGround/ProtectGround net flags in the schematic. Pass individual parameters for a single flag, or use "batch" array for multiple flags in one call.',
					inputShape: withDocumentParam({
						identification: z
							.enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround'])
							.optional()
							.describe('Net flag type (for single creation)'),
						net: z.string().optional().describe('Net name (for single creation)'),
						x: z.number().optional().describe('X coordinate (for single creation)'),
						y: z.number().optional().describe('Y coordinate (for single creation)'),
						rotation: z.number().optional().describe('Rotation angle in degrees'),
						mirror: z.boolean().optional().describe('Whether to mirror'),
						component: z
							.object({ libraryUuid: z.string(), uuid: z.string() })
							.optional()
							.describe('Library device reference override'),
						batch: z
							.array(netFlagItemSchema)
							.max(10)
							.optional()
							.describe('Array of net flags to create in one call (max 10 — each takes ~1.5s). When provided, the individual parameters above are ignored.'),
					}),
					handler: async (params) => {
						const result = await ctx.sendToExtension('sch.component.createNetFlag', params);
						return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
					},
				},

				{
					name: 'sch_create_net_port',
					description: 'Create one or more IN/OUT/BI directional net ports in the schematic. Pass individual parameters for a single port, or use "batch" array for multiple ports in one call.',
					inputShape: withDocumentParam({
						direction: z.enum(['IN', 'OUT', 'BI']).optional().describe('Port direction (for single creation)'),
						net: z.string().optional().describe('Net name (for single creation)'),
						x: z.number().optional().describe('X coordinate (for single creation)'),
						y: z.number().optional().describe('Y coordinate (for single creation)'),
						rotation: z.number().optional().describe('Rotation angle in degrees'),
						mirror: z.boolean().optional().describe('Whether to mirror'),
						component: z
							.object({ libraryUuid: z.string(), uuid: z.string() })
							.optional()
							.describe('Library device reference override'),
						batch: z
							.array(netPortItemSchema)
							.max(10)
							.optional()
							.describe('Array of net ports to create in one call (max 10 — each takes ~1.5s). When provided, the individual parameters above are ignored.'),
					}),
					handler: async (params) => {
						const result = await ctx.sendToExtension('sch.component.createNetPort', params);
						return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
					},
				},
			];
		})(),

		{
			name: 'sch_delete_component',
			description:
				'Delete one or more schematic components by their primitive IDs. Irreversible via this API: there is no undo call. The whole document is snapshotted to the local backup repo first; the response includes the backup SHA for recovery.',
			inputShape: withDocumentParam({
				ids: z
					.union([z.string(), z.array(z.string())])
					.describe('Single primitive ID or array of primitive IDs to delete'),
			}),
			handler: async (params) => {
				const backup = await backupDocument(ctx, {
					instance_id: params.instance_id,
					document: params.document,
					toolName: 'sch_delete_component',
				});
				const result = await ctx.sendToExtension('sch.component.delete', params);
				return { content: [{ type: 'text', text: JSON.stringify({ result, backup, note: formatBackupSummary(backup) }, null, 2) }] };
			},
		},

		{
			name: 'sch_modify_component',
			description: 'Modify properties of a schematic component (position, rotation, designator, etc.)',
			inputShape: withDocumentParam({
				primitiveId: z.string().describe('The component primitive ID'),
				x: z.number().optional().describe('New X coordinate'),
				y: z.number().optional().describe('New Y coordinate'),
				rotation: z.number().optional().describe('New rotation angle in degrees'),
				mirror: z.boolean().optional().describe('Whether to mirror'),
				addIntoBom: z.boolean().optional().describe('Whether to include in BOM'),
				addIntoPcb: z.boolean().optional().describe('Whether to include in PCB'),
				designator: z.string().nullable().optional().describe('New designator (e.g. "R1", "U2")'),
				name: z.string().nullable().optional().describe('New component name'),
				uniqueId: z.string().nullable().optional().describe('New unique ID'),
				manufacturer: z.string().nullable().optional().describe('Manufacturer name'),
				manufacturerId: z.string().nullable().optional().describe('Manufacturer part number'),
				supplier: z.string().nullable().optional().describe('Supplier name'),
				supplierId: z.string().nullable().optional().describe('Supplier part number (e.g. LCSC C-number)'),
			}),
			handler: async ({ primitiveId, instance_id, document, ...property }) => {
				const result = await ctx.sendToExtension('sch.component.modify', { primitiveId, property, instance_id, document });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_swap_supplier_part',
			description: `Bulk-swap supplier metadata on schematic components matching a filter.
WARNING (field-confirmed): this swaps supplier METADATA only. The canvas symbol and its label stay those of the OLD part. Use this ONLY when the replacement is a true drop-in with identical schematic symbol and PCB footprint (e.g. same 100nF 0603 cap in a different reel). For any part with a different symbol, footprint, or pin count, delete the component and re-add it instead — otherwise the schematic and BOM will disagree with the canvas symbol/label.
Uses the same bug-1 metadata guard as sch_modify_component: unspecified fields (otherProperty, uniqueId, position, symbol, etc.) are preserved via a snapshot-and-merge round trip, so a swap that only touches supplierId doesn't wipe the rest of the BOM row.
Typical uses: rotate to a cheaper LCSC alt (match: {supplierId: "C25804"}, replace: {supplierId: "C17414", manufacturerId: "..."}), or bulk-tag a designator prefix (match: {designator: "R*"}, replace: {manufacturer: "YAGEO"}).
match: filter fields with the same semantics as read-tool filter — exact string, ["a","b"] OR-array, or "prefix*" glob. Any component field is accepted (designator, supplierId, manufacturerId, manufacturer, ...).
replace: at least one of supplierId, manufacturerId, manufacturer, supplier.
dryRun: if true, returns the matches with before/after but does NOT modify. Recommended for the first pass.
allSchematicPages: walk every schematic page instead of only the active one; original page is restored.
Returns { dryRun, swappedCount, swapped:[{primitiveId, designator, page, before, after}] }. Always re-run sch_export_bom afterward to confirm BOM integrity.`,
			inputShape: withDocumentParam({
				match: z
					.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
					.describe('Filter fields to match components on (exact, OR array, or "prefix*" glob).'),
				replace: z
					.object({
						supplierId: z.string().nullable().optional().describe('New supplier part number (e.g. LCSC C-number)'),
						manufacturerId: z.string().nullable().optional().describe('New manufacturer part number'),
						manufacturer: z.string().nullable().optional().describe('New manufacturer name'),
						supplier: z.string().nullable().optional().describe('New supplier name (default LCSC)'),
					})
					.describe('Supplier metadata to overwrite on matched components. At least one field required.'),
				allSchematicPages: z.boolean().optional().describe('Walk all schematic pages (defaults to active page only)'),
				dryRun: z.boolean().optional().describe('If true, return matches with before/after but do not modify. Recommended for first pass.'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.component.swapSupplierPart', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_create_wire',
			description: 'Create a wire in the schematic defined by a series of coordinate points',
			inputShape: withDocumentParam({
				line: z
					.union([
						z.array(z.number()).min(4).describe('Flat array of coordinates [x1,y1,x2,y2,...]'),
						z
							.array(z.array(z.number()).length(2))
							.min(2)
							.describe('Array of point pairs [[x1,y1],[x2,y2],...]'),
					])
					.describe('Wire path coordinates'),
				net: z.string().optional().describe('Net name to assign to the wire'),
				color: z.string().nullable().optional().describe('Wire color (null for default)'),
				lineWidth: z.number().nullable().optional().describe('Wire width (null for default)'),
				lineType: z
					.enum(['0', '1', '2', '3'])
					.optional()
					.describe('Line type: 0=Solid, 1=Dashed, 2=Dotted, 3=DotDashed'),
			}),
			handler: async ({ lineType, instance_id, document, ...rest }) => {
				const params: Record<string, any> = { ...rest, instance_id, document };
				if (lineType !== undefined) {
					params.lineType = Number(lineType);
				}
				const result = await ctx.sendToExtension('sch.wire.create', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_delete_wire',
			description:
				'Delete one or more wires by their primitive IDs. Irreversible via this API: there is no undo call. The whole document is snapshotted to the local backup repo first; the response includes the backup SHA for recovery.',
			inputShape: withDocumentParam({
				ids: z
					.union([z.string(), z.array(z.string())])
					.describe('Single primitive ID or array of primitive IDs to delete'),
			}),
			handler: async (params) => {
				const backup = await backupDocument(ctx, {
					instance_id: params.instance_id,
					document: params.document,
					toolName: 'sch_delete_wire',
				});
				const result = await ctx.sendToExtension('sch.wire.delete', params);
				return { content: [{ type: 'text', text: JSON.stringify({ result, backup, note: formatBackupSummary(backup) }, null, 2) }] };
			},
		},

		{
			name: 'sch_modify_wire',
			description: 'Modify properties of an existing wire',
			inputShape: withDocumentParam({
				primitiveId: z.string().describe('The wire primitive ID'),
				line: z
					.union([z.array(z.number()), z.array(z.array(z.number()))])
					.optional()
					.describe('New wire path coordinates'),
				net: z.string().optional().describe('New net name'),
				color: z.string().nullable().optional().describe('New wire color (null for default)'),
				lineWidth: z.number().nullable().optional().describe('New wire width (null for default)'),
				lineType: z
					.enum(['0', '1', '2', '3'])
					.optional()
					.describe('Line type: 0=Solid, 1=Dashed, 2=Dotted, 3=DotDashed'),
			}),
			handler: async ({ primitiveId, lineType, instance_id, document, ...rest }) => {
				const property: Record<string, any> = { ...rest };
				if (lineType !== undefined) {
					property.lineType = Number(lineType);
				}
				const result = await ctx.sendToExtension('sch.wire.modify', { primitiveId, property, instance_id, document });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_select_primitives',
			description: `Select and highlight primitives in the schematic editor by designators, pins, or nets.
Selection is additive — each call adds to the current selection. There is currently no programmatic way to clear the selection; the user must click on empty space in the editor to deselect.
Pin format: "U1_1" (designator_pinNumber). Components selects the whole component, pins highlights just the pin, nets highlights the entire wire/net.`,
			inputShape: withDocumentParam({
				components: z
					.array(z.string())
					.optional()
					.describe('Component designators to select (e.g. ["U3", "U13"])'),
				pins: z
					.array(z.string())
					.optional()
					.describe('Pins to select as designator_pinNumber (e.g. ["U3_1", "U3_2"])'),
				nets: z
					.array(z.string())
					.optional()
					.describe('Net names to select (e.g. ["GND", "VBUS"])'),
			}),
			handler: async ({ components, pins, nets, instance_id, document }) => {
				const result = await ctx.sendToExtension('sch.select.crossProbe', {
					components,
					pins,
					nets,
					highlight: true,
					select: true,
					instance_id,
					document,
				});
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_set_netlist',
			description: 'Update the schematic netlist',
			inputShape: withDocumentParam({
				type: z
					.enum(['Allegro', 'PADS', 'Protel2', 'JLCEDA', 'EasyEDA', 'DISA'])
					.optional()
					.describe('Netlist format type'),
				netlist: z.string().describe('Netlist data string'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.netlist.set', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_save',
			description: 'Save the current schematic document',
			inputShape: withDocumentParam({}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.document.save', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'sch_import_changes',
			description: 'Import changes from PCB back into the schematic',
			inputShape: withDocumentParam({}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('sch.document.importChanges', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},
	];
}
