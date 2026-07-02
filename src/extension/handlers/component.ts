import { preserveMetadataOnModify, BASE_METADATA_PRESERVE_FIELDS } from './preserve-metadata';

// PCB modify() defensively preserves designator/name too (its API shape matches
// the schematic side, where modify() is known to wipe metadata). Caveat: an
// omitted field is restored from the snapshot, so this path cannot clear
// designator/name to empty — but passing an explicit new value still applies.
const PCB_METADATA_PRESERVE_FIELDS = [...BASE_METADATA_PRESERVE_FIELDS, 'designator', 'name'];

const pcbPrimitiveApi = {
	get: (ids: string[]) => eda.pcb_PrimitiveComponent.get(ids),
	modify: (id: string, prop: Record<string, any>) => eda.pcb_PrimitiveComponent.modify(id, prop),
};

export const componentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.getAll.component': async (params) => {
		return eda.pcb_PrimitiveComponent.getAll(params.layer, params.primitiveLock);
	},

	'pcb.get.component': async (params) => {
		return eda.pcb_PrimitiveComponent.get(params.primitiveIds);
	},

	'pcb.modify.component': async (params) => {
		return preserveMetadataOnModify(
			pcbPrimitiveApi,
			PCB_METADATA_PRESERVE_FIELDS,
			params.primitiveId,
			params.property,
		);
	},

	'pcb.delete.component': async (params) => {
		return eda.pcb_PrimitiveComponent.delete(params.ids);
	},

	'pcb.component.getPins': async (params) => {
		return eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(params.primitiveId);
	},
};
