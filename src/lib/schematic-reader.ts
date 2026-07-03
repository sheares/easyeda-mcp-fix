/**
 * Parses EasyEDA Pro .esch schematic source into a structured model.
 *
 * The raw format is newline-delimited JSON arrays. This reader runs lines
 * through the Zod-backed schema in ./schema/, then builds a clean object
 * model with computed pin world positions, net assignments, and a "palette"
 * of reusable template UUIDs (netport symbol, device, etc.)
 */

import {
	parseEschSource,
	parseEsymSource,
	type ParsedLine,
	type EschLine,
	type EsymLine,
	type ValidationReport,
} from './schema';

export interface PinInfo {
	/** Pin element ID within the symbol (e.g., "e5") */
	symbolPinId: string;
	/** Pin number as string (e.g., "1", "21") */
	number: string;
	/** Pin name (e.g., "PA3", "GND", "IO") */
	name: string;
	/** Pin type (e.g., "IN", "Undefined") */
	pinType: string;
	/** X offset in symbol coordinates */
	symX: number;
	/** Y offset in symbol coordinates */
	symY: number;
	/** Pin stub length */
	length: number;
	/** Pin angle in symbol (0/90/180/270) */
	angle: number;
	/** Computed world X position */
	worldX: number;
	/** Computed world Y position */
	worldY: number;
	/** Pin angle in world coordinates (after component rotation) */
	worldAngle: number;
}

export interface ComponentInfo {
	/** Element ID in the schematic (e.g., "e4422") */
	elementId: string;
	/** Part name (e.g., "CH572D.1", "" for netports/power symbols) */
	partName: string;
	/** Designator (e.g., "U1", "R1") or empty string */
	designator: string;
	/** Component center X in world coordinates */
	x: number;
	/** Component center Y in world coordinates */
	y: number;
	/** Rotation in degrees (0/90/180/270) */
	rotation: number;
	/** Flip (0 or 1) */
	flip: number;
	/** Symbol UUID */
	symbolUuid: string;
	/** Device UUID */
	deviceUuid: string;
	/** Unique ID (e.g., "gge54") */
	uniqueId: string;
	/** Resolved pins with world positions */
	pins: PinInfo[];
	/** All attributes as key-value pairs */
	attrs: Record<string, string>;
	/** Whether this is a netport (symbolType 19) */
	isNetport: boolean;
	/** Whether this is a power symbol (symbolType 18) */
	isPowerSymbol: boolean;
	/** Net name if this is a netport */
	netName: string;
}

export interface WireInfo {
	/** Element ID */
	elementId: string;
	/** Wire segments, each [x1, y1, x2, y2] */
	segments: number[][];
	/** Net name if assigned */
	netName: string;
	/** Whether this is a zero-length junction wire */
	isJunction: boolean;
}

export interface NetInfo {
	/** Net name */
	name: string;
	/** Pins connected to this net: "U1.3(XI)" format */
	connections: string[];
}

export interface SymbolInfo {
	uuid: string;
	symbolType: number;
	pins: Array<{
		id: string;
		number: string;
		name: string;
		pinType: string;
		x: number;
		y: number;
		length: number;
		angle: number;
	}>;
}

export interface ComponentPalette {
	/** Netport: symbol UUID, device UUID, font styles */
	netport?: { symbolUuid: string; deviceUuid: string; fontStyles: Record<string, string> };
	/** Power symbols by name (GND, VCC, etc.) */
	powerSymbols: Record<string, { symbolUuid: string; deviceUuid: string }>;
	/** Component templates by part name */
	components: Record<string, { symbolUuid: string; deviceUuid: string; fontStyles: Record<string, string> }>;
	/** Line style used for wires */
	wireLineStyle: string;
}

