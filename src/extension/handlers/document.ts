import { toPolygonSource } from './pcb-params';

export const documentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Document ===

	// save() takes no arguments (pro-api-types 0.3.5 through 0.4.26): it saves the active
	// document, which the request queue's switchToDocument has already selected.
	'pcb.document.save': async () => {
		return eda.pcb_Document.save();
	},

	'pcb.document.navigateTo': async (params) => {
		return eda.pcb_Document.navigateToCoordinates(params.x, params.y);
	},

	'pcb.document.navigateToRegion': async (params) => {
		return eda.pcb_Document.navigateToRegion(params.left, params.right, params.top, params.bottom);
	},

	'pcb.document.getPrimitiveAtPoint': async (params) => {
		return eda.pcb_Document.getPrimitiveAtPoint(params.x, params.y);
	},

	'pcb.document.getPrimitivesInRegion': async (params) => {
		return eda.pcb_Document.getPrimitivesInRegion(
			params.left,
			params.right,
			params.top,
			params.bottom,
			params.leftToRight,
		);
	},

	'pcb.document.zoomToBoardOutline': async () => {
		return eda.pcb_Document.zoomToBoardOutline();
	},

	'pcb.document.getCanvasOrigin': async () => {
		return eda.pcb_Document.getCanvasOrigin();
	},

	'pcb.document.setCanvasOrigin': async (params) => {
		return eda.pcb_Document.setCanvasOrigin(params.offsetX, params.offsetY);
	},

	'pcb.document.convertCanvasToData': async (params) => {
		return eda.pcb_Document.convertCanvasOriginToDataOrigin(params.x, params.y);
	},

	'pcb.document.convertDataToCanvas': async (params) => {
		return eda.pcb_Document.convertDataOriginToCanvasOrigin(params.x, params.y);
	},

	'pcb.document.importChanges': async (params) => {
		// The runtime takes a second `force` argument (in pro-api 0.3.50 and
		// 0.3.59) that the published types omit; 0.4.27's docs describe it as
		// the no-dialog mode. The 3.2.209 host ignores both arguments (it reads
		// only `source`), so the dialog still opens there; see analysis-tools.ts.
		const importChanges = eda.pcb_Document.importChanges as unknown as (uuid?: string, force?: boolean) => Promise<boolean>;
		return importChanges.call(eda.pcb_Document, params.uuid, params.force === true);
	},

	// === Selection ===

	'pcb.select.getAll': async () => {
		return eda.pcb_SelectControl.getAllSelectedPrimitives();
	},

	'pcb.select.clear': async () => {
		return eda.pcb_SelectControl.clearSelected();
	},

	// === Pad ===

	'pcb.getAll.pad': async (params) => {
		return eda.pcb_PrimitivePad.getAll(params.layer, params.net, params.primitiveLock);
	},

	'pcb.get.pad': async (params) => {
		return eda.pcb_PrimitivePad.get(params.primitiveIds);
	},

	'pcb.create.pad': async (params) => {
		return eda.pcb_PrimitivePad.create(
			params.layer,
			params.padNumber,
			params.x,
			params.y,
			params.rotation,
			// POLYGON pads take a polygon source; accept the ergonomic [{x, y}] form.
			Array.isArray(params.pad) && params.pad[0] === 'POLYGON'
				? ['POLYGON', toPolygonSource(params.pad[1])]
				: params.pad,
			params.net,
			params.hole,
			params.holeOffsetX,
			params.holeOffsetY,
			params.holeRotation,
			params.metallization,
			params.padType,
			params.specialPad,
			params.solderMaskAndPasteMaskExpansion,
			params.heatWelding,
			params.primitiveLock,
		);
	},

	'pcb.modify.pad': async (params) => {
		return eda.pcb_PrimitivePad.modify(params.primitiveId, params.property);
	},

	'pcb.delete.pad': async (params) => {
		return eda.pcb_PrimitivePad.delete(params.ids);
	},
};
