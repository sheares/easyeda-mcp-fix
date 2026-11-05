// Reader for the .epru inside an EasyEDA Pro 3 .epro2 project export: one
// `{header}||{body}|` record per line, documents opened by a DOCHEAD record.
// Pure module (no I/O) so it can be unit-tested directly.
//
// Only what the orientation check and the datasheet stash need is kept:
// PCB parts (designator, footprint, device, side, position), footprint pads
// and layer-49 component-marking features, symbol pin names and numbers, and
// device attributes (symbol, footprint, LCSC number, MPN, datasheet URL).
//
// TRAP (cost a backwards LED once): PIN element ids such as "e5" repeat across
// symbols, so pins are keyed by (symbol uuid, pin id), never by id alone.

/** EasyEDA's component-marking layer: pin 1 on ICs, the cathode on diodes. */
export const COMPONENT_MARKING_LAYER = 49;

export interface Point {
	x: number;
	y: number;
}

export interface FootprintPad extends Point {
	num: string;
}

export interface FootprintModel {
	uuid: string;
	title?: string;
	pads: FootprintPad[];
	/** Centres of the layer-49 marking features, in footprint-local units (mil). */
	marks: Point[];
	/** Layer-49 features whose shape this reader cannot locate. */
	unreadableMarks: number;
}

export interface SymbolPin {
	name?: string;
	number?: string;
}

export interface SymbolModel {
	uuid: string;
	pins: SymbolPin[];
}

export interface DeviceModel {
	uuid: string;
	title?: string;
	tags: string[];
	attributes: Record<string, string>;
}

export interface PcbPart extends Point {
	id: string;
	designator?: string;
	footprint?: string;
	device?: string;
	/** 1 = top, 2 = bottom. */
	layerId?: number;
	angle?: number;
}

export interface PcbModel {
	uuid: string;
	parts: PcbPart[];
}

export interface SchematicPart {
	designator?: string;
	device?: string;
}

export interface EpruModel {
	pcbs: Map<string, PcbModel>;
	footprints: Map<string, FootprintModel>;
	symbols: Map<string, SymbolModel>;
	devices: Map<string, DeviceModel>;
	schematicParts: SchematicPart[];
	/** Lines that were not `{header}||{body}` JSON. Reported, never silently dropped. */
	unparsedLines: number;
}

export function parseLine(line: string): { header: any; body: any } | null {
	const sep = line.indexOf('||');
	if (sep < 0) return null;
	let bodyText = line.slice(sep + 2);
	if (bodyText.endsWith('|')) bodyText = bodyText.slice(0, -1);
	try {
		const header = JSON.parse(line.slice(0, sep));
		const body = bodyText.trim() === '' ? null : JSON.parse(bodyText);
		return { header, body };
	} catch {
		return null;
	}
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : undefined;
}

/** Centre of one FILL path entry, or null when its shape is not one this reader knows. */
export function markCentre(path: unknown): Point | null {
	if (!Array.isArray(path) || path.length === 0) return null;
	// Circle: ['CIRCLE', cx, cy, r]
	if (path[0] === 'CIRCLE' && typeof path[1] === 'number' && typeof path[2] === 'number') {
		return { x: path[1], y: path[2] };
	}
	// Polygon source: x1 y1 'L' x2 y2 ... (optionally 'ARC'/'CARC' tokens with
	// numeric arguments). Other leading tokens ('R' rectangles and the like)
	// are not decoded here.
	if (typeof path[0] !== 'number') return null;
	const nums: number[] = [];
	for (const v of path) {
		if (typeof v === 'number') nums.push(v);
		else if (v !== 'L') return null;
	}
	if (nums.length < 2 || nums.length % 2 !== 0) return null;
	let sx = 0;
	let sy = 0;
	const n = nums.length / 2;
	for (let i = 0; i < nums.length; i += 2) {
		sx += nums[i];
		sy += nums[i + 1];
	}
	return { x: sx / n, y: sy / n };
}