export interface SchematicModel {
	/** Parsed+typed lines (preserves raw for round-trip) */
	parsedLines: ParsedLine<EschLine>[];
	/** Raw source lines (derived from parsedLines; kept for API compat) */
	lines: string[];
	/** Parsed HEAD metadata */
	maxId: number;
	/** All components with resolved pins */
	components: ComponentInfo[];
	/** All wires */
	wires: WireInfo[];
	/** Discovered nets */
	nets: Record<string, NetInfo>;
	/** Reusable template UUIDs */
	palette: ComponentPalette;
	/** Highest gge unique ID number found */
	maxGgeId: number;
	/** Font styles defined in this schematic (id -> raw line) */
	fontStyles: Record<string, string>;
	/** Schema validation report for the .esch source */
	validation: ValidationReport;
	/** Schema validation reports for any parsed symbol sources, keyed by symbol UUID */
	symbolValidation: Record<string, ValidationReport>;
}

// Place a symbol-local point into instance coordinates. Mirror (flip about the
// local Y axis) is applied first, then rotation — matching EasyEDA's convention
// and geometry.ts:transformPoint. Translation by the component origin is the
// caller's job.
function transformSymbolPoint(
	sx: number,
	sy: number,
	rotationDeg: number,
	flip: number,
): [number, number] {
	let x = flip ? -sx : sx;
	let y = sy;
	if (rotationDeg !== 0) {
		const rad = (rotationDeg * Math.PI) / 180;
		const cos = Math.cos(rad);
		const sin = Math.sin(rad);
		const rx = x * cos - y * sin;
		const ry = x * sin + y * cos;
		x = rx;
		y = ry;
	}
	return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
}

// Mirror about the local Y axis maps a pin direction θ to 180−θ; rotation then
// adds the instance angle. Normalised to [0, 360).
function transformPinAngle(pinAngle: number, rotationDeg: number, flip: number): number {
	const mirrored = flip ? 180 - pinAngle : pinAngle;
	return (((mirrored + rotationDeg) % 360) + 360) % 360;
}

/**
 * Parse a symbol .esym file to extract pin definitions.
 */
export function parseSymbol(source: string): { symbol: SymbolInfo; validation: ValidationReport } {
	const { lines, report } = parseEsymSource(source);

	let symbolType = 0;
	for (const line of lines) {
		if (line.kind !== 'known') continue;
		if (line.data[0] !== 'HEAD') continue;
		const meta = line.data[1] as { symbolType?: number };
		symbolType = meta?.symbolType ?? 0;
		break;
	}

	const pins: SymbolInfo['pins'] = [];
	let currentPin: SymbolInfo['pins'][number] | null = null;

	for (const line of lines) {
		if (line.kind !== 'known') continue;
		const d = line.data;
		const tag = d[0];

		if (tag === 'PIN') {
			if (currentPin) pins.push(currentPin);
			currentPin = {
				id: d[1] as string,
				x: d[4] as number,
				y: d[5] as number,
				length: d[6] as number,
				angle: d[7] as number,
				number: '',
				name: '',
				pinType: '',
			};
		} else if (tag === 'ATTR' && currentPin && d[2] === currentPin.id) {
			const attrName = d[3] as string;
			const value = d[4];
			if (attrName === 'NAME') currentPin.name = String(value ?? '');
			else if (attrName === 'NUMBER') currentPin.number = String(value ?? '');
			else if (attrName === 'Pin Type') currentPin.pinType = String(value ?? '');
		} else if (tag !== 'ATTR' && tag !== 'FONTSTYLE' && currentPin) {
			pins.push(currentPin);
			currentPin = null;
		}
	}
	if (currentPin) pins.push(currentPin);

	return { symbol: { uuid: '', symbolType, pins }, validation: report };
}

export interface ProjectJson {
	devices?: Record<string, { title?: string; attributes?: Record<string, string> }>;
	[key: string]: unknown;
}

/**
 * Parse an .esch source string into a SchematicModel.
 * @param source - Raw .esch file content
 * @param symbolSources - Map of symbol UUID -> .esym file content (for pin resolution)
 * @param projectJson - Parsed project.json (for resolving device -> symbol when Symbol attr is missing)
 */
