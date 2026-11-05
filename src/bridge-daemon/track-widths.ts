// Copper track widths against the track rule that applies to each net, read
// from EasyEDA's own project export (.epro2 › .epru), not live queries. Pure
// module so it can be unit-tested with ts-node.
//
// Why: on EasyEDA Pro 3.2.209 the autorouter used one width on every net,
// ignoring net-class track rules, and EasyEDA's own DRC did not report the
// tracks it left below their class minimum (5 Nov 2026, a 4-layer test board).
//
// Inside a PCB document lengths are mil; a rule's `unit` field is only its
// display unit. A net's track rule is taken from, in order: its own
// RULE_SELECTOR ["NET", name], its differential pair's, its net class's
// (NET.netType), then the board's DEFAULT track rule. That order is assumed;
// EasyEDA does not document it.

import { parseLine } from './orientation/epru';

const MIL_TO_MM = 0.0254;
/** Widths within this of a limit count as on it (exports round to 4 decimals). */
const EPS_MIL = 0.01;
const MAX_IDS = 10;

export interface TrackRuleEntry {
	layerId?: number;
	minMil: number;
	defMil: number;
	maxMil: number;
}

export interface TrackRule {
	name: string;
	isDefault: boolean;
	entries: TrackRuleEntry[];
}

export interface CopperTrack {
	id: string;
	kind: 'LINE' | 'ARC' | 'POLY';
	net: string;
	layerId: number;
	widthMil: number;
	/** null when the path holds a shape this reader does not measure */
	lengthMil: number | null;
	at: { x: number; y: number };
}

export interface CopperModel {
	pcbUuid: string;
	pcbCount: number;
	rules: Map<string, TrackRule>;
	netRule: Map<string, string>;
	pairRule: Map<string, string>;
	classRule: Map<string, string>;
	/** Net classes named by a selector, with or without a track rule. */
	classes: Set<string>;
	netClass: Map<string, string>;
	netPair: Map<string, string>;
	tracks: CopperTrack[];
	copperFills: Map<string, number>;
}

