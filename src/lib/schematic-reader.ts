/**
 * Parses EasyEDA Pro .esch schematic source into a structured model.
 *
 * The raw format is newline-delimited JSON arrays. This reader produces
 * a clean object model with computed pin world positions, net assignments,
 * and a "palette" of reusable template UUIDs (netport symbol, device, etc.)
 */

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
	/** Raw source lines (for editing) */
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
}

function rotatePoint(sx: number, sy: number, rotationDeg: number): [number, number] {
	if (rotationDeg === 0) return [sx, sy];
	const rad = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return [
		Math.round((sx * cos - sy * sin) * 1000) / 1000,
		Math.round((sx * sin + sy * cos) * 1000) / 1000,
	];
}

/**
 * Parse a symbol .esym file to extract pin definitions.
 */
export function parseSymbol(source: string): SymbolInfo {
	const lines = source.split('\n').filter((l) => l.trim());
	const parsed = lines.map((l) => JSON.parse(l));

	const head = parsed.find((r) => r[0] === 'HEAD');
	const symbolType = head?.[1]?.symbolType ?? 0;
	const uuid = ''; // Caller sets this

	const pins: SymbolInfo['pins'] = [];
	let currentPin: any = null;

	for (const row of parsed) {
		if (row[0] === 'PIN') {
			if (currentPin) pins.push(currentPin);
			currentPin = {
				id: row[1],
				x: row[4],
				y: row[5],
				length: row[6],
				angle: row[7],
				number: '',
				name: '',
				pinType: '',
			};
		} else if (row[0] === 'ATTR' && currentPin && row[2] === currentPin.id) {
			if (row[3] === 'NAME') currentPin.name = row[4] ?? '';
			else if (row[3] === 'NUMBER') currentPin.number = row[4] ?? '';
			else if (row[3] === 'Pin Type') currentPin.pinType = row[4] ?? '';
		} else if (row[0] === 'FONTSTYLE') {
			// Skip, doesn't end a pin
		} else if (row[0] !== 'ATTR' && currentPin) {
			pins.push(currentPin);
			currentPin = null;
		}
	}
	if (currentPin) pins.push(currentPin);

	return { uuid, symbolType, pins };
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
export function parseSchematic(source: string, symbolSources?: Record<string, string>, projectJson?: ProjectJson): SchematicModel {
	const lines = source.split('\n');
	const parsedLines: any[][] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			parsedLines.push([]);
			continue;
		}
		try {
			parsedLines.push(JSON.parse(trimmed));
		} catch {
			parsedLines.push([]);
		}
	}

	// Parse HEAD
	const headRow = parsedLines.find((r) => r[0] === 'HEAD');
	const maxId = headRow?.[1]?.maxId ?? 0;

	// Parse symbols if provided
	const symbolCache: Record<string, SymbolInfo> = {};
	if (symbolSources) {
		for (const [uuid, src] of Object.entries(symbolSources)) {
			const sym = parseSymbol(src);
			sym.uuid = uuid;
			symbolCache[uuid] = sym;
		}
	}

	// First pass: collect font styles
	const fontStyles: Record<string, string> = {};
	for (let i = 0; i < parsedLines.length; i++) {
		const row = parsedLines[i];
		if (row[0] === 'FONTSTYLE') {
			fontStyles[row[1]] = lines[i];
		}
	}

	// Second pass: collect components and their attributes
	const components: ComponentInfo[] = [];
	const componentById: Record<string, ComponentInfo> = {};

	for (const row of parsedLines) {
		if (row[0] === 'COMPONENT') {
			const comp: ComponentInfo = {
				elementId: row[1],
				partName: row[2] ?? '',
				x: row[3],
				y: row[4],
				rotation: row[5] ?? 0,
				flip: row[6] ?? 0,
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
		} else if (row[0] === 'ATTR' && row[2] in componentById) {
			const comp = componentById[row[2]];
			const key = row[3] as string;
			const value = row[4] ?? '';
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

	// Resolve pin positions using symbol data
	for (const comp of components) {
		if (!comp.symbolUuid || !symbolCache[comp.symbolUuid]) continue;
		const sym = symbolCache[comp.symbolUuid];

		if (sym.symbolType === 19) comp.isNetport = true;
		if (sym.symbolType === 18) comp.isPowerSymbol = true;

		for (const sp of sym.pins) {
			const [rx, ry] = rotatePoint(sp.x, sp.y, comp.rotation);
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
				worldAngle: (sp.angle + comp.rotation) % 360,
			};
			comp.pins.push(pin);
		}
	}

	// Parse wires
	const wires: WireInfo[] = [];
	const wireById: Record<string, WireInfo> = {};

	for (const row of parsedLines) {
		if (row[0] === 'WIRE') {
			const segments: number[][] = row[2] ?? [];
			const isJunction =
				segments.length === 1 &&
				segments[0].length === 4 &&
				segments[0][0] === segments[0][2] &&
				segments[0][1] === segments[0][3];
			const wire: WireInfo = {
				elementId: row[1],
				segments,
				netName: '',
				isJunction,
			};
			wires.push(wire);
			wireById[wire.elementId] = wire;
		} else if (row[0] === 'ATTR' && row[2] in wireById && row[3] === 'NET') {
			wireById[row[2]].netName = String(row[4] ?? '');
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

	// Build palette by examining existing components
	const palette: ComponentPalette = {
		powerSymbols: {},
		components: {},
		wireLineStyle: 'st9', // Default, will detect
	};

	for (const comp of components) {
		if (comp.isNetport && !palette.netport && comp.symbolUuid && comp.deviceUuid) {
			// Grab font styles from the first netport's attrs
			const netportFonts: Record<string, string> = {};
			for (const row of parsedLines) {
				if (row[0] === 'ATTR' && row[2] === comp.elementId) {
					const fs = row[10];
					if (typeof fs === 'string' && fs.startsWith('st')) {
						netportFonts[row[3]] = fs;
					}
				}
			}
			palette.netport = {
				symbolUuid: comp.symbolUuid,
				deviceUuid: comp.deviceUuid,
				fontStyles: netportFonts,
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
				const compFonts: Record<string, string> = {};
				for (const row of parsedLines) {
					if (row[0] === 'ATTR' && row[2] === comp.elementId) {
						const fs = row[10];
						if (typeof fs === 'string' && fs.startsWith('st')) {
							compFonts[row[3]] = fs;
						}
					}
				}
				palette.components[basePart] = {
					symbolUuid: comp.symbolUuid,
					deviceUuid: comp.deviceUuid,
					fontStyles: compFonts,
				};
			}
		}
	}

	// Detect wire line style from existing wires
	for (const row of parsedLines) {
		if (row[0] === 'WIRE' && typeof row[3] === 'string') {
			palette.wireLineStyle = row[3];
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

	return {
		lines,
		maxId,
		components,
		wires,
		nets,
		palette,
		maxGgeId,
		fontStyles,
	};
}