export function parseSchematic(
	source: string,
	symbolSources?: Record<string, string>,
	projectJson?: ProjectJson,
): SchematicModel {
	const { lines: parsedLines, report: validation } = parseEschSource(source);

	// maxId from HEAD
	let maxId = 0;
	for (const line of parsedLines) {
		if (line.kind !== 'known') continue;
		if (line.data[0] !== 'HEAD') continue;
		maxId = (line.data[1] as { maxId?: number })?.maxId ?? 0;
		break;
	}

	// Parse symbols
	const symbolCache: Record<string, SymbolInfo> = {};
	const symbolValidation: Record<string, ValidationReport> = {};
	if (symbolSources) {
		for (const [uuid, src] of Object.entries(symbolSources)) {
			const { symbol, validation: vr } = parseSymbol(src);
			symbol.uuid = uuid;
			symbolCache[uuid] = symbol;
			symbolValidation[uuid] = vr;
		}
	}

	// First pass: collect font styles (id -> raw line)
	const fontStyles: Record<string, string> = {};
	for (const line of parsedLines) {
		if (line.kind !== 'known') continue;
		if (line.data[0] !== 'FONTSTYLE') continue;
		fontStyles[line.data[1] as string] = line.raw;
	}

	// Second pass: collect components and their ATTRs
	const components: ComponentInfo[] = [];
	const componentById: Record<string, ComponentInfo> = {};

	for (const line of parsedLines) {
		if (line.kind !== 'known') continue;
		const d = line.data;
		if (d[0] === 'COMPONENT') {
			const comp: ComponentInfo = {
				elementId: d[1] as string,
				partName: (d[2] as string) ?? '',
				x: d[3] as number,
				y: d[4] as number,
				rotation: (d[5] as number) ?? 0,
				flip: (d[6] as number) ?? 0,
				symbolUuid: '',
				deviceUuid: '',
				uniqueId: '',
				designator: '',
				pins: [],
				attrs: {},
				isNetport: false,
				isPowerSymbol: false,
				netName: '',
			};
			components.push(comp);
			componentById[comp.elementId] = comp;
		} else if (d[0] === 'ATTR') {
			const parentId = d[2] as string;
			if (!(parentId in componentById)) continue;
			const comp = componentById[parentId];
			const key = d[3] as string;
			const value = d[4] ?? '';
			comp.attrs[key] = String(value);

			if (key === 'Symbol') comp.symbolUuid = String(value);
			else if (key === 'Device') comp.deviceUuid = String(value);
			else if (key === 'Designator') comp.designator = String(value);
			else if (key === 'Unique ID') comp.uniqueId = String(value);
			else if (key === 'Name' && value) comp.netName = String(value);
		}
	}

	// Resolve missing Symbol UUIDs via project.json device -> symbol mapping
	if (projectJson?.devices) {
		const deviceToSymbol: Record<string, string> = {};
		for (const [devUuid, dev] of Object.entries(projectJson.devices)) {
			const sym = dev.attributes?.Symbol;
			if (sym) deviceToSymbol[devUuid] = sym;
		}
		for (const comp of components) {
			if (!comp.symbolUuid && comp.deviceUuid && deviceToSymbol[comp.deviceUuid]) {
				comp.symbolUuid = deviceToSymbol[comp.deviceUuid];
			}
		}
	}

	// Resolve pin world positions using symbol data
	for (const comp of components) {
		if (!comp.symbolUuid || !symbolCache[comp.symbolUuid]) continue;
		const sym = symbolCache[comp.symbolUuid];

		if (sym.symbolType === 19) comp.isNetport = true;
		if (sym.symbolType === 18) comp.isPowerSymbol = true;

		for (const sp of sym.pins) {
			const [rx, ry] = transformSymbolPoint(sp.x, sp.y, comp.rotation, comp.flip);
			const pin: PinInfo = {
				symbolPinId: sp.id,
				number: sp.number,
				name: sp.name,
				pinType: sp.pinType,
				symX: sp.x,
				symY: sp.y,
				length: sp.length,
				angle: sp.angle,
				worldX: comp.x + rx,
				worldY: comp.y + ry,
				worldAngle: transformPinAngle(sp.angle, comp.rotation, comp.flip),
			};
			comp.pins.push(pin);
		}
	}

	// Parse wires + their NET ATTRs
	const wires: WireInfo[] = [];
	const wireById: Record<string, WireInfo> = {};

	for (const line of parsedLines) {
		if (line.kind !== 'known') continue;
		const d = line.data;
		if (d[0] === 'WIRE') {
			const segments = ((d[2] as number[][]) ?? []) as number[][];
			const isJunction =
				segments.length === 1 &&
				segments[0].length === 4 &&
				segments[0][0] === segments[0][2] &&
				segments[0][1] === segments[0][3];
			const wire: WireInfo = {
				elementId: d[1] as string,
				segments,
				netName: '',
				isJunction,
			};
			wires.push(wire);
			wireById[wire.elementId] = wire;
		} else if (d[0] === 'ATTR' && d[3] === 'NET') {
			const parentId = d[2] as string;
			if (parentId in wireById) {
				wireById[parentId].netName = String(d[4] ?? '');
			}
		}
	}

	// Build net map
	const nets: Record<string, NetInfo> = {};
	for (const wire of wires) {
		if (!wire.netName) continue;
		if (!nets[wire.netName]) {
			nets[wire.netName] = { name: wire.netName, connections: [] };
		}
	}

	// Build palette from existing components + wires
	const palette: ComponentPalette = {
		powerSymbols: {},
		components: {},
		wireLineStyle: 'st9',
	};

	// Helper: collect font styles from ATTR lines whose parent is a given element id
	function collectFontStyles(elementId: string): Record<string, string> {
		const fonts: Record<string, string> = {};
		for (const line of parsedLines) {
			if (line.kind !== 'known') continue;
			const d = line.data;
			if (d[0] !== 'ATTR') continue;
			if (d[2] !== elementId) continue;
			const fs = d[10];
			if (typeof fs === 'string' && fs.startsWith('st')) {
				fonts[d[3] as string] = fs;
			}
		}
		return fonts;
	}

	for (const comp of components) {
		if (comp.isNetport && !palette.netport && comp.symbolUuid && comp.deviceUuid) {
			palette.netport = {
				symbolUuid: comp.symbolUuid,
				deviceUuid: comp.deviceUuid,
				fontStyles: collectFontStyles(comp.elementId),
			};
		}

		if (comp.isPowerSymbol && comp.netName) {
			if (!palette.powerSymbols[comp.netName]) {
				palette.powerSymbols[comp.netName] = {
					symbolUuid: comp.symbolUuid,
					deviceUuid: comp.deviceUuid,
				};
			}
		}

		if (comp.partName && comp.designator && !comp.isNetport && !comp.isPowerSymbol) {
			const basePart = comp.partName.replace(/\.\d+$/, '');
			if (!palette.components[basePart]) {
				palette.components[basePart] = {
					symbolUuid: comp.symbolUuid,
					deviceUuid: comp.deviceUuid,
					fontStyles: collectFontStyles(comp.elementId),
				};
			}
		}
	}

	// Detect wire line style from the first WIRE we see
	for (const line of parsedLines) {
		if (line.kind !== 'known') continue;
		const d = line.data;
		if (d[0] === 'WIRE' && typeof d[3] === 'string') {
			palette.wireLineStyle = d[3];
			break;
		}
	}

	// Find max gge ID
	let maxGgeId = 0;
	for (const comp of components) {
		const m = comp.uniqueId.match(/^gge(\d+)/);
		if (m) {
			maxGgeId = Math.max(maxGgeId, parseInt(m[1], 10));
		}
	}

	const rawLines = source.split('\n');

	return {
		parsedLines,
		lines: rawLines,
		maxId,
		components,
		wires,
		nets,
		palette,
		maxGgeId,
		fontStyles,
		validation,
		symbolValidation,
	};
}