export function isCopperLayer(layerId: unknown): layerId is number {
	return layerId === 1 || layerId === 2 || (typeof layerId === 'number' && layerId >= 15 && layerId <= 46);
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function arcLength(chord: number, angleDeg: number | undefined): number {
	if (angleDeg === undefined || angleDeg === 0) return chord;
	const half = (Math.abs(angleDeg) * Math.PI) / 360;
	return Math.sin(half) === 0 ? chord : (chord * half) / Math.sin(half);
}

/** Length of a POLY path: x y 'L' x y ... with optional 'ARC' / 'CARC' angle x y steps. */
export function polyLength(path: unknown): { length: number | null; start: { x: number; y: number } | null } {
	if (!Array.isArray(path) || typeof path[0] !== 'number' || typeof path[1] !== 'number') return { length: null, start: null };
	const start = { x: path[0], y: path[1] };
	let x = path[0];
	let y = path[1];
	let total = 0;
	let i = 2;
	let arc = false;
	while (i < path.length) {
		const t = path[i];
		if (t === 'L') { arc = false; i += 1; continue; }
		if (t === 'ARC' || t === 'CARC') { arc = true; i += 1; continue; }
		if (typeof t !== 'number') return { length: null, start };
		if (arc) {
			const angle = t;
			const nx = num(path[i + 1]);
			const ny = num(path[i + 2]);
			if (nx === undefined || ny === undefined) return { length: null, start };
			total += arcLength(Math.hypot(nx - x, ny - y), angle);
			x = nx;
			y = ny;
			i += 3;
			continue;
		}
		const ny = num(path[i + 1]);
		if (ny === undefined) return { length: null, start };
		total += Math.hypot(t - x, ny - y);
		x = t;
		y = ny;
		i += 2;
	}
	return { length: total, start };
}

function ruleEntries(body: any): TrackRuleEntry[] {
	const content = body?.ruleContext?.track?.content;
	if (!Array.isArray(content)) return [];
	const out: TrackRuleEntry[] = [];
	for (const c of content) {
		const minMil = num(c?.stroMin);
		const defMil = num(c?.stroDef);
		const maxMil = num(c?.stroMax);
		if (minMil === undefined || defMil === undefined || maxMil === undefined) continue;
		out.push({ layerId: num(c?.layerId), minMil, defMil, maxMil });
	}
	return out;
}

function parseId(id: unknown): unknown[] | null {
	if (typeof id !== 'string' || !id.startsWith('[')) return null;
	try {
		const v = JSON.parse(id);
		return Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

/**
 * The copper of one PCB document in an .epru stream.
 * @param pcbUuid - the PCB document's uuid (the part before '@' in a document id); optional when the export holds one PCB
 */
export function parsePcbCopper(text: string, pcbUuid?: string): CopperModel | null {
	// Records per PCB document, latest ticket per id.
	const docs = new Map<string, Map<string, { header: any; body: any }>>();
	let current: Map<string, { header: any; body: any }> | null = null;
	let seq = 0;
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		const rec = parseLine(line);
		if (!rec) continue;
		const { header, body } = rec;
		if (header?.type === 'DOCHEAD') {
			current = null;
			if (body?.docType === 'PCB' && typeof body.uuid === 'string') {
				current = docs.get(body.uuid) ?? new Map();
				docs.set(body.uuid, current);
			}
			continue;
		}
		if (!current) continue;
		const key = `${header?.type}:${typeof header?.id === 'string' ? header.id : `#${seq++}`}`;
		const before = current.get(key);
		const ticket = num(header?.ticket) ?? 0;
		if (!before || (num(before.header?.ticket) ?? 0) <= ticket) current.set(key, { header, body });
	}
	const uuid = pcbUuid && docs.has(pcbUuid) ? pcbUuid : docs.size === 1 ? [...docs.keys()][0] : undefined;
	if (!uuid) return null;

	const model: CopperModel = {
		pcbUuid: uuid,
		pcbCount: docs.size,
		rules: new Map(),
		netRule: new Map(),
		pairRule: new Map(),
		classRule: new Map(),
		classes: new Set(),
		netClass: new Map(),
		netPair: new Map(),
		tracks: [],
		copperFills: new Map(),
	};
	for (const { header, body } of docs.get(uuid)!.values()) {
		const type = header?.type;
		if (!body || typeof body !== 'object') continue;
		const idParts = parseId(header?.id);
		if (type === 'RULE' && idParts?.[1] === 'TRACK' && typeof idParts[2] === 'string') {
			const entries = ruleEntries(body);
			if (entries.length > 0) model.rules.set(idParts[2], { name: idParts[2], isDefault: body.ruleState === 'DEFAULT', entries });
		} else if (type === 'RULE_SELECTOR' && idParts && Array.isArray(idParts[1])) {
			const [scope, name] = idParts[1] as unknown[];
			if (typeof name !== 'string') continue;
			if (scope === 'NET_CLASS') model.classes.add(name);
			const track = body.ruleKeyValue?.TRACK;
			if (typeof track !== 'string' || track === '') continue;
			if (scope === 'NET') model.netRule.set(name, track);
			else if (scope === 'DIFF_PAIR') model.pairRule.set(name, track);
			else if (scope === 'NET_CLASS') model.classRule.set(name, track);
		} else if (type === 'NET' && idParts && typeof idParts[1] === 'string' && idParts[1] !== '') {
			if (typeof body.netType === 'string' && body.netType) model.netClass.set(idParts[1], body.netType);
			if (typeof body.differentialName === 'string' && body.differentialName) model.netPair.set(idParts[1], body.differentialName);
		} else if ((type === 'LINE' || type === 'ARC' || type === 'POLY') && isCopperLayer(body.layerId)) {
			const net = typeof body.netName === 'string' ? body.netName : '';
			const widthMil = num(body.width);
			if (!net || widthMil === undefined) continue;
			const id = typeof header.id === 'string' ? header.id : '';
			if (type === 'POLY') {
				const { length, start } = polyLength(body.path);
				if (!start) continue;
				model.tracks.push({ id, kind: 'POLY', net, layerId: body.layerId, widthMil, lengthMil: length, at: start });
			} else {
				const sx = num(body.startX);
				const sy = num(body.startY);
				const ex = num(body.endX);
				const ey = num(body.endY);
				if (sx === undefined || sy === undefined || ex === undefined || ey === undefined) continue;
				const chord = Math.hypot(ex - sx, ey - sy);
				const lengthMil = type === 'ARC' ? arcLength(chord, num(body.arcAngle)) : chord;
				model.tracks.push({ id, kind: type, net, layerId: body.layerId, widthMil, lengthMil, at: { x: sx, y: sy } });
			}
		} else if (type === 'FILL' && isCopperLayer(body.layerId) && typeof body.netName === 'string' && body.netName) {
			model.copperFills.set(body.netName, (model.copperFills.get(body.netName) ?? 0) + 1);
		}
	}
	return model;
}

export interface AppliedRule {
	rule?: TrackRule;
	source?: 'net' | 'pair' | 'class' | 'default';
	/** Where the rule came from, in words */
	via: string;
}

export function trackRuleFor(model: CopperModel, net: string): AppliedRule {
	const pick = (name: string | undefined) => (name !== undefined ? model.rules.get(name) : undefined);
	const own = pick(model.netRule.get(net));
	if (own) return { rule: own, source: 'net', via: `net ${net}` };
	const pair = model.netPair.get(net);
	const pairRule = pair !== undefined ? pick(model.pairRule.get(pair)) : undefined;
	if (pairRule) return { rule: pairRule, source: 'pair', via: `differential pair ${pair}` };
	const cls = model.netClass.get(net);
	const clsRule = cls !== undefined ? pick(model.classRule.get(cls)) : undefined;
	if (clsRule) return { rule: clsRule, source: 'class', via: `net class ${cls}` };
	const fallback = [...model.rules.values()].find((r) => r.isDefault);
	const note = cls !== undefined ? ` (net class ${cls} has no track rule)` : '';
	return fallback ? { rule: fallback, source: 'default', via: `board default${note}` } : { via: `none: the board has no default track rule${note}` };
}

export function entryForLayer(rule: TrackRule, layerId: number): TrackRuleEntry {
	return rule.entries.find((e) => e.layerId === layerId) ?? rule.entries.find((e) => e.layerId === 1) ?? rule.entries[0];
}

const mm = (mil: number) => Math.round(mil * MIL_TO_MM * 1000) / 1000;

export interface WidthGroup {
	tracks: number;
	lengthMm: number | null;
	narrowestMm: number;
	widestMm: number;
	layers: number[];
	ids: string[];
	/** Data coordinates (mil) of the first such track */
	at: { x: number; y: number };
}

export interface NetWidthReport {
	net: string;
	status: 'fail' | 'review' | 'unchecked';
	rule: string | null;
	via: string;
	minMm: number | null;
	defaultMm: number | null;
	maxMm: number | null;
	tracks: number;
	copperFills: number;
	belowMin?: WidthGroup;
	aboveMax?: WidthGroup;
	belowDefault?: WidthGroup;
}

export interface TrackWidthReport {
	verdict: 'pass' | 'review' | 'fail' | 'inconclusive';
	summary: string;
	examined: { pcb: string | null; tracks: number; nets: number; rules: string[]; netsByRule: Record<string, number> };
	nets: NetWidthReport[];
	limits: string[];
}

const LIMITS = [
	'Reads the project export EasyEDA writes, not live queries.',
	'Rule order assumed: the net\'s own track rule, then its differential pair\'s, then its net class\'s, then the board default.',
	'Nets on the board default rule are held to its minimum and maximum only: its default width is a routing preference, not a choice made for that net.',
	'Below the default width is not a rule break: a copper fill or pour on the same net may carry the current (copperFills counts the fills), and a short narrow neck into a small pad is normal. Judge each against the current the net carries.',
	'Widths are exact; arc and polyline lengths are approximate. Vias, pads, fills and pours are not checked.',
];

function addTo(groups: Map<string, WidthGroup>, key: string, t: CopperTrack): void {
	const w = mm(t.widthMil);
	const g = groups.get(key);
	if (!g) {
		groups.set(key, { tracks: 1, lengthMm: t.lengthMil === null ? null : t.lengthMil * MIL_TO_MM, narrowestMm: w, widestMm: w, layers: [t.layerId], ids: t.id ? [t.id] : [], at: t.at });
		return;
	}
	g.tracks += 1;
	g.lengthMm = g.lengthMm === null || t.lengthMil === null ? null : g.lengthMm + t.lengthMil * MIL_TO_MM;
	g.narrowestMm = Math.min(g.narrowestMm, w);
	g.widestMm = Math.max(g.widestMm, w);
	if (!g.layers.includes(t.layerId)) g.layers.push(t.layerId);
	if (t.id && g.ids.length < MAX_IDS) g.ids.push(t.id);
}

function finish(g: WidthGroup | undefined): WidthGroup | undefined {
	if (!g) return undefined;
	return { ...g, lengthMm: g.lengthMm === null ? null : Math.round(g.lengthMm * 10) / 10, layers: [...g.layers].sort((a, b) => a - b) };
}

export function checkTrackWidths(model: CopperModel | null): TrackWidthReport {
	if (!model) {
		return {
			verdict: 'inconclusive',
			summary: 'No PCB document matching the target was found in the project export.',
			examined: { pcb: null, tracks: 0, nets: 0, rules: [], netsByRule: {} },
			nets: [],
			limits: LIMITS,
		};
	}
	const byNet = new Map<string, CopperTrack[]>();
	for (const t of model.tracks) {
		const list = byNet.get(t.net) ?? [];
		list.push(t);
		byNet.set(t.net, list);
	}
	const reports: NetWidthReport[] = [];
	const netsByRule: Record<string, number> = {};
	let unchecked = 0;
	for (const [net, tracks] of byNet) {
		const applied = trackRuleFor(model, net);
		const fills = model.copperFills.get(net) ?? 0;
		if (!applied.rule) {
			unchecked += 1;
			reports.push({ net, status: 'unchecked', rule: null, via: applied.via, minMm: null, defaultMm: null, maxMm: null, tracks: tracks.length, copperFills: fills });
			continue;
		}
		const rule = applied.rule;
		netsByRule[rule.name] = (netsByRule[rule.name] ?? 0) + 1;
		const groups = new Map<string, WidthGroup>();
		const checkDefault = applied.source !== 'default';
		for (const t of tracks) {
			const e = entryForLayer(rule, t.layerId);
			if (t.widthMil < e.minMil - EPS_MIL) addTo(groups, 'belowMin', t);
			else if (t.widthMil > e.maxMil + EPS_MIL) addTo(groups, 'aboveMax', t);
			else if (checkDefault && t.widthMil < e.defMil - EPS_MIL) addTo(groups, 'belowDefault', t);
		}
		if (groups.size === 0) continue;
		const head = entryForLayer(rule, 1);
		reports.push({
			net,
			status: groups.has('belowMin') || groups.has('aboveMax') ? 'fail' : 'review',
			rule: rule.name,
			via: applied.via,
			minMm: mm(head.minMil),
			defaultMm: mm(head.defMil),
			maxMm: mm(head.maxMil),
			tracks: tracks.length,
			copperFills: fills,
			belowMin: finish(groups.get('belowMin')),
			aboveMax: finish(groups.get('aboveMax')),
			belowDefault: finish(groups.get('belowDefault')),
		});
	}
	const rank = { fail: 0, unchecked: 1, review: 2 } as const;
	const shortfall = (r: NetWidthReport) => r.belowMin?.tracks ?? r.belowDefault?.lengthMm ?? 0;
	reports.sort((a, b) => rank[a.status] - rank[b.status] || shortfall(b) - shortfall(a) || a.net.localeCompare(b.net));

	const fails = reports.filter((r) => r.status === 'fail');
	const reviews = reports.filter((r) => r.status === 'review');
	const examined = { pcb: model.pcbUuid, tracks: model.tracks.length, nets: byNet.size, rules: [...model.rules.keys()], netsByRule };
	const scope = `${model.tracks.length} copper tracks on ${byNet.size} nets checked against ${model.rules.size} track rules.`;
	if (model.tracks.length === 0) {
		return { verdict: 'inconclusive', summary: `The PCB has no copper tracks with a net. ${scope}`, examined, nets: reports, limits: LIMITS };
	}
	const parts: string[] = [];
	if (fails.length > 0) {
		const n = fails.reduce((s, r) => s + (r.belowMin?.tracks ?? 0) + (r.aboveMax?.tracks ?? 0), 0);
		parts.push(`${fails.length === 1 ? '1 net breaks its' : `${fails.length} nets break their`} track rule (${n} track${n === 1 ? '' : 's'} below the minimum or above the maximum width)`);
	}
	if (reviews.length > 0) parts.push(`${reviews.length} net${reviews.length === 1 ? ' is' : 's are'} narrower than ${reviews.length === 1 ? 'its' : 'their'} own rule's default width in places`);
	if (unchecked > 0) parts.push(`${unchecked} net${unchecked === 1 ? '' : 's'} could not be checked (no track rule applies)`);
	const verdict = fails.length > 0 ? 'fail' : unchecked === byNet.size ? 'inconclusive' : reviews.length > 0 || unchecked > 0 ? 'review' : 'pass';
	const summary = parts.length > 0 ? `${parts.join('; ')}. ${scope}` : `Every track is within its rule's width range. ${scope}`;
	return { verdict, summary, examined, nets: reports, limits: LIMITS };
}
