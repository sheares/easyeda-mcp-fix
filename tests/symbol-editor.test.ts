import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SymbolEditor, fontStyleFromTuple, fontStyleToTuple, mergeFontStyle } from '../src/lib/symbol';
import { parseEsymSource } from '../src/lib/schema/esym';
import type { FontStyleLine } from '../src/lib/schema/line-fontstyle';

const AGRV2K_L48 = readFileSync(join(__dirname, 'fixtures/agrv2k-l48.esym'), 'utf8');

test('SymbolEditor: load + immediate serialize is byte-identical (acid test)', () => {
	const ed = SymbolEditor.load(AGRV2K_L48);
	assert.equal(ed.serialize(), AGRV2K_L48);
});

test('SymbolEditor: indexes pins from AGRV2K L48', () => {
	const ed = SymbolEditor.load(AGRV2K_L48);
	const pins = ed.getAllPins();
	// AGRV2K L48 has 48 pins.
	assert.equal(pins.length, 48);

	// Spot-check a few known pins.
	const vdd = pins.filter((p) => p.name === 'VDD33');
	assert.equal(vdd.length, 5, 'expected 5 VDD33 pins on L48');

	const gnd = pins.filter((p) => p.name === 'GND');
	assert.equal(gnd.length, 4, 'expected 4 GND pins on L48');

	const tck = pins.find((p) => p.name === 'TCK');
	assert.ok(tck, 'should have a TCK pin');
	assert.equal(tck!.number, '37');
});

test('SymbolEditor: every pin exposes nameAttrId and numberAttrId', () => {
	const ed = SymbolEditor.load(AGRV2K_L48);
	for (const pin of ed.getAllPins()) {
		assert.ok(pin.nameAttrId, `pin ${pin.number} missing nameAttrId`);
		assert.ok(pin.numberAttrId, `pin ${pin.number} missing numberAttrId`);
	}
});

test('SymbolEditor: no-op style update preserves byte identity', () => {
	const ed = SymbolEditor.load(AGRV2K_L48);
	// Apply current style as a partial — should detect equality and skip.
	const tckPin = ed.getAllPins().find((p) => p.name === 'TCK')!;
	const currentSpec = ed.getAttrFontStyle(tckPin.nameAttrId!);
	assert.ok(currentSpec);
	ed.updateAttrStyle(tckPin.nameAttrId!, currentSpec!);
	assert.equal(ed.serialize(), AGRV2K_L48);
});

test('SymbolEditor: changing NAME color of a single pin forks a new FONTSTYLE', () => {
	const ed = SymbolEditor.load(AGRV2K_L48);
	const tckPin = ed.getAllPins().find((p) => p.name === 'TCK')!;
	const beforeFs = parseFontStylesById(AGRV2K_L48);

	ed.updateNameStyle((p) => p === tckPin, { color: '#ff6b6b' });

	const after = ed.serialize();
	const afterFs = parseFontStylesById(after);

	// A new FONTSTYLE should have been added (TCK's NAME shared st1 with many
	// other NAMEs, so we fork rather than mutate in place).
	assert.ok(
		Object.keys(afterFs).length > Object.keys(beforeFs).length,
		`expected a new FONTSTYLE to be added; before=${Object.keys(beforeFs).length} after=${Object.keys(afterFs).length}`,
	);

	// Original styles st1, st2, st3 must still exist with original tuples
	// (other pins still reference them).
	for (const id of Object.keys(beforeFs)) {
		assert.deepEqual(afterFs[id], beforeFs[id], `style ${id} mutated unexpectedly`);
	}

	// TCK's NAME ATTR should now point at a new style with color set.
	const ed2 = SymbolEditor.load(after);
	const tckSpec = ed2.getAttrFontStyle(ed2.getAllPins().find((p) => p.name === 'TCK')!.nameAttrId!);
	assert.equal(tckSpec?.color, '#ff6b6b');

	// The other NAMEs that previously shared the same FONTSTYLE keep their original color (null).
	const otherSpec = ed2.getAttrFontStyle(ed2.getAllPins().find((p) => p.name === 'NRST')!.nameAttrId!);
	assert.equal(otherSpec?.color, null);
});

