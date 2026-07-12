import { z } from 'zod';
import type { ToolDef, ToolContext } from '../types';
import { withInstanceParam } from './query-params';

export function libTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'lib_search_device',
			description: 'Search the component library for devices by keyword. Returns a list of matching components with their UUIDs, names, descriptions, and package info.',
			inputShape: withInstanceParam({
				key: z.string().describe('Search keyword (e.g. "2.2k resistor", "STM32F103", "0805 capacitor")'),
				libraryUuid: z.string().optional().describe('Library UUID to search in (omit to search all libraries)'),
				itemsOfPage: z.number().optional().describe('Number of results per page (default varies)'),
				page: z.number().optional().describe('Page number (0-based)'),
			}),
			handler: async (params) => {
				const result = await ctx.sendToExtension('lib.device.search', params);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_get_device',
			description: 'Get detailed information about a specific device by its UUID, including symbol, footprint, and all properties',
			inputShape: withInstanceParam({
				deviceUuid: z.string().describe('The device UUID'),
				libraryUuid: z.string().optional().describe('Library UUID (omit to search all libraries)'),
			}),
			handler: async ({ deviceUuid, libraryUuid, instance_id }) => {
				const result = await ctx.sendToExtension('lib.device.get', { deviceUuid, libraryUuid, instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_get_device_by_lcsc',
			description: 'Get device(s) by LCSC C-number(s). Useful for finding specific components like "C17414" for a 2.2k resistor.',
			inputShape: withInstanceParam({
				lcscIds: z
					.union([z.string(), z.array(z.string())])
					.describe('Single LCSC ID (e.g. "C17414") or array of LCSC IDs'),
				libraryUuid: z.string().optional().describe('Library UUID (omit to search all libraries)'),
			}),
			handler: async ({ lcscIds, libraryUuid, instance_id }) => {
				const result = await ctx.sendToExtension('lib.device.getByLcscIds', { lcscIds, libraryUuid, instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_get_system_library_uuid',
			description: 'Get the UUID of the system (built-in) component library',
			inputShape: withInstanceParam({}),
			handler: async ({ instance_id }) => {
				const result = await ctx.sendToExtension('lib.getSystemLibraryUuid', { instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_get_all_libraries',
			description: 'Get a list of all available component libraries with their UUIDs and names',
			inputShape: withInstanceParam({}),
			handler: async ({ instance_id }) => {
				const result = await ctx.sendToExtension('lib.getAllLibraries', { instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_get_personal_library_uuid',
			description: 'Get the UUID of the user\'s personal library (returns undefined on private deployments)',
			inputShape: withInstanceParam({}),
			handler: async ({ instance_id }) => {
				const result = await ctx.sendToExtension('lib.getPersonalLibraryUuid', { instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_get_project_library_uuid',
			description: 'Get the UUID of the current project\'s library (returns undefined if no project is open)',
			inputShape: withInstanceParam({}),
			handler: async ({ instance_id }) => {
				const result = await ctx.sendToExtension('lib.getProjectLibraryUuid', { instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		// ─── lib_Symbol ───────────────────────────────────────────────────────────

		{
			name: 'lib_symbol_get',
			description: 'Get a library symbol\'s metadata (name, classification, description) by UUID. Does NOT return the .esym source — use lib_symbol_open_in_editor + document_get_source for that.',
			inputShape: withInstanceParam({
				symbolUuid: z.string().describe('Symbol UUID'),
				libraryUuid: z.string().optional().describe('Library UUID (defaults to system library)'),
			}),
			handler: async ({ symbolUuid, libraryUuid, instance_id }) => {
				const result = await ctx.sendToExtension('lib.symbol.get', { symbolUuid, libraryUuid, instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_symbol_copy',
			description: 'Copy a library symbol from one library to another (e.g. system → personal). Returns the new symbol UUID. Fails if newSymbolName collides in the target library.',
			inputShape: withInstanceParam({
				symbolUuid: z.string().describe('Source symbol UUID'),
				libraryUuid: z.string().describe('Source library UUID'),
				targetLibraryUuid: z.string().describe('Destination library UUID'),
				newSymbolName: z.string().optional().describe('Name for the copy (defaults to source name; collisions fail)'),
			}),
			handler: async ({ symbolUuid, libraryUuid, targetLibraryUuid, newSymbolName, instance_id }) => {
				const result = await ctx.sendToExtension('lib.symbol.copy', {
					symbolUuid,
					libraryUuid,
					targetLibraryUuid,
					newSymbolName,
					instance_id,
				});
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_symbol_delete',
			description:
				'Delete a library symbol. IRREVERSIBLE: no undo, and no backup snapshot is taken (library assets are not documents). Fetch and save the symbol source with lib_symbol_get first if you may need to restore it. Returns boolean success.',
			inputShape: withInstanceParam({
				symbolUuid: z.string().describe('Symbol UUID'),
				libraryUuid: z.string().describe('Library UUID containing the symbol'),
			}),
			handler: async ({ symbolUuid, libraryUuid, instance_id }) => {
				const result = await ctx.sendToExtension('lib.symbol.delete', { symbolUuid, libraryUuid, instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_symbol_open_in_editor',
			description: 'Open a library symbol in the EasyEDA editor as a tab. Returns the new tabId — use that as the document UUID for document_get_source.',
			inputShape: withInstanceParam({
				symbolUuid: z.string().describe('Symbol UUID'),
				libraryUuid: z.string().describe('Library UUID containing the symbol'),
				splitScreenId: z.string().optional().describe('Split screen ID (defaults to last-focused split)'),
			}),
			handler: async ({ symbolUuid, libraryUuid, splitScreenId, instance_id }) => {
				const result = await ctx.sendToExtension('lib.symbol.openInEditor', {
					symbolUuid,
					libraryUuid,
					splitScreenId,
					instance_id,
				});
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_symbol_update_document_source',
			description: 'Replace a library symbol\'s entire .esym source. The symbol must live in a library you can write to (personal/team/project). Returns boolean success.',
			inputShape: withInstanceParam({
				symbolUuid: z.string().describe('Symbol UUID'),
				libraryUuid: z.string().describe('Library UUID containing the symbol'),
				documentSource: z.string().describe('New .esym source (NDJSON, same format as document_get_source)'),
			}),
			handler: async ({ symbolUuid, libraryUuid, documentSource, instance_id }) => {
				const result = await ctx.sendToExtension('lib.symbol.updateDocumentSource', {
					symbolUuid,
					libraryUuid,
					documentSource,
					instance_id,
				});
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		// ─── lib_Device ───────────────────────────────────────────────────────────

		{
			name: 'lib_device_copy',
			description: 'Copy a library device from one library to another. Returns the new device UUID. Whether the device\'s symbol/footprint are deep-copied or referenced cross-library is yet to be confirmed empirically.',
			inputShape: withInstanceParam({
				deviceUuid: z.string().describe('Source device UUID'),
				libraryUuid: z.string().describe('Source library UUID'),
				targetLibraryUuid: z.string().describe('Destination library UUID'),
				newDeviceName: z.string().optional().describe('Name for the copy (defaults to source name; collisions fail)'),
			}),
			handler: async ({ deviceUuid, libraryUuid, targetLibraryUuid, newDeviceName, instance_id }) => {
				const result = await ctx.sendToExtension('lib.device.copy', {
					deviceUuid,
					libraryUuid,
					targetLibraryUuid,
					newDeviceName,
					instance_id,
				});
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_device_modify',
			description: 'Modify a library device — re-bind its symbol/footprint, or change name/classification/description/properties. Pass only the fields you want to change. Pass null to clear an optional field. Use the `association` arg to swap to a different symbol or footprint UUID.',
			inputShape: withInstanceParam({
				deviceUuid: z.string().describe('Device UUID'),
				libraryUuid: z.string().describe('Library UUID containing the device'),
				deviceName: z.string().optional().describe('New device name'),
				association: z
					.object({
						symbol: z.object({ uuid: z.string(), libraryUuid: z.string() }).optional(),
						footprint: z.object({ uuid: z.string(), libraryUuid: z.string() }).nullable().optional(),
						model3D: z.object({ uuid: z.string(), libraryUuid: z.string() }).nullable().optional(),
					})
					.optional()
					.describe('Re-bind symbol/footprint/3D model. Each is { uuid, libraryUuid }.'),
				description: z.string().nullable().optional().describe('New description (null to clear)'),
				property: z
					.object({
						name: z.string().nullable().optional(),
						designator: z.string().optional(),
						addIntoBom: z.boolean().optional(),
						addIntoPcb: z.boolean().optional(),
						manufacturer: z.string().nullable().optional(),
						manufacturerId: z.string().nullable().optional(),
						supplier: z.string().nullable().optional(),
						supplierId: z.string().nullable().optional(),
					})
					.optional(),
			}),
			handler: async ({ deviceUuid, libraryUuid, deviceName, association, description, property, instance_id }) => {
				const result = await ctx.sendToExtension('lib.device.modify', {
					deviceUuid,
					libraryUuid,
					deviceName,
					association,
					description,
					property,
					instance_id,
				});
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'lib_device_delete',
			description:
				'Delete a library device. Does NOT delete its referenced symbol/footprint. IRREVERSIBLE: no undo, and no backup snapshot is taken (library assets are not documents). Record the device data with lib_get_device first if you may need to restore it. Returns boolean success.',
			inputShape: withInstanceParam({
				deviceUuid: z.string().describe('Device UUID'),
				libraryUuid: z.string().describe('Library UUID containing the device'),
			}),
			handler: async ({ deviceUuid, libraryUuid, instance_id }) => {
				const result = await ctx.sendToExtension('lib.device.delete', { deviceUuid, libraryUuid, instance_id });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},
	];
}