export function parseEpru(text: string): EpruModel {
	const model: EpruModel = {
		pcbs: new Map(),
		footprints: new Map(),
		symbols: new Map(),
		devices: new Map(),
		schematicParts: [],
		unparsedLines: 0,
	};

	let docType: string | undefined;
	let docUuid = '';
	// Per-document scratch, flushed when the next DOCHEAD arrives.
	let pcbParts = new Map<string, PcbPart>();
	let pcbAttrs = new Map<string, Record<string, string>>();
	let pins = new Map<string, SymbolPin>();
	let pinAttrs: Array<{ parent: string; key: string; value: string }> = [];
	let footprint: FootprintModel | null = null;
	let schComponents = new Set<string>();
	let schAttrs = new Map<string, Record<string, string>>();

	const flush = () => {
		if (docType === 'PCB') {
			for (const [id, attrs] of pcbAttrs) {
				const part = pcbParts.get(id);
				if (!part) continue;
				part.designator = attrs.Designator ?? part.designator;
				part.footprint = attrs.Footprint ?? part.footprint;
				part.device = attrs.Device ?? part.device;
			}
			model.pcbs.set(docUuid, { uuid: docUuid, parts: [...pcbParts.values()] });
		} else if (docType === 'SYMBOL') {
			for (const a of pinAttrs) {
				const pin = pins.get(a.parent);
				if (!pin) continue;
				if (a.key === 'Pin Name' || a.key === 'NAME') pin.name = a.value;
				if (a.key === 'Pin Number' || a.key === 'NUMBER') pin.number = a.value;
			}
			model.symbols.set(docUuid, { uuid: docUuid, pins: [...pins.values()] });
		} else if (docType === 'FOOTPRINT' && footprint) {
			model.footprints.set(docUuid, footprint);
		} else if (docType === 'SCH_PAGE') {
			for (const id of schComponents) {
				const a = schAttrs.get(id) ?? {};
				if (a.Designator || a.Device) model.schematicParts.push({ designator: a.Designator, device: a.Device });
			}
		}
		pcbParts = new Map();
		pcbAttrs = new Map();
		pins = new Map();
		pinAttrs = [];
		footprint = null;
		schComponents = new Set();
		schAttrs = new Map();
	};

	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		const rec = parseLine(line);
		if (!rec) {
			model.unparsedLines += 1;
			continue;
		}
		const { header, body } = rec;
		const type = header?.type;
		if (type === 'DOCHEAD') {
			flush();
			docType = str(body?.docType);
			docUuid = str(body?.uuid) ?? '';
			if (docType === 'FOOTPRINT') footprint = { uuid: docUuid, pads: [], marks: [], unreadableMarks: 0 };
			continue;
		}
		if (!body || typeof body !== 'object') continue;
		const id = str(header?.id) ?? '';

		switch (docType) {
			case 'PCB':
				if (type === 'COMPONENT' && typeof body.x === 'number' && typeof body.y === 'number') {
					pcbParts.set(id, { id, x: body.x, y: body.y, layerId: body.layerId, angle: body.angle });
				} else if (type === 'ATTR' && body.parentId && typeof body.key === 'string') {
					const value = str(body.value);
					if (value !== undefined) {
						const bag = pcbAttrs.get(body.parentId) ?? {};
						bag[body.key] = value;
						pcbAttrs.set(body.parentId, bag);
					}
				}
				break;
			case 'FOOTPRINT':
				if (!footprint) break;
				if (type === 'PAD' && body.num != null && typeof body.centerX === 'number' && typeof body.centerY === 'number') {
					footprint.pads.push({ num: String(body.num), x: body.centerX, y: body.centerY });
				} else if (type === 'FILL' && body.layerId === COMPONENT_MARKING_LAYER) {
					const paths: unknown[] = Array.isArray(body.path) ? body.path : [];
					let found = false;
					for (const p of paths) {
						const c = markCentre(p);
						if (c) {
							footprint.marks.push(c);
							found = true;
							break;
						}
					}
					if (!found) footprint.unreadableMarks += 1;
				} else if (type === 'ATTR' && body.key === 'Footprint') {
					footprint.title = str(body.value) ?? footprint.title;
				}
				break;
			case 'SYMBOL':
				if (type === 'PIN') pins.set(id, {});
				else if (type === 'ATTR' && body.parentId && typeof body.key === 'string') {
					const value = str(body.value);
					if (value !== undefined) pinAttrs.push({ parent: body.parentId, key: body.key, value });
				}
				break;
			case 'DEVICE':
				if (type === 'META') {
					const attributes: Record<string, string> = {};
					for (const [k, v] of Object.entries(body.attributes ?? {})) {
						const s = str(v);
						if (s !== undefined) attributes[k] = s;
					}
					model.devices.set(docUuid, {
						uuid: docUuid,
						title: str(body.title),
						tags: Array.isArray(body.tags) ? body.tags.filter((t: unknown) => typeof t === 'string') : [],
						attributes,
					});
				}
				break;
			case 'SCH_PAGE':
				if (type === 'COMPONENT') schComponents.add(id);
				else if (type === 'ATTR' && body.parentId && typeof body.key === 'string') {
					const value = str(body.value);
					if (value !== undefined) {
						const bag = schAttrs.get(body.parentId) ?? {};
						bag[body.key] = value;
						schAttrs.set(body.parentId, bag);
					}
				}
				break;
		}
	}
	flush();
	return model;
}
