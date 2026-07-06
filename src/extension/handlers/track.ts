import { toPolygonSource } from './pcb-params';

export const trackHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// Line
	'pcb.getAll.line': async (params) => {
		return eda.pcb_PrimitiveLine.getAll(params.net, params.layer, params.primitiveLock);
	},

	'pcb.get.line': async (params) => {
		return eda.pcb_PrimitiveLine.get(params.primitiveIds);
	},

	'pcb.create.line': async (params) => {
		return eda.pcb_PrimitiveLine.create(
			params.net,
			params.layer,
			params.startX,
			params.startY,
			params.endX,
			params.endY,
			params.lineWidth,
		);
	},

	'pcb.modify.line': async (params) => {
		return eda.pcb_PrimitiveLine.modify(params.primitiveId, params.property);
	},

	'pcb.delete.line': async (params) => {
		return eda.pcb_PrimitiveLine.delete(params.ids);
	},

	// Polyline
	'pcb.getAll.polyline': async (params) => {
		return eda.pcb_PrimitivePolyline.getAll(params.net, params.layer, params.primitiveLock);
	},

	'pcb.get.polyline': async (params) => {
		return eda.pcb_PrimitivePolyline.get(params.primitiveIds);
	},

	'pcb.create.polyline': async (params) => {
		// create() wants an IPCB_Polygon, not a raw point/source array — passing
		// one straight through is why polyline creation rejected every call.
		const polygon = eda.pcb_MathPolygon.createPolygon(toPolygonSource(params.polygon) as any);
		if (!polygon) {
			throw new Error('Invalid polygon data');
		}
		return eda.pcb_PrimitivePolyline.create(params.net, params.layer, polygon, params.lineWidth);
	},

	'pcb.modify.polyline': async (params) => {
		return eda.pcb_PrimitivePolyline.modify(params.primitiveId, params.property);
	},

	'pcb.delete.polyline': async (params) => {
		return eda.pcb_PrimitivePolyline.delete(params.ids);
	},
};
