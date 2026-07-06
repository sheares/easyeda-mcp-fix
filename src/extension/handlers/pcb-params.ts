// EasyEDA stores whatever we pass as `layer` verbatim, and its pad-to-track
// connectivity test compares layer ids with loose ==. A track created with
// layer:"TopLayer" is stored as layerId:"TopLayer" while native SMD pads store
// layerId:1, so "TopLayer" == 1 is false and the copper is electrically dead —
// silently (clearance DRC still passes). Bug 5: convert layer names to the
// numeric EPCB_LayerId before any eda.* call.
const LAYER_NAME_TO_ID: Record<string, number> = {
	top: 1,
	bottom: 2,
	topsilkscreen: 3,
	topsilk: 3,
	bottomsilkscreen: 4,
	bottomsilk: 4,
	topsoldermask: 5,
	topsolder: 5,
	bottomsoldermask: 6,
	bottomsolder: 6,
	toppastemask: 7,
	toppaste: 7,
	bottompastemask: 8,
	bottompaste: 8,
	topassembly: 9,
	bottomassembly: 10,
	boardoutline: 11,
	outline: 11,
	multi: 12,
	document: 13,
	mechanical: 14,
	ratline: 57,
	topstiffener: 58,
	bottomstiffener: 59,
};

for (let i = 1; i <= 30; i++) {
	LAYER_NAME_TO_ID[`inner${i}`] = 14 + i; // EPCB_LayerId.INNER_1 = 15
	LAYER_NAME_TO_ID[`custom${i}`] = 70 + i; // EPCB_LayerId.CUSTOM_1 = 71
}

/**
 * Convert a layer given as a name ("TopLayer", "Inner3", "bottom_silk") or a
 * numeric string ("1") to the numeric EPCB_LayerId. Numbers pass through.
 * Unknown names throw rather than letting EasyEDA store a dead string id.
 */
export function toLayerId(layer: unknown): unknown {
	if (layer == null || typeof layer === 'number') return layer;
	if (typeof layer !== 'string') return layer;
	const trimmed = layer.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed);
	const compact = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
	const id = LAYER_NAME_TO_ID[compact] ?? LAYER_NAME_TO_ID[compact.replace(/layer/g, '')];
	if (id !== undefined) return id;
	throw new Error(
		`Unknown PCB layer "${layer}". Use a layer name ("TopLayer", "BottomLayer", "Inner1".."Inner30", "Multi", "TopSilkscreen", "BoardOutline", ...) or a numeric EPCB_LayerId (1=Top, 2=Bottom, 12=Multi).`,
	);
}

/**
 * Normalise layer-carrying params for pcb.* handler methods: `layer` at the top
 * level plus `layer`/`layerId` inside a modify `property` object.
 */
export function normalizePcbParams(method: string, params: Record<string, any>): Record<string, any> {
	if (!method.startsWith('pcb.')) return params;
	const out = { ...params };
	if (typeof out.layer === 'string') out.layer = toLayerId(out.layer);
	if (out.property && typeof out.property === 'object' && !Array.isArray(out.property)) {
		const property = { ...out.property };
		if (typeof property.layer === 'string') property.layer = toLayerId(property.layer);
		if (typeof property.layerId === 'string') property.layerId = toLayerId(property.layerId);
		out.property = property;
	}
	return out;
}

/**
 * Convert an ergonomic [{x, y}, ...] point array to EasyEDA's polygon source
 * array format. Per the TPCB_PolygonSourceArray JSDoc, L (line) mode is
 * `x1 y1 L x2 y2 x3 y3 ...` — first point's coordinates, THEN the 'L' token,
 * then the remaining points. A leading 'L' fails createPolygon validation.
 * Anything else (e.g. an already-flat source array) passes through untouched.
 */
export function toPolygonSource(polygon: unknown): unknown {
	if (
		Array.isArray(polygon) &&
		polygon.length >= 2 &&
		polygon.every(
			(p) => p != null && typeof p === 'object' && typeof (p as any).x === 'number' && typeof (p as any).y === 'number',
		)
	) {
		const points = polygon as Array<{ x: number; y: number }>;
		const source: Array<string | number> = [points[0].x, points[0].y, 'L'];
		for (const p of points.slice(1)) source.push(p.x, p.y);
		return source;
	}
	return polygon;
}
