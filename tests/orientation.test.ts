import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpru, markCentre } from '../src/bridge-daemon/orientation/epru';
import { decodeText, lengthToMm, parseFlyingProbe, parsePickAndPlace, type PlacementRow, type ProbeFile } from '../src/bridge-daemon/orientation/fab';
import { checkOrientation, isGroundNet, isSupplyNet, judgeMark } from '../src/bridge-daemon/orientation/check';

// ---- a tiny .epru builder ------------------------------------------------------------------
type Rec = [Record<string, unknown>, Record<string, unknown> | null];
const line = ([h, b]: Rec) => `${JSON.stringify(h)}||${b === null ? '' : JSON.stringify(b)}|`;
const doc = (docType: string, uuid: string, recs: Rec[]) => [line([{ type: 'DOCHEAD' }, { docType, uuid }]), ...recs.map(line)];

function footprint(uuid: string, title: string, pads: Array<[string, number, number]>, mark?: [number, number]): string[] {
	const recs: Rec[] = pads.map(([num, x, y], i) => [{ type: 'PAD', id: `p${i}` }, { num, centerX: x, centerY: y, layerId: 1 }]);
	if (mark) recs.push([{ type: 'FILL', id: 'm' }, { layerId: 49, path: [['CIRCLE', mark[0], mark[1], 2]] }]);
	recs.push([{ type: 'ATTR', id: 'a' }, { key: 'Footprint', value: title }]);
	return doc('FOOTPRINT', uuid, recs);
}

/** Pins as [id, number, name]; ids deliberately repeat across symbols, as in real exports. */
function symbol(uuid: string, pins: Array<[string, string, string]>): string[] {
	const recs: Rec[] = [];
	for (const [id, num, name] of pins) {
		recs.push([{ type: 'PIN', id }, { x: 0, y: 0 }]);
		recs.push([{ type: 'ATTR', id: `${id}n` }, { parentId: id, key: 'Pin Name', value: name }]);
		recs.push([{ type: 'ATTR', id: `${id}u` }, { parentId: id, key: 'Pin Number', value: num }]);
	}
	return doc('SYMBOL', uuid, recs);
}

const device = (uuid: string, attrs: Record<string, string>, title = 'part', tags: string[] = []) =>
	doc('DEVICE', uuid, [[{ type: 'META' }, { title, tags, attributes: attrs }]]);

function pcb(uuid: string, parts: Array<{ id: string; des: string; fp: string; dev: string; x?: number; y?: number; layer?: number }>): string[] {
	const recs: Rec[] = [];
	for (const p of parts) {
		recs.push([{ type: 'COMPONENT', id: p.id }, { layerId: p.layer ?? 1, x: p.x ?? 0, y: p.y ?? 0, angle: 0 }]);
		recs.push([{ type: 'ATTR', id: `${p.id}d` }, { parentId: p.id, key: 'Designator', value: p.des }]);
		recs.push([{ type: 'ATTR', id: `${p.id}f` }, { parentId: p.id, key: 'Footprint', value: p.fp }]);
		recs.push([{ type: 'ATTR', id: `${p.id}v` }, { parentId: p.id, key: 'Device', value: p.dev }]);
	}
	return doc('PCB', uuid, recs);
}

// A board: LED D1 (symbol K = pin 1), a QFN-ish chip U1 whose corner mark sits nearer pad 2 than pad 1
// (as on some real QFN footprints), and a resistor.
function board(opts: { ledMark?: [number, number]; chipMark?: [number, number] } = {}) {
	const text = [
		...footprint('fpLED', 'LED0603', [['1', -30, 0], ['2', 30, 0]], opts.ledMark ?? [-50, 0]),
		...footprint('fpQFN', 'VQFN', [['1', -86, -29.5], ['2', -68.8, -68], ['3', -49, -68], ['4', 86, 29.5], ['5', 68.8, 68], ['6', 49, 68], ['7', 0, 0]], opts.chipMark ?? [-90, -69]),
		...footprint('fpR', 'R0402', [['1', -20, 0], ['2', 20, 0]], [-30, 0]),
		// Both symbols use pin ids e0/e1: names must not bleed between them.
		...symbol('symLED', [['e0', '1', 'K'], ['e1', '2', 'A']]),
		...symbol('symU', [['e0', '1', 'VCC'], ['e1', '2', 'EN'], ['e2', '3', 'GND'], ['e3', '4', 'SW'], ['e4', '5', 'FB'], ['e5', '6', 'VOUT'], ['e6', '7', 'GND']]),
		...symbol('symR', [['e0', '1', '1'], ['e1', '2', '2']]),
		...device('devLED', { Symbol: 'symLED', 'Supplier Part': 'C2290', 'Manufacturer Part': 'KT-0603R' }, 'KT-0603R', ['Light Emitting Diodes (LED)']),
		...device('devU', { Symbol: 'symU', 'Supplier Part': 'C900002', 'Manufacturer Part': 'BOOST-DEMO' }),
		...device('devR', { Symbol: 'symR', 'Supplier Part': 'C25744' }),
		...pcb('pcb1', [
			{ id: 'c1', des: 'D1', fp: 'fpLED', dev: 'devLED', x: 100, y: 100 },
			{ id: 'c2', des: 'U1', fp: 'fpQFN', dev: 'devU', x: 500, y: 500 },
			{ id: 'c3', des: 'R1', fp: 'fpR', dev: 'devR' },
		]),
	];
	return parseEpru(text.join('\n'));
}

