// The reference makes the EDA Pro ambient globals (eda) resolvable when ts-node
// compiles this module outside tsconfig.extension.json (handler unit tests).
/// <reference types="@jlceda/pro-api-types" />
import { toClosedPolygonSource } from './pcb-params';
import { readBackPrimitive } from './read-back';
import { describeError } from '../diag';

// On 3.2.206 the per-pour call fails inside EasyEDA for pours created through
// the API (its own docs say so: the wrapper always sends isLast:false, gets
// nothing back and reads .length of it), and rebuildCopperRegions is not in
// the runtime at all. So say plainly what the caller has to do instead.
const REBUILD_FAILED_NOTE =
	'EasyEDA could not rebuild these pours through its API (on EasyEDA Pro 3.2.206 this happens for pours created through the API). ' +
	'Ask the user to rebuild all copper in the PCB editor (Shift+B), then read the board again.';

// The stack trace of an error thrown inside EasyEDA points into its own
// bundle and does not help the caller.
function firstLine(text: string): string {
	return text.split('\n')[0];
}

export const pourFillHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Pour ===

	'pcb.getAll.pour': async (params) => {
		return eda.pcb_PrimitivePour.getAll(params.net, params.layer, params.primitiveLock);
	},

	'pcb.get.pour': async (params) => {
		return eda.pcb_PrimitivePour.get(params.primitiveIds);
	},

	'pcb.create.pour': async (params) => {
		const polygon = eda.pcb_MathPolygon.createPolygon(toClosedPolygonSource(params.polygon) as any);
		if (!polygon) {
			throw new Error('Invalid polygon data');
		}
		return eda.pcb_PrimitivePour.create(
			params.net,
			params.layer,
			polygon,
			params.pourFillMethod,
			params.preserveSilos,
			params.pourName,
			params.pourPriority,
			params.lineWidth,
			params.primitiveLock,
		);
	},

	'pcb.modify.pour': async (params) => {
		return eda.pcb_PrimitivePour.modify(params.primitiveId, params.property);
	},

	'pcb.delete.pour': async (params) => {
		return eda.pcb_PrimitivePour.delete(params.ids);
	},

	// Rebuild pours. Preferred path is the per-pour instance method
	// rebuildCopperRegion() (@beta), which reports a result per pour. The
	// collection call rebuildCopperRegions() (@alpha) is the fallback when the
	// instance method is missing or every per-pour call failed. Handlers get live
	// API objects, so instance methods are callable. Only ids and counts are
	// returned, never the poured geometry.
	'pcb.pour.rebuild': async (params) => {
		const ids: string[] | undefined =
			Array.isArray(params.primitiveIds) && params.primitiveIds.length > 0 ? params.primitiveIds : undefined;
		const found: any[] = ids ? await eda.pcb_PrimitivePour.get(ids) : await eda.pcb_PrimitivePour.getAll();
		const pours: any[] = (Array.isArray(found) ? found : []).filter(Boolean);
		const idOf = (pour: any): string => {
			try {
				return String(pour.getState_PrimitiveId());
			} catch {
				return String(pour?.primitiveId ?? 'unknown');
			}
		};

		const rebuilt: string[] = [];
		const failed: Array<{ id: string; reason: string }> = [];
		let pouredCount = 0;
		let instanceCalls = 0;
		for (const pour of pours) {
			const id = idOf(pour);
			if (typeof pour.rebuildCopperRegion !== 'function') continue;
			instanceCalls++;
			try {
				const poured = await pour.rebuildCopperRegion();
				if (poured === undefined) {
					failed.push({ id, reason: 'EasyEDA returned no copper region for this pour' });
				} else {
					rebuilt.push(id);
					pouredCount++;
				}
			} catch (err) {
				failed.push({ id, reason: firstLine(describeError(err)) });
			}
		}

		const canFallback = typeof (eda.pcb_PrimitivePour as any).rebuildCopperRegions === 'function';
		if ((instanceCalls === 0 || rebuilt.length === 0) && canFallback && (pours.length > 0 || !ids)) {
			try {
				const poured = await eda.pcb_PrimitivePour.rebuildCopperRegions(ids);
				const count = Array.isArray(poured) ? poured.length : 0;
				return {
					method: 'rebuildCopperRegions',
					rebuilt: pours.map(idOf),
					failed: [],
					pouredCount: count,
				};
			} catch (err) {
				failed.push({ id: ids ? ids.join(',') : 'all', reason: `rebuildCopperRegions: ${firstLine(describeError(err))}` });
			}
		}

		const result: Record<string, unknown> = {
			method: instanceCalls > 0 ? 'rebuildCopperRegion' : 'none',
			rebuilt,
			failed,
			pouredCount,
		};
		if (rebuilt.length === 0 && failed.length > 0) result.note = REBUILD_FAILED_NOTE;
		return result;
	},

	// === Fill ===

	'pcb.getAll.fill': async (params) => {
		return eda.pcb_PrimitiveFill.getAll(params.layer, params.net, params.primitiveLock);
	},

	'pcb.get.fill': async (params) => {
		return eda.pcb_PrimitiveFill.get(params.primitiveIds);
	},

	'pcb.create.fill': async (params) => {
		const polygon = eda.pcb_MathPolygon.createPolygon(toClosedPolygonSource(params.polygon) as any);
		if (!polygon) {
			throw new Error('Invalid polygon data');
		}
		const made = await eda.pcb_PrimitiveFill.create(
			params.layer,
			polygon,
			params.net,
			params.fillMode,
			params.lineWidth,
			params.primitiveLock,
		);
		return readBackPrimitive(eda.pcb_PrimitiveFill, made, {
			layer: params.layer,
			net: params.net,
			fillMode: params.fillMode,
			lineWidth: params.lineWidth,
		});
	},

	'pcb.modify.fill': async (params) => {
		const made = await eda.pcb_PrimitiveFill.modify(params.primitiveId, params.property);
		return readBackPrimitive(eda.pcb_PrimitiveFill, made, params.property ?? {});
	},

	'pcb.delete.fill': async (params) => {
		return eda.pcb_PrimitiveFill.delete(params.ids);
	},
};
