// Orientation check for LEDs, diodes, polarised parts and chips, built only
// on files EasyEDA writes (no live query APIs in the chain, by design: MCP
// query results have been wrong before):
//   - the project export (.epro2): footprint pads and layer-49 marking,
//     symbol pin names, device attributes;
//   - the flying-probe file: every pad's net and position as built;
//   - the pick-and-place file: the pin-1 point JLC places each part from.
// Pure module so it can be unit-tested directly.

import type { DeviceModel, EpruModel, FootprintModel, PcbPart, Point } from './epru';
import type { PlacementRow, ProbeFile, ProbePad } from './fab';

export type PartKind = 'led' | 'diode' | 'polarised' | 'chip';
export type Severity = 'error' | 'review' | 'info';
export type PartStatus = 'ok' | 'review' | 'fail' | 'inconclusive';

export interface Finding {
	severity: Severity;
	designator: string;
	check: 'mark' | 'pin1' | 'polarity' | 'power-pin' | 'coverage' | 'datasheet';
	message: string;
}

export interface PartReport {
	designator: string;
	kind: PartKind;
	side: 'top' | 'bottom' | 'unknown';
	status: PartStatus;
	footprint?: string;
	mpn?: string;
	lcsc?: string;
	/** Where the polarity / pin-1 mark sits, in words. */
	mark?: string;
	/** Distance in mm between the pick-and-place pin-1 point and pad 1. */
	pin1OffsetMm?: number;
	anode?: { pad: string; net: string };
	cathode?: { pad: string; net: string };
	datasheet: { file: string | null; url?: string };
}

export interface OrientationReport {
	verdict: 'pass' | 'fail' | 'review' | 'inconclusive';
	summary: string;
	examined: {
		partsOnBoard: number;
		checked: number;
		byKind: Record<PartKind, number>;
		probePads: number;
		probeDuplicateRows: number;
		placementRows: number;
		skippedNonPolarised: number;
	};
	parts: PartReport[];
	findings: Finding[];
	limits: string[];
}

export interface CheckInput {
	model: EpruModel;
	pcbUuid: string;
	probe: ProbeFile;
	placement: PlacementRow[];
	/** Path of the stashed datasheet for a part, or null when none is stashed. */
	datasheetFor?: (lcsc: string | undefined, mpn: string | undefined) => string | null;
}

const PIN1_TOLERANCE_MM = 0.05;
const MIL_TIE = 2;

const ANODE = new Set(['A', 'ANODE', 'A1']);
const CATHODE = new Set(['K', 'C', 'CATHODE', 'KA', 'K1']);
const PLUS = new Set(['+', 'POS', 'POSITIVE']);
const MINUS = new Set(['-', 'NEG', 'NEGATIVE']);
const PASSIVE_PREFIX = /^(R|C|L|FB|RN|JP|TP|MH|H|FID)\d/i;

export function isGroundNet(net: string, groundType = false): boolean {
	if (groundType) return true;
	return /^(A|D|P|S|C|E)?GND\w*$/i.test(net) || /^VSS\w*$/i.test(net) || /^0V$/i.test(net) || /_GND$/i.test(net);
}

export function isSupplyNet(net: string): boolean {
	if (!net) return false;
	return (
		/^\+/.test(net) ||
		/^V(CC|DD|BUS|BAT|IN|SYS|CHG)\w*$/i.test(net) ||
		/^\d+V\d*(\w*)?$/i.test(net) ||
		/^\d+V$/i.test(net)
	);
}

function isGroundPinName(name: string): boolean {
	return /^(A|D|P|S)?GND\b/i.test(name) || /^VSS/i.test(name);
}

function isSupplyPinName(name: string): boolean {
	return /^(A|D|P)?V(CC|DD)\w*$/i.test(name) || /^VIN\d*$/i.test(name) || /^VBAT$/i.test(name) || /^V\+$/.test(name);
}

function upper(s: string | undefined): string {
	return (s ?? '').trim().toUpperCase();
}

function isLed(designator: string, device: DeviceModel | undefined, fp: FootprintModel | undefined): boolean {
	if (/^LED/i.test(designator)) return true;
	const text = [device?.title, ...(device?.tags ?? []), fp?.title].filter(Boolean).join(' ');
	return /\bLED/i.test(text) || /light emitting/i.test(text);
}