function probeFor(nets: Record<string, string>, pads: Record<string, [number, number]>): ProbeFile {
	return {
		pads: Object.entries(pads).map(([k, [x, y]]) => {
			const [designator, pad] = k.split('.');
			return { designator, pad, net: nets[k] ?? '', groundType: (nets[k] ?? '') === 'GND', xMm: x, yMm: y };
		}),
		duplicatePadRows: 0,
		unmatchedRows: [],
	};
}

const PAD_POS: Record<string, [number, number]> = { 'D1.1': [1, 1], 'D1.2': [2, 1], 'U1.1': [10, 10], 'U1.2': [11, 9], 'U1.3': [12, 9], 'U1.4': [13, 11], 'U1.5': [12, 12], 'U1.6': [11, 12], 'U1.7': [11, 11] };
const GOOD_NETS = { 'D1.1': 'GND', 'D1.2': 'LED_A', 'U1.1': '+5V', 'U1.2': 'EN', 'U1.3': 'GND', 'U1.4': 'SW', 'U1.5': 'FB', 'U1.6': 'VOUT', 'U1.7': 'GND' };
const GOOD_PLACE: PlacementRow[] = [{ designator: 'D1', padXMm: 1, padYMm: 1 }, { designator: 'U1', padXMm: 10, padYMm: 10 }];
const allSheets = () => '/tmp/datasheets/x.pdf';

function run(model = board(), nets: Record<string, string> = GOOD_NETS, placement = GOOD_PLACE, datasheetFor: ((l?: string) => string | null) | undefined = allSheets) {
	return checkOrientation({ model, pcbUuid: 'pcb1', probe: probeFor(nets, PAD_POS), placement, datasheetFor });
}
const errors = (r: ReturnType<typeof run>, des: string) => r.findings.filter((f) => f.designator === des && f.severity === 'error').map((f) => f.check);

test('a correct board passes, and the resistor is skipped, not silently passed', () => {
	const r = run();
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings, null, 1));
	assert.deepEqual(r.parts.map((p) => [p.designator, p.kind, p.status]), [['D1', 'led', 'ok'], ['U1', 'chip', 'ok']]);
	assert.equal(r.examined.skippedNonPolarised, 1);
	assert.deepEqual(r.parts[0].cathode, { pad: '1', net: 'GND' });
});

test('pin names stay with their own symbol even when pin ids repeat', () => {
	const m = board();
	const names = (uuid: string) => m.symbols.get(uuid)!.pins.map((p) => `${p.number}=${p.name}`);
	assert.deepEqual(names('symLED'), ['1=K', '2=A']);
	assert.deepEqual(names('symR'), ['1=1', '2=2']);
});

test('an LED footprint marked on the anode fails', () => {
	const r = run(board({ ledMark: [50, 0] }));
	assert.equal(r.verdict, 'fail');
	assert.deepEqual(errors(r, 'D1'), ['mark']);
});

test('a QFN corner mark nearer pad 2 still counts as pin 1; the opposite corner fails', () => {
	assert.equal(errors(run(), 'U1').length, 0);
	const turned = run(board({ chipMark: [90, 69] }));
	assert.deepEqual(errors(turned, 'U1'), ['mark']);
	assert.match(turned.findings.find((f) => f.designator === 'U1' && f.check === 'mark')!.message, /turned 180 degrees/);
});

test('judgeMark: a mark on the centre line of a symmetric part is ambiguous', () => {
	const fp = board().footprints.get('fpLED')!;
	const v = judgeMark(fp, { x: 0, y: 40 }, fp.pads[0]);
	assert.equal(v.ambiguous, true);
});

test('pick-and-place pin 1 off pad 1 fails (the fab would place it rotated)', () => {
	const r = run(undefined, undefined, [{ designator: 'D1', padXMm: 2, padYMm: 1 }, GOOD_PLACE[1]]);
	assert.deepEqual(errors(r, 'D1'), ['pin1']);
	assert.equal(r.parts.find((p) => p.designator === 'D1')!.pin1OffsetMm, 1);
});

test('an LED wired backwards fails on its nets', () => {
	const r = run(undefined, { ...GOOD_NETS, 'D1.1': '+3V3', 'D1.2': 'GND' });
	assert.deepEqual(errors(r, 'D1').sort(), ['polarity', 'polarity']);
});

