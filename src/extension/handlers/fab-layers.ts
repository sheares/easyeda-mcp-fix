// Pure layer selection for the default Gerber / ODB++ export. No `eda` access,
// so it can be unit-tested outside EasyEDA.

export interface FabLayerInfo {
	id: number;
	type: string;
	layerStatus: number;
}

// EPCB_LayerType values worth fabricating. The earlier list used names such as
// TOP_SILK / TOP_SOLDER_MASK that are not EPCB_LayerType values at all (the real
// ones are SIGNAL, PLANE, SILKSCREEN, SOLDER_MASK, PASTE_MASK, ASSEMBLY, OTHER,
// CUSTOM), so only SIGNAL ever matched and silk, mask, paste and PLANE inner
// layers were silently dropped.
const FAB_LAYER_TYPES = new Set(['SIGNAL', 'PLANE', 'SILKSCREEN', 'SOLDER_MASK', 'PASTE_MASK']);

// The board outline is typed OTHER, so it is picked out by id.
const BOARD_OUTLINE_LAYER_ID = 11;

// EPCB_LayerStatus: 0 NOT_USED, 1 SHOW, 2 HIDDEN. A used layer the user has
// merely hidden in the editor must still be fabricated, so only 0 is skipped.
const LAYER_NOT_USED = 0;

export function selectFabLayers(
	layers: FabLayerInfo[],
	mirrorKey: 'isMirror' | 'mirror',
): Array<Record<string, unknown>> {
	return layers
		.filter((l) => l.layerStatus !== LAYER_NOT_USED && (FAB_LAYER_TYPES.has(l.type) || l.id === BOARD_OUTLINE_LAYER_ID))
		.map((l) => ({ layerId: l.id, [mirrorKey]: false }));
}
