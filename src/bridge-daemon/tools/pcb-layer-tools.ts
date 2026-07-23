import type { ToolDef, ToolContext } from '../types';
import { z } from 'zod';
import { withDocumentParam } from './query-params';
import * as ANN from './annotations';

const LAYER_HANDLERS: Record<string, string> = {
	get_all: 'pcb.layer.getAll',
	select: 'pcb.layer.select',
	set_visible: 'pcb.layer.setVisible',
	set_invisible: 'pcb.layer.setInvisible',
	lock: 'pcb.layer.lock',
	unlock: 'pcb.layer.unlock',
	set_copper_count: 'pcb.layer.setCopperCount',
	modify: 'pcb.layer.modify',
	add_custom: 'pcb.layer.addCustom',
	remove: 'pcb.layer.remove',
};

export function pcbLayerTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'pcb_manage_layers',
			annotations: ANN.DESTRUCTIVE,
			description: `Manage PCB layers. Actions:
- get_all: get all layers with properties
- select: set active layer (layer: string)
- set_visible: show layer(s) (layer optional; setOtherLayerInvisible optional for solo mode)
- set_invisible: hide layer(s) (layer optional; setOtherLayerVisible optional)
- lock: lock layer(s) (layer optional)
- unlock: unlock layer(s) (layer optional)
- set_copper_count: set copper layers (count: 2,4,6,...,32). WARNING: REDUCING the count permanently discards all copper (tracks, pours, vias' inner connections) on the removed inner layers. No undo, and no backup snapshot is taken. Export the board first (pcb_export_to_file or document_save_to_file) if the layers being removed hold routing.
- modify: modify layer properties (layer: string, property: {name?, type?, color?, transparency?})
- add_custom: add a new custom layer
- remove: remove a custom layer (layer: string). WARNING: deletes the layer AND everything drawn on it. No undo, no backup snapshot. Export first if in doubt.`,
			inputShape: withDocumentParam({
				action: z
					.enum([
						'get_all', 'select', 'set_visible', 'set_invisible',
						'lock', 'unlock', 'set_copper_count', 'modify', 'add_custom', 'remove',
					])
					.describe('Action to perform'),
				layer: z
					.union([z.string(), z.array(z.string())])
					.optional()
					.describe('Layer name(s)'),
				setOtherLayerInvisible: z
					.boolean()
					.optional()
					.describe('Hide all other layers (for set_visible)'),
				setOtherLayerVisible: z
					.boolean()
					.optional()
					.describe('Show all other layers (for set_invisible)'),
				count: z.number().optional().describe('Copper layer count (for set_copper_count)'),
				property: z
					.object({
						name: z.string().optional(),
						type: z.string().optional(),
						color: z.string().optional(),
						transparency: z.number().optional(),
					})
					.optional()
					.describe('Properties to modify (for modify action)'),
			}),
			handler: async ({ action, ...rest }) => {
				const result = await ctx.sendToExtension(LAYER_HANDLERS[action], rest);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},
	];
}