test('a chip GND pin on a supply, or a VCC pin on ground, fails', () => {
	const r = run(undefined, { ...GOOD_NETS, 'U1.3': '+5V', 'U1.1': 'GND' });
	assert.deepEqual(errors(r, 'U1').sort(), ['power-pin', 'power-pin']);
});

test('no stashed datasheet means review, never pass', () => {
	const r = run(undefined, undefined, undefined, () => null);
	assert.equal(r.verdict, 'review');
	assert.ok(r.parts.every((p) => p.status === 'review'));
	assert.ok(r.findings.some((f) => f.check === 'datasheet' && /project_fetch_datasheets/.test(f.message)));
});

test('a footprint with no mark is flagged for review, and missing symbol names make the part inconclusive', () => {
	const noMark = parseEpru([...footprint('fpLED', 'LED0603', [['1', -30, 0], ['2', 30, 0]]), ...symbol('s', [['e0', '1', 'K'], ['e1', '2', 'A']]),
		...device('d', { Symbol: 's', 'Supplier Part': 'C1' }), ...pcb('pcb1', [{ id: 'c', des: 'D1', fp: 'fpLED', dev: 'd' }])].join('\n'));
	const r1 = checkOrientation({ model: noMark, pcbUuid: 'pcb1', probe: probeFor(GOOD_NETS, PAD_POS), placement: GOOD_PLACE, datasheetFor: allSheets });
	assert.equal(r1.parts[0].status, 'review');
	assert.ok(r1.findings.some((f) => f.check === 'mark' && /no component-marking/.test(f.message)));

	const noNames = parseEpru([...footprint('fpLED', 'LED0603', [['1', -30, 0], ['2', 30, 0]], [-50, 0]),
		...device('d', { 'Supplier Part': 'C1' }), ...pcb('pcb1', [{ id: 'c', des: 'D1', fp: 'fpLED', dev: 'd' }])].join('\n'));
	const r2 = checkOrientation({ model: noNames, pcbUuid: 'pcb1', probe: probeFor(GOOD_NETS, PAD_POS), placement: GOOD_PLACE, datasheetFor: allSheets });
	assert.equal(r2.parts[0].status, 'inconclusive');
	assert.equal(r2.verdict, 'inconclusive');
});

test('a board with nothing to check is inconclusive, not a pass', () => {
	const empty = parseEpru(pcb('pcb1', []).join('\n'));
	assert.equal(checkOrientation({ model: empty, pcbUuid: 'pcb1', probe: probeFor({}, {}), placement: [] }).verdict, 'inconclusive');
});

test('fab readers: longest designator wins, PADn duplicates are counted, units convert', () => {
	const probe = parseFlyingProbe({
		lengthUnit: 'mil',
		pins: { fields: ['PIN_NAME', 'PIN_X', 'PIN_Y', 'NET_NAME', 'NET_TYPE'], rows: [['U1_A_3', 100, 200, 'GND', 'GND'], ['U1_2', 0, 0, 'X', ''], ['PAD7_1', 0, 0, 'X', ''], ['Q9_1', 0, 0, 'Y', '']] },
	}, ['U1', 'U1_A']);
	assert.deepEqual(probe.pads.map((p) => `${p.designator}|${p.pad}`), ['U1_A|3', 'U1|2']);
	assert.equal(probe.pads[0].xMm, 2.54);
	assert.equal(probe.pads[0].groundType, true);
	assert.equal(probe.duplicatePadRows, 1);
	assert.deepEqual(probe.unmatchedRows, ['Q9_1']);

	const csv = 'Designator\tPad X\tPad Y\tLayer\n"D1"\t"15.25mm"\t"600mil"\t"B"\n';
	const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, 'utf16le')]);
	const rows = parsePickAndPlace(decodeText(utf16));
	assert.equal(rows[0].designator, 'D1');
	assert.equal(rows[0].padXMm, 15.25);
	assert.ok(Math.abs(rows[0].padYMm - 15.24) < 1e-9);
	assert.equal(lengthToMm('nonsense'), null);
});

test('mark shapes: circles and polygons are located, rectangles are not guessed', () => {
	assert.deepEqual(markCentre(['CIRCLE', 3, 4, 1]), { x: 3, y: 4 });
	assert.deepEqual(markCentre([0, 0, 'L', 2, 0, 2, 2, 0, 2]), { x: 1, y: 1 });
	assert.equal(markCentre(['R', 0, 0, 10, 10, 0, 0]), null);
});

test('net-name heuristics', () => {
	for (const n of ['GND', 'AGND', 'PGND', 'VSS', 'MOTOR_GND']) assert.ok(isGroundNet(n), n);
	for (const n of ['+5V', '3V3', 'VBUS', 'VCC_IO', '12V', 'VBAT']) assert.ok(isSupplyNet(n), n);
	for (const n of ['LED_A', 'SDA', 'NET_4', 'VOUT']) assert.ok(!isSupplyNet(n) && !isGroundNet(n), n);
});
