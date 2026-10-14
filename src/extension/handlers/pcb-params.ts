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

// Same dead-value bug as layers, for the other numeric enums: region ruleType
// (EPCB_PrimitiveRegionRuleType), via viaType (EPCB_PrimitiveViaType) and fill
// fillMode (EPCB_PrimitiveFillMode). Callers naturally send names, EasyEDA
// stored the string verbatim, and for regions it then saved an empty rule (no
// error). Convert names to the numeric value before any eda.* call.
const REGION_RULE_NAME_TO_ID: Record<string, number> = {
	nocomponents: 2,
	nowires: 5,
	norouting: 5,
	notracks: 5,
	nofills: 6,
	nopours: 7,
	nopour: 7,
	noinnerlayers: 8,
	noinnerelectricallayers: 8,
	followregionrule: 9,
	constraint: 9,
};

const VIA_TYPE_NAME_TO_ID: Record<string, number> = {
	via: 0,
	through: 0,
	throughhole: 0,
	blind: 1,
	buried: 1,
	blindburied: 1,
	suture: 2,
	stitching: 2,
};

const FILL_MODE_NAME_TO_ID: Record<string, number> = {
	solid: 0,
	mesh: 1,
	grid: 1,
	innerelectricallayer: 2,
	innerlayer: 2,
	plane: 2,
};

function toEnumId(value: unknown, table: Record<string, number>, label: string, valid: string): unknown {
	if (value == null || typeof value === 'number') return value;
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed);
	const id = table[trimmed.toLowerCase().replace(/[^a-z0-9]/g, '')];
	if (id !== undefined) return id;
	throw new Error(`Unknown ${label} "${value}". Use ${valid}, or the numeric value.`);
}

/**
 * Region rule type(s): one value or an array. Names ("no_components",
 * "no_wires"/"no_routing", "no_fills", "no_pours", "no_inner_layers",
 * "follow_region_rule"), numbers or numeric strings.
 */
export function toRegionRuleType(ruleType: unknown): unknown {
	const one = (v: unknown) =>
		toEnumId(
			v,
			REGION_RULE_NAME_TO_ID,
			'region rule type',
			'no_components (2), no_wires (5), no_fills (6), no_pours (7), no_inner_layers (8) or follow_region_rule (9)',
		);
	return Array.isArray(ruleType) ? ruleType.map(one) : one(ruleType);
}

/** Via type: "via"/"through" (0), "blind"/"buried" (1), "suture" (2), or the number. */
export function toViaType(viaType: unknown): unknown {
	return toEnumId(viaType, VIA_TYPE_NAME_TO_ID, 'via type', 'through (0), blind (1) or suture (2)');
}

/** Fill mode: "solid" (0), "mesh" (1), "inner_electrical_layer" (2), or the number. */
export function toFillMode(fillMode: unknown): unknown {
	return toEnumId(fillMode, FILL_MODE_NAME_TO_ID, 'fill mode', 'solid (0), mesh (1) or inner_electrical_layer (2)');
}

/** Pick the enum converter for a pcb.* method by its primitive-type suffix. */
function enumFieldFor(method: string): [string, (v: unknown) => unknown] | undefined {
	if (method.endsWith('.region')) return ['ruleType', toRegionRuleType];
	if (method.endsWith('.via')) return ['viaType', toViaType];
	if (method.endsWith('.fill')) return ['fillMode', toFillMode];
	return undefined;
}

/**
 * Normalise layer- and enum-carrying params for pcb.* handler methods: `layer`
 * at the top level plus `layer`/`layerId` inside a modify `property` object,
 * and the per-type enum field (see enumFieldFor) in both places.
 */
export function normalizePcbParams(method: string, params: Record<string, any>): Record<string, any> {
	if (!method.startsWith('pcb.')) return params;
	const out = { ...params };
	const enumField = enumFieldFor(method);
	if (typeof out.layer === 'string') out.layer = toLayerId(out.layer);
	if (enumField && out[enumField[0]] != null) out[enumField[0]] = enumField[1](out[enumField[0]]);
	if (out.property && typeof out.property === 'object' && !Array.isArray(out.property)) {
		const property = { ...out.property };
		if (typeof property.layer === 'string') property.layer = toLayerId(property.layer);
		if (typeof property.layerId === 'string') property.layerId = toLayerId(property.layerId);
		if (enumField && property[enumField[0]] != null) property[enumField[0]] = enumField[1](property[enumField[0]]);
		out.property = property;
	}
	return out;
}

function isPointArray(polygon: unknown): polygon is Array<{ x: number; y: number }> {
	return (
		Array.isArray(polygon) &&
		polygon.length >= 2 &&
		polygon.every(
			(p) => p != null && typeof p === 'object' && typeof (p as any).x === 'number' && typeof (p as any).y === 'number',
		)
	);
}

/**
 * Convert an ergonomic [{x, y}, ...] point array to EasyEDA's polygon source
 * array format. Per the TPCB_PolygonSourceArray JSDoc, L (line) mode is
 * `x1 y1 L x2 y2 x3 y3 ...` — first point's coordinates, THEN the 'L' token,
 * then the remaining points. A leading 'L' fails createPolygon validation.
 * Anything else (e.g. an already-flat source array) passes through untouched.
 */
export function toPolygonSource(polygon: unknown): unknown {
	if (isPointArray(polygon)) {
		const points = polygon;
		const source: Array<string | number> = [points[0].x, points[0].y, 'L'];
		for (const p of points.slice(1)) source.push(p.x, p.y);
		return source;
	}
	return polygon;
}

/**
 * D9: like toPolygonSource, but for CLOSED shapes (pour, fill, region) — a
 * point array is closed automatically (first point appended at the end when
 * the caller has not already done so) before conversion, matching the
 * "last point repeats the first" requirement of the raw L-mode format.
 * Flat source arrays pass through untouched, exactly as before.
 */
export function toClosedPolygonSource(polygon: unknown): unknown {
	if (isPointArray(polygon)) {
		const points = polygon;
		const first = points[0];
		const last = points[points.length - 1];
		const closed = first.x === last.x && first.y === last.y
			? points
			: [...points, { x: first.x, y: first.y }];
		return toPolygonSource(closed);
	}
	return polygon;
}
