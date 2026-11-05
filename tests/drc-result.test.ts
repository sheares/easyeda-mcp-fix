import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDrcResult, summariseDrcEntries } from '../src/extension/handlers/drc-result';

test('a bare boolean keeps the issue #27 note only when detail was asked for', () => {
	const verbose: any = normaliseDrcResult(true);
	assert.equal(verbose.passed, true);
	assert.match(verbose.note, /issue #27/);
	assert.deepEqual(normaliseDrcResult(false, false), { passed: false });
});

test('an empty array passes with no summary (PCB DRC on 3.2.209, clean board)', () => {
	assert.deepEqual(normaliseDrcResult([]), { passed: true, errors: [] });
});

test('the grouped schematic tree is summed by type (3.2.209 live shape)', () => {
	const out: any = normaliseDrcResult([{ type: 'warn', count: 4 }]);
	assert.equal(out.passed, false);
	assert.deepEqual(out.errors, [{ type: 'warn', count: 4 }]);
	assert.deepEqual(out.summary, { entries: 1, total: 4, byType: { warn: 4 } });
	assert.match(out.note, /category with a count/);
});

test('several categories add up, per type', () => {
	const s = summariseDrcEntries([
		{ type: 'error', count: 2 },
		{ type: 'warn', count: 3 },
		{ type: 'warn', count: 1 },
	]);
	assert.deepEqual(s, { entries: 3, total: 6, byType: { error: 2, warn: 4 } });
});

test('flat violation lists count one per entry and get no grouped note', () => {
	const out: any = normaliseDrcResult([{ type: 'Clearance' }, 'Track too thin', { rule: 'x' }]);
	assert.equal(out.passed, false);
	assert.deepEqual(out.summary, { entries: 3, total: 3, byType: { Clearance: 1, unknown: 2 } });
	assert.equal(out.note, undefined);
});

test('bad counts fall back to one; non-array, non-boolean results pass through', () => {
	assert.equal(summariseDrcEntries([{ type: 'warn', count: -1 }, { type: 'warn', count: NaN }]).total, 2);
	const odd = { something: 'else' };
	assert.equal(normaliseDrcResult(odd), odd);
});

// The nested tree PCB DRC returns on EasyEDA 3.2.209 when there are
// violations: category, then kind, then violations. Synthetic, in the shape
// seen live (5 Nov 2026).
function leaf(errorType: string, kind: string, o1: [string, string], o2: [string, string], x: number) {
	return {
		visible: true,
		errorType,
		errorObjType: kind,
		ruleName: 'copperThickness1oz',
		obj1: { typeName: o1[0], suffix: o1[1] },
		obj2: { typeName: o2[0], suffix: o2[1] },
		layer: 'Bottom Layer',
		explanation: { str: '{obj1} to {obj2} distance is {minDistance}, should be {shouldBe}', param: { minDistance: '0mm', shouldBe: '>= 0.254mm', obj1: 'Object 1', obj2: 'object 2' } },
		errData: { position: { x, y: 2 }, padding: 'x'.repeat(1500) },
		pos: { x, y: 2 },
	};
}
function tree(pourCount: number) {
	const pour = Array.from({ length: pourCount }, (_, i) => leaf('Clearance Error', 'Copper Region(Filled) to Track', ['Copper Region(Filled)', '-'], ['Track', `(NET${i}): e${i}`], i));
	return [
		{ name: 'Clearance Error', list: [
			{ name: 'Copper Region(Filled) to Track', list: pour },
			{ name: 'Hole to Hole', list: [leaf('Clearance Error', 'Hole to Hole', ['Hole', '(NET_A): e1'], ['Hole', '(NET_A): e2'], 63.12034)] },
		] },
		{ name: 'Connection Error', list: [{ name: 'GND', list: [{ visible: true, errorType: 'Connection Error', errorObjType: 'SMD Pad', ruleName: 'Common', obj1: { typeName: 'SMD Pad', suffix: '(GND): R9_2' }, obj2: { typeName: '', suffix: '' } }] }] },
	];
}

test('nested PCB tree: flattened to compact violations with real totals', () => {
	const out = normaliseDrcResult(tree(3)) as any;
	assert.equal(out.passed, false);
	assert.equal(out.summary.entries, 2);
	assert.equal(out.summary.total, 5);
	assert.deepEqual(out.summary.byType, { 'Clearance Error': 4, 'Connection Error': 1 });
	assert.equal(out.summary.byKind['Clearance Error › Copper Region(Filled) to Track'], 3);
	assert.equal(out.summary.byKind['Connection Error › SMD Pad'], 1);
	const hole = out.errors.find((e: any) => e.kind === 'Hole to Hole');
	assert.deepEqual(hole.objects, ['Hole (NET_A): e1', 'Hole (NET_A): e2']);
	assert.equal(hole.message, 'Hole (NET_A): e1 to Hole (NET_A): e2 distance is 0mm, should be >= 0.254mm');
	assert.deepEqual(hole.at, { x: 63.12, y: 2 });
	assert.equal(out.errors.find((e: any) => e.category === 'Connection Error').objects[0], 'SMD Pad (GND): R9_2');
	assert.equal(out.note, undefined, 'three pour hits out of five is not called stale pours');
	assert.ok(JSON.stringify(out).length < 3000, 'display padding is dropped');
});

test('nested PCB tree: capped at maxErrors, and stale pours are called out', () => {
	const out = normaliseDrcResult(tree(400), true, 50) as any;
	assert.equal(out.errors.length, 50);
	assert.ok(out.errors.slice(0, 2).some((e: any) => e.kind === 'Hole to Hole'), 'rare kinds are listed before the big group');
	assert.ok(out.errors.slice(0, 2).some((e: any) => e.category === 'Connection Error'));
	assert.deepEqual({ shown: out.truncated.shown, total: out.truncated.total }, { shown: 50, total: 402 });
	assert.match(out.note, /stale pours/);
	assert.equal(out.summary.total, 402);
	assert.ok(JSON.stringify(out).length < 40_000);
	const none = normaliseDrcResult(tree(400), true, 0) as any;
	assert.equal(none.errors.length, 0);
	assert.equal(none.summary.total, 402);
});
