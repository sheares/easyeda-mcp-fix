import { invalidateNetlistCache } from './sch-netlist-utils';

export const schWireHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'sch.wire.create': async (params) => {
		const result = await eda.sch_PrimitiveWire.create(
			params.line,
			params.net,
			params.color,
			params.lineWidth,
			params.lineType,
		);
		invalidateNetlistCache();
		return result;
	},

	'sch.wire.delete': async (params) => {
		const result = await eda.sch_PrimitiveWire.delete(params.ids);
		invalidateNetlistCache();
		return result;
	},

	'sch.wire.modify': async (params) => {
		const result = await eda.sch_PrimitiveWire.modify(params.primitiveId, params.property);
		invalidateNetlistCache();
		return result;
	},

	'sch.wire.get': async (params) => {
		return eda.sch_PrimitiveWire.get(params.primitiveIds);
	},

	'sch.wire.getAll': async (params) => {
		return eda.sch_PrimitiveWire.getAll(params.net);
	},
};