function dist(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The pad nearest the mark, for the report's wording only. */
function nearestPad(fp: FootprintModel, mark: Point): string | undefined {
	let best: { num: string; d: number } | undefined;
	for (const p of fp.pads) {
		const d = dist(p, mark);
		if (!best || d < best.d) best = { num: p.num, d };
	}
	return best?.num;
}

export interface MarkVerdict {
	/** The mark is nearest the target pad as placed, not as turned. */
	ok: boolean;
	/** The best turned position is almost as close: the mark does not settle it. */
	ambiguous: boolean;
	/** Rotation (degrees) whose target position sits nearest the mark; 0 means as placed. */
	bestTurn: number;
}

/**
 * Does the footprint's marking point at the target pad (pin 1, or the
 * cathode)? Asking "which pad is nearest the mark" fails on real parts: a
 * QFN's corner dot can sit nearer pad 2 than pad 1, and a module's dot sits
 * off at the body corner. The error that matters is the part turned on its
 * footprint, so ask instead: of the target pad's position as placed and as
 * turned 90, 180 and 270 degrees about the footprint centre, which is nearest
 * the mark? Only "as placed" may win, and clearly. Two-pad parts can only be
 * turned 180 degrees.
 */
export function judgeMark(fp: FootprintModel, mark: Point, target: Point): MarkVerdict {
	const xs = fp.pads.map((p) => p.x);
	const ys = fp.pads.map((p) => p.y);
	const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
	const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
	const dx = target.x - cx;
	const dy = target.y - cy;
	const turns = fp.pads.length === 2 ? [0, 180] : [0, 90, 180, 270];
	const at = (deg: number): Point => {
		const r = (deg * Math.PI) / 180;
		return { x: cx + dx * Math.cos(r) - dy * Math.sin(r), y: cy + dx * Math.sin(r) + dy * Math.cos(r) };
	};
	const ranked = turns.map((t) => ({ t, d: dist(at(t), mark) })).sort((a, b) => a.d - b.d);
	const asPlaced = ranked.find((r) => r.t === 0)!.d;
	const otherBest = Math.min(...ranked.filter((r) => r.t !== 0).map((r) => r.d));
	return {
		ok: ranked[0].t === 0,
		ambiguous: Math.abs(otherBest - asPlaced) <= Math.max(MIL_TIE, 0.2 * Math.min(otherBest, asPlaced)),
		bestTurn: ranked[0].t,
	};
}

function sideOf(part: PcbPart): PartReport['side'] {
	return part.layerId === 1 ? 'top' : part.layerId === 2 ? 'bottom' : 'unknown';
}

export function checkOrientation(input: CheckInput): OrientationReport {
	const { model, probe, placement } = input;
	const findings: Finding[] = [];
	const parts: PartReport[] = [];
	const byKind: Record<PartKind, number> = { led: 0, diode: 0, polarised: 0, chip: 0 };

	let pcb = model.pcbs.get(input.pcbUuid);
	if (!pcb && model.pcbs.size === 1) pcb = [...model.pcbs.values()][0];
	if (!pcb) {
		throw new Error(`PCB ${input.pcbUuid} is not in the project export (it holds ${[...model.pcbs.keys()].join(', ') || 'no PCB'}).`);
	}

	const probeBy = new Map<string, ProbePad[]>();
	for (const p of probe.pads) {
		const list = probeBy.get(p.designator) ?? [];
		list.push(p);
		probeBy.set(p.designator, list);
	}
	const placeBy = new Map(placement.map((r) => [r.designator, r]));
	let skipped = 0;

	for (const part of pcb.parts) {
		const des = part.designator;
		if (!des) continue;
		const fp = part.footprint ? model.footprints.get(part.footprint) : undefined;
		const device = part.device ? model.devices.get(part.device) : undefined;
		const symbol = device?.attributes.Symbol ? model.symbols.get(device.attributes.Symbol) : undefined;
		const pads = probeBy.get(des) ?? [];
		const padCount = fp?.pads.length ?? pads.length;

		// Pin number -> pin name, from the symbol.
		const nameOf = new Map<string, string>();
		for (const pin of symbol?.pins ?? []) if (pin.number) nameOf.set(pin.number, upper(pin.name));
		const pinsNamed = (set: Set<string>) => [...nameOf].filter(([, n]) => set.has(n)).map(([num]) => num);
		const anodePins = pinsNamed(ANODE);
		const cathodePins = pinsNamed(CATHODE);

		let kind: PartKind | null = null;
		if (padCount === 2 && anodePins.length === 1 && cathodePins.length === 1) kind = isLed(des, device, fp) ? 'led' : 'diode';
		else if (padCount === 2 && pinsNamed(PLUS).length === 1 && pinsNamed(MINUS).length === 1) kind = 'polarised';
		else if (padCount >= 3 && !PASSIVE_PREFIX.test(des)) kind = 'chip';
		else if (padCount === 2 && /^(D|LED)\d/i.test(des)) kind = isLed(des, device, fp) ? 'led' : 'diode';
		if (!kind) {
			skipped += 1;
			continue;
		}
		byKind[kind] += 1;

		const lcsc = device?.attributes['Supplier Part'];
		const mpn = device?.attributes['Manufacturer Part'] ?? device?.title;
		const report: PartReport = {
			designator: des,
			kind,
			side: sideOf(part),
			status: 'ok',
			footprint: fp?.title,
			mpn,
			lcsc,
			datasheet: { file: input.datasheetFor?.(lcsc, mpn) ?? null, url: device?.attributes.Datasheet },
		};
		const mine: Finding[] = [];
		const add = (severity: Severity, check: Finding['check'], message: string) => mine.push({ severity, designator: des, check, message });
		let gap = false;

		if (!symbol || nameOf.size === 0) {
			add('review', 'coverage', 'No symbol pin names in the export, so the cathode / pin 1 cannot be identified from the schematic.');
			gap = true;
		}
		if ((kind === 'led' || kind === 'diode') && (anodePins.length !== 1 || cathodePins.length !== 1)) {
			add('review', 'coverage', `The symbol does not name one anode and one cathode (pin names: ${[...nameOf].map(([n, v]) => `${n}=${v || '?'}`).join(', ') || 'none'}). Read the datasheet to say which pad is the cathode.`);
			gap = true;
		}

		// --- 1. Polarity / pin-1 mark on the footprint, against the symbol.
		const target = kind === 'chip' ? ['1'] : kind === 'polarised' ? pinsNamed(PLUS) : cathodePins;
		const targetWord = kind === 'chip' ? 'pin 1' : kind === 'polarised' ? 'the + pin' : 'the cathode';
		if (!fp) {
			add('review', 'coverage', 'Footprint not found in the project export.');
			gap = true;
		} else if (fp.marks.length === 0) {
			add('review', 'mark', `Footprint ${fp.title ?? part.footprint} has no component-marking feature (layer 49). Check the silkscreen polarity mark by eye against the datasheet.`);
		} else if (target.length === 0 || !fp.pads.some((p) => target.includes(p.num))) {
			add('review', 'mark', `Cannot test the mark: the footprint has no pad ${target.join('/') || '(unknown)'} for ${targetWord}.`);
		} else {
			const label = (n: string) => `pad ${n}${nameOf.get(n) ? ` (${nameOf.get(n)})` : ''}`;
			const targetPad = fp.pads.find((p) => target.includes(p.num))!;
			const verdict = judgeMark(fp, fp.marks[0], targetPad);
			const near = nearestPad(fp, fp.marks[0]);
			report.mark = verdict.ok && !verdict.ambiguous
				? `marks ${targetWord} (${label(targetPad.num)}); nearest pad ${near}`
				: `nearest pad ${near}; it would point at ${targetWord} only with the part turned ${verdict.bestTurn} degrees`;
			if (kind === 'polarised') {
				add('info', 'mark', `Marking feature: ${report.mark}. Conventions differ for polarised parts; confirm against the datasheet's marking.`);
			} else if (!verdict.ok) {
				add('error', 'mark', `The footprint's polarity mark does not point at ${targetWord} (${label(targetPad.num)}): ${targetWord} would sit by the mark only with the part turned ${verdict.bestTurn} degrees. An assembler lining the part's marking up with it would fit the part the wrong way round.`);
			} else if (verdict.ambiguous) {
				report.mark = `ambiguous: the mark sits about as near ${targetWord} as placed as turned`;
				add('review', 'mark', `The footprint's mark does not clearly single out ${targetWord} (${label(targetPad.num)}). Check the silkscreen and the datasheet's package drawing by eye.`);
			}
		}

		// --- 2. Pick-and-place pin 1 against the probe's pad 1.
		const place = placeBy.get(des);
		const pad1 = pads.find((p) => p.pad === '1');
		if (!place) {
			add('info', 'pin1', 'Not in the pick-and-place file (not assembled by the fab, or marked do-not-place).');
		} else if (!pad1) {
			add('review', 'pin1', 'The flying-probe file has no pad 1 for this part, so the pick-and-place pin 1 cannot be tested.');
			gap = true;
		} else {
			const off = Math.hypot(place.padXMm - pad1.xMm, place.padYMm - pad1.yMm);
			report.pin1OffsetMm = Math.round(off * 1000) / 1000;
			if (off > PIN1_TOLERANCE_MM) {
				add('error', 'pin1', `The pick-and-place pin-1 point is ${off.toFixed(2)} mm from pad 1 (file: ${place.padXMm.toFixed(2)}, ${place.padYMm.toFixed(2)} mm; pad 1: ${pad1.xMm.toFixed(2)}, ${pad1.yMm.toFixed(2)} mm). The fab may place this part rotated.`);
			}
		}

		// --- 3. Electrical polarity from the built nets.
		const netOf = (pin: string) => pads.find((p) => p.pad === pin);
		if ((kind === 'led' || kind === 'diode') && anodePins.length === 1 && cathodePins.length === 1) {
			const a = netOf(anodePins[0]);
			const k = netOf(cathodePins[0]);
			if (a) report.anode = { pad: a.pad, net: a.net };
			if (k) report.cathode = { pad: k.pad, net: k.net };
			if (!a || !k) {
				add('review', 'coverage', 'The flying-probe file lacks the anode or cathode pad.');
				gap = true;
			} else if (kind === 'led') {
				if (isGroundNet(a.net, a.groundType)) add('error', 'polarity', `LED anode (pad ${a.pad}) is on ground net ${a.net}: the LED is reversed or miswired.`);
				if (isSupplyNet(k.net)) add('error', 'polarity', `LED cathode (pad ${k.pad}) is on supply net ${k.net}: the LED is reversed or miswired.`);
			} else if (isSupplyNet(a.net) && isGroundNet(k.net, k.groundType)) {
				add('error', 'polarity', `Diode anode on supply ${a.net} and cathode on ground ${k.net}: it conducts straight across the supply.`);
			} else {
				add('info', 'polarity', `Anode on ${a.net || '(no net)'}, cathode on ${k.net || '(no net)'}. Check this matches the diode's job (TVS, flyback, reverse protection).`);
			}
		}
		if (kind === 'chip') {
			for (const [num, name] of nameOf) {
				const pad = netOf(num);
				if (!pad || !pad.net) continue;
				if (isGroundPinName(name) && !isGroundNet(pad.net, pad.groundType)) {
					add(isSupplyNet(pad.net) ? 'error' : 'review', 'power-pin', `Pin ${num} (${name}) is on ${pad.net}, not a ground net.`);
				}
				if (isSupplyPinName(name) && isGroundNet(pad.net, pad.groundType)) {
					add('error', 'power-pin', `Pin ${num} (${name}) is on ground net ${pad.net}.`);
				}
			}
		}

		// --- 4. Datasheet: nothing is signed off without one.
		if (kind !== 'polarised' && !report.datasheet.file) {
			add('review', 'datasheet', 'No datasheet stashed for this part. Run project_fetch_datasheets, then read its pin-configuration and marking sections before signing it off.');
		}

		report.status = mine.some((f) => f.severity === 'error')
			? 'fail'
			: gap
				? 'inconclusive'
				: mine.some((f) => f.severity === 'review')
					? 'review'
					: 'ok';
		parts.push(report);
		findings.push(...mine);
	}

	for (const name of probe.unmatchedRows) {
		findings.push({ severity: 'review', designator: name.split('_')[0], check: 'coverage', message: `Flying-probe row ${name} matches no part on this PCB in the project export.` });
	}
	for (const row of placement) {
		if (!pcb.parts.some((p) => p.designator === row.designator)) {
			findings.push({ severity: 'review', designator: row.designator, check: 'coverage', message: 'In the pick-and-place file but not on this PCB in the project export.' });
		}
	}

	const count = (s: PartStatus) => parts.filter((p) => p.status === s).length;
	const verdict: OrientationReport['verdict'] = parts.length === 0
		? 'inconclusive'
		: count('fail') > 0
			? 'fail'
			: count('inconclusive') > 0
				? 'inconclusive'
				: count('review') > 0
					? 'review'
					: 'pass';
	const summary = `${parts.length} polarised parts and chips checked (${byKind.led} LED, ${byKind.diode} diode, ${byKind.polarised} other polarised, ${byKind.chip} chip): ${count('ok')} ok, ${count('review')} to review, ${count('fail')} failing, ${count('inconclusive')} inconclusive. ${skipped} non-polarised two-pad parts skipped.`;

	return {
		verdict,
		summary,
		examined: {
			partsOnBoard: pcb.parts.filter((p) => p.designator).length,
			checked: parts.length,
			byKind,
			probePads: probe.pads.length,
			probeDuplicateRows: probe.duplicatePadRows,
			placementRows: placement.length,
			skippedNonPolarised: skipped,
		},
		parts,
		findings,
		limits: [
			'The mark check compares the footprint\'s own layer-49 marking with the symbol\'s pin names. Whether the real part\'s cathode or pin 1 is where the footprint says is a datasheet question: read the package drawing.',
			'The pin-1 check compares two EasyEDA outputs. The fab applies its own rotation library on top, so still check its placement preview before paying.',
			'Power-pin and LED net checks go by net and pin names; an unusual naming scheme can hide a fault.',
		],
	};
}
