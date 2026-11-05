import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTrackWidths, parsePcbCopper, polyLength, trackRuleFor } from '../src/bridge-daemon/track-widths';

// ---- a tiny .epru builder (synthetic boards only) ---------------------------------------
type Rec = [Record<string, unknown>, Record<string, unknown> | null];
const line = ([h, b]: Rec) => `${JSON.stringify(h)}||${b === null ? '' : JSON.stringify(b)}|`;
const doc = (docType: string, uuid: string, recs: Rec[]) => [line([{ type: 'DOCHEAD' }, { docType, uuid }]), ...recs.map(line)];

const rule = (name: string, state: 'DEFAULT' | 'NORMAL', content: Array<[number, number, number, number]>): Rec => [
	{ type: 'RULE', id: JSON.stringify(['RULE', 'TRACK', name]) },
	{ ruleState: state, ruleContext: { unit: 'mm', track: { isOpen: true, content: content.map(([layerId, stroMin, stroDef, stroMax]) => ({ layerId, stroMin, stroDef, stroMax })) } } },
];
const selector = (scope: string, name: string, track?: string): Rec => [
	{ type: 'RULE_SELECTOR', id: JSON.stringify(['RULE_SELECTOR', [scope, name]]) },
	{ ruleOrder: 4, ruleKeyValue: track ? { TRACK: track } : {} },
];
const net = (name: string, netType: string | null = null, differentialName: string | null = null): Rec => [
	{ type: 'NET', id: JSON.stringify(['NET', name]) },
	{ netType, differentialName },
];
let n = 0;
const track = (netName: string, width: number, layerId = 1, opts: { id?: string; ticket?: number; len?: number } = {}): Rec => [
	{ type: 'LINE', id: opts.id ?? `t${++n}`, ticket: opts.ticket ?? 1 },
	{ netName, layerId, startX: 0, startY: 0, endX: opts.len ?? 100, endY: 0, width },
];

/** Widths in mil, as inside a real PCB document. */
function board(extra: Rec[] = []): string {
	return [
		...doc('SCH', 'sch1', [rule('default', 'DEFAULT', [[1, 0.1, 0.254, 2.54]])]), // a schematic's mm-valued copy: must be ignored
		...doc('PCB', 'pcbA', [
			rule('default', 'DEFAULT', [[1, 4, 10, 100]]),
			rule('power', 'NORMAL', [[1, 10, 40, 100], [2, 12, 40, 100]]),
			rule('pair', 'NORMAL', [[1, 5, 6, 8]]),
			rule('own', 'NORMAL', [[1, 20, 20, 30]]),
			selector('NET_CLASS', 'POWER', 'power'),
			selector('NET_CLASS', 'SENSE'),
			selector('DIFF_PAIR', 'PAIR1', 'pair'),
			selector('NET', 'OWN', 'own'),
			net('VIN', 'POWER'),
			net('SIG'),
			net('FB', 'SENSE'),
			net('DP', null, 'PAIR1'),
			net('OWN', 'POWER'),
			...extra,
		]),
	].join('\n');
}

test('rule order: own net rule, then differential pair, then net class, then the board default', () => {
	const m = parsePcbCopper(board(), 'pcbA')!;
	assert.equal(trackRuleFor(m, 'OWN').rule?.name, 'own', 'a net rule beats the net class');
	assert.equal(trackRuleFor(m, 'DP').via, 'differential pair PAIR1');
	assert.equal(trackRuleFor(m, 'VIN').via, 'net class POWER');
	assert.equal(trackRuleFor(m, 'SIG').via, 'board default');
	assert.equal(trackRuleFor(m, 'FB').via, 'board default (net class SENSE has no track rule)');
	assert.deepEqual(m.rules.get('default')!.entries[0], { layerId: 1, minMil: 4, defMil: 10, maxMil: 100 }, 'the PCB\'s own mil values, not the schematic\'s copy');
});

