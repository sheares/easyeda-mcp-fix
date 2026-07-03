import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSchematic, type PinInfo } from '../src/lib/schematic-reader';

const ESCH_FIXTURE = readFileSync(join(__dirname, 'fixtures/sample.esch'), 'utf8');
const ESYM_FIXTURE = readFileSync(join(__dirname, 'fixtures/sample.esym'), 'utf8');
const SYMBOLS = { 'sym-resistor-uuid': ESYM_FIXTURE };

// The resistor symbol places pin "1" at local (-20, 0) angle 0 and pin "2" at
// local (20, 0) angle 180. Component e10 sits at world (1000, 500), rotation 0.
function resistorPins(flip: 0 | 1): Record<string, PinInfo> {
	const source = ESCH_FIXTURE.replace(
		'["COMPONENT","e10","R_0402.1",1000,500,0,0,{},0]',
		`["COMPONENT","e10","R_0402.1",1000,500,0,${flip},{},0]`,
	);
	const model = parseSchematic(source, SYMBOLS);
	const comp = model.components.find((c) => c.elementId === 'e10');
	assert.ok(comp, 'resistor component e10 not found');
	const byNumber: Record<string, PinInfo> = {};
	for (const p of comp.pins) byNumber[p.number] = p;
	return byNumber;
}

test('reader flip=0: pins keep their local sign (unmirrored baseline)', () => {
	const pins = resistorPins(0);
	assert.deepEqual([pins['1'].worldX, pins['1'].worldY], [980, 500]);
	assert.equal(pins['1'].worldAngle, 0);
	assert.deepEqual([pins['2'].worldX, pins['2'].worldY], [1020, 500]);
	assert.equal(pins['2'].worldAngle, 180);
});

test('reader flip=1: pin X mirrors about the component origin (C7)', () => {
	const pins = resistorPins(1);
	// Pin 1 (local x=-20) mirrors to +20 → world 1020; pin 2 (local x=20) → 980.
	assert.deepEqual([pins['1'].worldX, pins['1'].worldY], [1020, 500]);
	assert.deepEqual([pins['2'].worldX, pins['2'].worldY], [980, 500]);
});

test('reader flip=1: pin angles reflect about the Y axis (theta -> 180 - theta)', () => {
	const pins = resistorPins(1);
	assert.equal(pins['1'].worldAngle, 180); // 180 - 0
	assert.equal(pins['2'].worldAngle, 0); //   180 - 180, normalised to [0,360)
});
