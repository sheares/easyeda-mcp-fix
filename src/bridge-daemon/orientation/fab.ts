// Readers for EasyEDA's own fabrication outputs, the files JLC builds from:
// the flying-probe test file (every pad's net and position) and the
// pick-and-place file (each part's pin-1 point, side and rotation). Pure
// module so it can be unit-tested directly.

import { parseCsv, sniffDelimiter } from '../../extension/handlers/csv';

export const MM_PER_MIL = 0.0254;

export interface ProbePad {
	designator: string;
	pad: string;
	net: string;
	/** True when EasyEDA tags the net as ground (NET_TYPE "GND"). */
	groundType: boolean;
	xMm: number;
	yMm: number;
	side?: string;
}

export interface ProbeFile {
	pads: ProbePad[];
	/** EasyEDA lists every pad twice; the second copy is named PADn_<pad>. */
	duplicatePadRows: number;
	/** Rows whose PIN_NAME matched no part on the board. Should be 0. */
	unmatchedRows: string[];
}

function unitToMm(unit: unknown): number {
	const u = String(unit ?? 'mil').toLowerCase();
	if (u === 'mm') return 1;
	if (u === 'inch' || u === 'in') return 25.4;
	return MM_PER_MIL;
}

/**
 * Parse FlyingProbeTesting.json. `designators` are the board's part names;
 * PIN_NAME is "<designator>_<pad>", and designators may themselves contain
 * underscores, so the longest designator prefix wins.
 */
export function parseFlyingProbe(json: unknown, designators: Iterable<string>): ProbeFile {
	const doc = json as { lengthUnit?: string; pins?: { fields?: string[]; rows?: unknown[][] } };
	const fields = doc?.pins?.fields;
	const rows = doc?.pins?.rows;
	if (!Array.isArray(fields) || !Array.isArray(rows)) {
		throw new Error('Flying-probe file has no pins table (expected pins.fields and pins.rows).');
	}
	const scale = unitToMm(doc.lengthUnit);
	const known = [...new Set(designators)].sort((a, b) => b.length - a.length);
	const pads: ProbePad[] = [];
	let duplicatePadRows = 0;
	const unmatchedRows: string[] = [];
	for (const row of rows) {
		const r: Record<string, unknown> = {};
		fields.forEach((f, i) => { r[f] = row[i]; });
		const name = String(r.PIN_NAME ?? '');
		const designator = known.find((d) => name.startsWith(d + '_'));
		if (!designator || typeof r.PIN_X !== 'number' || typeof r.PIN_Y !== 'number') {
			if (/^PAD\d+_/.test(name)) duplicatePadRows += 1;
			else unmatchedRows.push(name);
			continue;
		}
		pads.push({
			designator,
			pad: name.slice(designator.length + 1),
			net: String(r.NET_NAME ?? ''),
			groundType: String(r.NET_TYPE ?? '').toUpperCase() === 'GND',
			xMm: r.PIN_X * scale,
			yMm: r.PIN_Y * scale,
			side: typeof r.LAYER === 'string' ? r.LAYER : undefined,
		});
	}
	return { pads, duplicatePadRows, unmatchedRows };
}

export interface PlacementRow {
	designator: string;
	padXMm: number;
	padYMm: number;
	side?: string;
	rotation?: string;
}

/** Decode a pick-and-place export: UTF-16 (EasyEDA's csv), with or without a byte-order mark, or UTF-8. */
export function decodeText(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
	// UTF-16LE without a BOM: every other byte of ASCII text is zero.
	if (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder('utf-16le').decode(bytes);
	return new TextDecoder('utf-8').decode(bytes);
}

/** "15.25mm", "600.39mil", "0.6in" or a bare number in `defaultUnit`. */
export function lengthToMm(value: string, defaultUnit: 'mm' | 'mil' = 'mm'): number | null {
	const m = /^\s*(-?\d+(?:\.\d+)?)\s*(mm|mil|in|inch)?\s*$/i.exec(value);
	if (!m) return null;
	const n = Number(m[1]);
	const unit = (m[2] ?? defaultUnit).toLowerCase();
	return n * (unit === 'mm' ? 1 : unit === 'mil' ? MM_PER_MIL : 25.4);
}

export function parsePickAndPlace(text: string): PlacementRow[] {
	const records = parseCsv(text, sniffDelimiter(text));
	if (records.length === 0) return [];
	const header = records[0].map((h) => h.trim());
	const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
	const iDes = col('Designator');
	const iPx = col('Pad X');
	const iPy = col('Pad Y');
	if (iDes < 0 || iPx < 0 || iPy < 0) {
		throw new Error(`Pick-and-place file lacks Designator / Pad X / Pad Y columns (got: ${header.join(', ')}).`);
	}
	const iSide = col('Layer');
	const iRot = col('Rotation');
	const out: PlacementRow[] = [];
	for (const rec of records.slice(1)) {
		const designator = (rec[iDes] ?? '').trim();
		const x = lengthToMm(rec[iPx] ?? '');
		const y = lengthToMm(rec[iPy] ?? '');
		if (!designator || x === null || y === null) continue;
		out.push({
			designator,
			padXMm: x,
			padYMm: y,
			side: iSide >= 0 ? rec[iSide]?.trim() : undefined,
			rotation: iRot >= 0 ? rec[iRot]?.trim() : undefined,
		});
	}
	return out;
}