test('below minimum fails, below a class default asks for review, the board default is held to min and max only', () => {
	const r = checkTrackWidths(parsePcbCopper(board([
		track('VIN', 8), // below the class minimum (10)
		track('VIN', 20), // inside the range, below the class default (40)
		track('VIN', 40),
		track('SIG', 6), // below the board default's default (10): no finding
		track('SIG', 3), // below the board default's minimum (4)
		track('FB', 6), // board default via a class with no track rule: fine
		[{ type: 'FILL', id: 'f1' }, { netName: 'VIN', layerId: 1, path: [] }],
		[{ type: 'LINE', id: 'silk' }, { netName: 'VIN', layerId: 3, startX: 0, startY: 0, endX: 9, endY: 0, width: 1 }], // not copper
	]), 'pcbA'));
	assert.equal(r.verdict, 'fail');
	assert.equal(r.examined.tracks, 6);
	assert.deepEqual(r.nets.map((x) => [x.net, x.status]), [['SIG', 'fail'], ['VIN', 'fail']]);
	const vin = r.nets.find((x) => x.net === 'VIN')!;
	assert.equal(vin.belowMin!.tracks, 1);
	assert.equal(vin.belowMin!.narrowestMm, 0.203);
	assert.equal(vin.belowDefault!.tracks, 1);
	assert.equal(vin.copperFills, 1);
	assert.equal(vin.minMm, 0.254);
	assert.equal(vin.defaultMm, 1.016);
	const sig = r.nets.find((x) => x.net === 'SIG')!;
	assert.equal(sig.belowDefault, undefined, 'the board default\'s default width is not enforced');
	assert.match(r.summary, /^2 nets break their track rule \(2 tracks/);
});

test('per-layer limits, above-maximum, and the latest ticket of a record', () => {
	const r = checkTrackWidths(parsePcbCopper(board([
		track('VIN', 11, 1), // fine on top (min 10)
		track('VIN', 11, 2), // below the bottom-layer minimum (12)
		track('DP', 9), // above the pair rule's maximum (8)
		track('OWN', 10, 1, { id: 'dup', ticket: 1 }),
		track('OWN', 20, 1, { id: 'dup', ticket: 2 }), // supersedes the narrow one
	]), 'pcbA'));
	const vin = r.nets.find((x) => x.net === 'VIN')!;
	assert.deepEqual(vin.belowMin!.layers, [2]);
	assert.equal(r.nets.find((x) => x.net === 'DP')!.aboveMax!.tracks, 1);
	assert.equal(r.nets.find((x) => x.net === 'OWN'), undefined);
	assert.equal(r.examined.tracks, 4);
});

test('review only, pass, and which PCB is read', () => {
	const review = checkTrackWidths(parsePcbCopper(board([track('VIN', 20), track('SIG', 6)]), 'pcbA'));
	assert.equal(review.verdict, 'review');
	assert.match(review.summary, /^1 net is narrower than its own rule's default width/);
	assert.equal(checkTrackWidths(parsePcbCopper(board([track('VIN', 40), track('SIG', 5)]), 'pcbA')).verdict, 'pass');
	assert.equal(parsePcbCopper(board(), 'other')!.pcbUuid, 'pcbA', 'a single PCB is read whatever uuid is asked for');
	const two = board() + '\n' + doc('PCB', 'pcbB', [rule('default', 'DEFAULT', [[1, 4, 10, 100]]), track('X', 5)]).join('\n');
	assert.equal(parsePcbCopper(two, 'pcbB')!.tracks[0].net, 'X');
	assert.equal(parsePcbCopper(two, 'nope'), null);
	assert.equal(checkTrackWidths(null).verdict, 'inconclusive');
	assert.equal(checkTrackWidths(parsePcbCopper(board(), 'pcbA')).verdict, 'inconclusive', 'no tracks is not a pass');
});

test('polyline tracks: length from the path, arcs included', () => {
	assert.equal(polyLength([0, 0, 'L', 100, 0, 100, 100]).length, 200);
	assert.ok(Math.abs(polyLength([0, 0, 'ARC', 180, 100, 0]).length! - Math.PI * 50) < 1e-9);
	assert.equal(polyLength([0, 0, 'R', 1, 2]).length, null, 'an unknown shape gives no length, not a wrong one');
	const r = checkTrackWidths(parsePcbCopper(board([[{ type: 'POLY', id: 'p1' }, { netName: 'VIN', layerId: 1, width: 20, path: [0, 0, 'L', 100, 0, 100, 100] }]]), 'pcbA'));
	assert.equal(r.nets[0].belowDefault!.lengthMm, 5.1);
	assert.deepEqual(r.nets[0].belowDefault!.at, { x: 0, y: 0 });
});