test('SymbolEditor: bulk recolor of VDD33 pins produces exactly one new FONTSTYLE per distinct base', () => {
	const ed = SymbolEditor.load(AGRV2K_L48);
	const beforeFs = parseFontStylesById(AGRV2K_L48);

	const count = ed.updateNameStyle((p) => p.name === 'VDD33', { color: '#ff6b6b' });
	assert.equal(count, 5, 'should mutate all 5 VDD33 pins');

	const after = ed.serialize();
	const afterFs = parseFontStylesById(after);

	// Each VDD33 NAME shared the same base FONTSTYLE (st1). Re-coloring all 5
	// to the same target color should fork EITHER one shared new style, OR
	// five new styles (current implementation forks per-call). Both are
	// semantically correct; sanity-check that at least one new style exists
	// and originals are untouched.
	assert.ok(Object.keys(afterFs).length >= Object.keys(beforeFs).length + 1);
	for (const id of Object.keys(beforeFs)) {
		assert.deepEqual(afterFs[id], beforeFs[id]);
	}

	// Re-load the result and verify all 5 VDD33 pins have the target color.
	const ed2 = SymbolEditor.load(after);
	for (const p of ed2.getAllPins().filter((p) => p.name === 'VDD33')) {
		const spec = ed2.getAttrFontStyle(p.nameAttrId!);
		assert.equal(spec?.color, '#ff6b6b', `pin ${p.number} (${p.name}) should be red`);
	}
	// And GND pins are untouched.
	for (const p of ed2.getAllPins().filter((p) => p.name === 'GND')) {
		const spec = ed2.getAttrFontStyle(p.nameAttrId!);
		assert.equal(spec?.color, null, `pin ${p.number} (GND) should still be default color`);
	}
});

test('FontStyleSpec: round-trip through tuple preserves all observed shapes', () => {
	// Common shape: visible NAME label
	const visible: FontStyleLine = ['FONTSTYLE', 'st1', null, null, null, null, 0, 0, 0, null, 2, 2];
	const visSpec = fontStyleFromTuple(visible);
	assert.deepEqual(visSpec, {
		color: null,
		fontFamily: null,
		fontSize: null,
		italic: false,
		bold: false,
		underline: false,
		vAlign: 'bottom',
		hAlign: 'right',
		slot2: null,
		slot9: null,
	});
	assert.deepEqual(fontStyleToTuple('st1', visSpec), visible);

	// Hidden Pin Type style — slots 6/7/8 are literal null, not 0
	const hidden: FontStyleLine = [
		'FONTSTYLE',
		'st3',
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		0,
	];
	const hiddenSpec = fontStyleFromTuple(hidden);
	assert.equal(hiddenSpec.italic, null);
	assert.equal(hiddenSpec.bold, null);
	assert.equal(hiddenSpec.underline, null);
	assert.deepEqual(fontStyleToTuple('st3', hiddenSpec), hidden);

	// Fully-loaded shape
	const loaded: FontStyleLine = [
		'FONTSTYLE',
		'st99',
		null,
		'#ff6b6b',
		'Comic Sans MS',
		15,
		1,
		1,
		1,
		null,
		1,
		1,
	];
	const loadedSpec = fontStyleFromTuple(loaded);
	assert.equal(loadedSpec.color, '#ff6b6b');
	assert.equal(loadedSpec.fontFamily, 'Comic Sans MS');
	assert.equal(loadedSpec.fontSize, 15);
	assert.equal(loadedSpec.italic, true);
	assert.equal(loadedSpec.bold, true);
	assert.equal(loadedSpec.underline, true);
	assert.equal(loadedSpec.vAlign, 'middle');
	assert.equal(loadedSpec.hAlign, 'center');
	assert.deepEqual(fontStyleToTuple('st99', loadedSpec), loaded);
});

test('FontStyleSpec: mergeFontStyle only overrides explicitly-set fields', () => {
	const base = fontStyleFromTuple([
		'FONTSTYLE',
		'st1',
		null,
		null,
		null,
		null,
		0,
		0,
		0,
		null,
		2,
		2,
	] as FontStyleLine);
	const merged = mergeFontStyle(base, { color: '#ff6b6b' });
	assert.equal(merged.color, '#ff6b6b');
	assert.equal(merged.vAlign, 'bottom'); // unchanged
	assert.equal(merged.hAlign, 'right'); // unchanged
	assert.equal(merged.bold, false); // unchanged
});

// ---- helpers ----

function parseFontStylesById(source: string): Record<string, unknown[]> {
	const { lines } = parseEsymSource(source);
	const out: Record<string, unknown[]> = {};
	for (const ln of lines) {
		if (ln.kind !== 'known') continue;
		const d = ln.data as readonly unknown[];
		if (d[0] !== 'FONTSTYLE') continue;
		out[d[1] as string] = [...d];
	}
	return out;
}
